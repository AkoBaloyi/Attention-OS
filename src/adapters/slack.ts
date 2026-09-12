/**
 * Slack adapter.
 *
 * Same split as Discord: a pure normaliser plus a thin transport. The two
 * normalisers exist to produce output that is indistinguishable downstream, and
 * a test asserts exactly that.
 *
 * Socket Mode is used rather than the Events API. The Events API needs a public
 * HTTPS endpoint, which in practice means a tunnel, which means debugging a
 * tunnel. Socket Mode opens an outbound WebSocket and needs no public URL at all.
 */

import type { CanonicalMessage } from '../contracts/message.ts';
import type { IdentityDirectory } from './identity.ts';

/** The shape we need from Slack, structurally. No SDK types here. */
export type SlackRawMessage = {
  /** Slack's message timestamp, e.g. "1789012345.000100". Unique per channel. */
  ts: string;
  channel: string;
  channelName: string;
  user: string;
  userName?: string;
  text: string;
  threadTs?: string | null;
  /** Present when a bot authored the message. */
  botId?: string | null;
  /** Set for edits, joins, and other non-message events we ignore. */
  subtype?: string | null;
};

export type SlackAdapterConfig = {
  identity: IdentityDirectory;
  /** The instance owner's Slack user id. */
  ownerUserId: string;
  /** The agent's own bot user id, so it never perceives its own output. */
  selfUserId?: string;
};

export function normaliseSlackMessage(
  raw: SlackRawMessage,
  config: SlackAdapterConfig,
): CanonicalMessage | null {
  // Joins, leaves, edits and file comments are not conversation.
  if (raw.subtype) return null;
  if (raw.user === config.ownerUserId) return null;
  if (config.selfUserId && raw.user === config.selfUserId) return null;
  if (!raw.text || raw.text.trim().length === 0) return null;

  const identity = config.identity.resolve('slack', raw.user, raw.userName);

  return {
    // ts alone is only unique per channel, so the channel has to be in the key.
    id: `slack:${raw.channel}:${raw.ts}`,
    platform: 'slack',
    channelId: raw.channel,
    channelName: raw.channelName,
    personId: identity.personId,
    relationshipTier: identity.relationshipTier,
    text: raw.text.trim(),
    timestamp: slackTsToIso(raw.ts),
    threadId: raw.threadTs ?? null,
    // Slack encodes mentions inline as <@U123>, not as a separate array.
    mentionsUser: raw.text.includes(`<@${config.ownerUserId}>`),
  };
}

/** Slack timestamps are epoch seconds with a fractional part. */
export function slackTsToIso(ts: string): string {
  const seconds = Number.parseFloat(ts);
  if (Number.isNaN(seconds)) {
    throw new Error(`unparseable slack ts: ${ts}`);
  }
  return new Date(Math.round(seconds * 1000)).toISOString();
}

/**
 * Live Socket Mode connection.
 *
 * Scopes required: channels:history, groups:history, users:read. The bot must
 * also be invited to each channel it is expected to read.
 */
export async function startSlackAdapter(options: {
  botToken: string;
  appToken: string;
  config: SlackAdapterConfig;
  onMessage: (message: CanonicalMessage) => void | Promise<void>;
  onError?: (error: unknown) => void;
}): Promise<{ stop: () => Promise<void> }> {
  const { App } = await import('@slack/bolt');

  const app = new App({
    token: options.botToken,
    appToken: options.appToken,
    socketMode: true,
  });

  // Channel names are not on the message event, so resolve and cache them.
  const channelNames = new Map<string, string>();
  const resolveChannelName = async (channelId: string): Promise<string> => {
    const cached = channelNames.get(channelId);
    if (cached) return cached;
    try {
      const info = await app.client.conversations.info({ channel: channelId });
      const name = info.channel?.name ?? channelId;
      channelNames.set(channelId, name);
      return name;
    } catch {
      return channelId;
    }
  };

  app.message(async ({ message }) => {
    try {
      // Bolt's message union does not narrow usefully across subtypes, and the
      // normaliser validates every field anyway, so read it structurally.
      const m = message as unknown as Record<string, unknown>;
      const channel = String(m.channel ?? '');

      const normalised = normaliseSlackMessage(
        {
          ts: String(m.ts ?? ''),
          channel,
          channelName: await resolveChannelName(channel),
          user: String(m.user ?? ''),
          text: typeof m.text === 'string' ? m.text : '',
          threadTs: typeof m.thread_ts === 'string' ? m.thread_ts : null,
          botId: typeof m.bot_id === 'string' ? m.bot_id : null,
          subtype: typeof m.subtype === 'string' ? m.subtype : null,
        },
        options.config,
      );

      if (normalised) await options.onMessage(normalised);
    } catch (error) {
      options.onError?.(error);
    }
  });

  app.error(async (error) => {
    options.onError?.(error);
  });

  await app.start();

  return {
    stop: async () => {
      await app.stop();
    },
  };
}
