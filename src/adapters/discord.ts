/**
 * Discord adapter.
 *
 * Split deliberately in two. `normaliseDiscordMessage` is pure and knows nothing
 * about discord.js, so the mapping that everything downstream depends on is
 * testable without a gateway connection, a bot token, or a network. The
 * transport underneath is thin on purpose: if it were doing anything clever, it
 * would be doing something untestable.
 */

import type { CanonicalMessage } from '../contracts/message.ts';
import type { IdentityDirectory } from './identity.ts';

/** The shape we need from Discord, structurally. No SDK types here. */
export type DiscordRawMessage = {
  id: string;
  channelId: string;
  channelName: string;
  authorId: string;
  authorUsername: string;
  content: string;
  createdAt: Date | string;
  threadId?: string | null;
  mentionedUserIds?: readonly string[];
};

export type DiscordAdapterConfig = {
  identity: IdentityDirectory;
  /** The instance owner's Discord user id. Used for mention detection and to
   * ignore the owner's own messages. */
  ownerUserId: string;
  /** The agent's own bot user id, so it never perceives its own output. */
  selfUserId?: string;
};

export function normaliseDiscordMessage(
  raw: DiscordRawMessage,
  config: DiscordAdapterConfig,
): CanonicalMessage | null {
  // Never process the owner's own messages: an agent that reacts to you talking
  // to yourself will interrupt you about your own plans.
  if (raw.authorId === config.ownerUserId) return null;
  // Never process our own output, or the system feeds on itself.
  if (config.selfUserId && raw.authorId === config.selfUserId) return null;
  if (raw.content.trim().length === 0) return null;

  const identity = config.identity.resolve('discord', raw.authorId, raw.authorUsername);

  return {
    id: `discord:${raw.id}`,
    platform: 'discord',
    channelId: raw.channelId,
    channelName: raw.channelName,
    personId: identity.personId,
    relationshipTier: identity.relationshipTier,
    text: raw.content.trim(),
    timestamp: toIso(raw.createdAt),
    threadId: raw.threadId ?? null,
    mentionsUser: (raw.mentionedUserIds ?? []).includes(config.ownerUserId),
  };
}

function toIso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString();
}

/**
 * Live gateway connection. Requires the MESSAGE CONTENT privileged intent to be
 * enabled on the bot, without which `content` arrives empty and every message
 * normalises to null.
 */
export async function startDiscordAdapter(options: {
  token: string;
  channelIds: readonly string[];
  config: DiscordAdapterConfig;
  onMessage: (message: CanonicalMessage) => void | Promise<void>;
  onError?: (error: unknown) => void;
}): Promise<{ stop: () => Promise<void> }> {
  const { Client, GatewayIntentBits, Events } = await import('discord.js');

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  const watched = new Set(options.channelIds);

  client.on(Events.MessageCreate, (message) => {
    void (async () => {
      try {
        if (watched.size > 0 && !watched.has(message.channelId)) return;

        const normalised = normaliseDiscordMessage(
          {
            id: message.id,
            channelId: message.channelId,
            channelName: 'name' in message.channel ? (message.channel.name ?? 'unknown') : 'dm',
            authorId: message.author.id,
            authorUsername: message.author.username,
            content: message.content,
            createdAt: message.createdAt,
            threadId: message.channel.isThread() ? message.channelId : null,
            mentionedUserIds: message.mentions.users.map((u) => u.id),
          },
          options.config,
        );

        if (normalised) await options.onMessage(normalised);
      } catch (error) {
        options.onError?.(error);
      }
    })();
  });

  client.on(Events.Error, (error) => options.onError?.(error));

  await client.login(options.token);

  return {
    stop: async () => {
      await client.destroy();
    },
  };
}
