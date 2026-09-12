/**
 * The perception layer: message in, structured envelope out.
 *
 * The transport is injected, which is what makes the prompt discipline, the
 * schema handling and the failure paths all testable without a live API key or a
 * network round trip. `openAiTransport` is the production implementation.
 */

import type { CanonicalMessage } from '../contracts/message.ts';
import type { PerceptionEnvelope } from '../contracts/envelope.ts';
import { assertValidEnvelope } from '../contracts/envelope.ts';
import type { Clock } from '../contracts/context.ts';
import { systemClock } from '../contracts/context.ts';
import {
  PERCEPTION_SCHEMA,
  PERCEPTION_SYSTEM_PROMPT,
  buildPerceptionInput,
} from './prompt.ts';

/** Everything the model is allowed to return. No messageId, no route. */
export type PerceptionDraft = Omit<PerceptionEnvelope, 'messageId'>;

/** The seam. Takes rendered prompts, returns the model's parsed JSON. */
export type PerceptionTransport = {
  complete(params: {
    system: string;
    user: string;
    schema: unknown;
  }): Promise<unknown>;
};

export class PerceptionError extends Error {}

export type Perceiver = {
  perceive(message: CanonicalMessage): Promise<PerceptionEnvelope>;
};

export function createPerceiver(options: {
  transport: PerceptionTransport;
  clock?: Clock;
  /** Transient failures get one more chance. Perception is on the hot path for
   * every message, so a single network blip must not drop a message silently. */
  retries?: number;
}): Perceiver {
  const clock = options.clock ?? systemClock;
  const retries = options.retries ?? 1;

  return {
    async perceive(message: CanonicalMessage): Promise<PerceptionEnvelope> {
      const user = buildPerceptionInput({
        now: clock.now().toISOString(),
        channelName: message.channelName,
        mentionsUser: message.mentionsUser,
        text: message.text,
      });

      let lastError: unknown;

      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          const raw = await options.transport.complete({
            system: PERCEPTION_SYSTEM_PROMPT,
            user,
            schema: PERCEPTION_SCHEMA,
          });

          // The model is an untrusted producer. Attach the id ourselves so it
          // cannot mislabel the message, then validate before anything routes.
          const envelope = {
            ...(raw as PerceptionDraft),
            messageId: message.id,
          } as PerceptionEnvelope;

          if ('route' in (raw as Record<string, unknown>)) {
            throw new PerceptionError(
              'model returned a route: the model proposes, the runtime decides',
            );
          }

          assertValidEnvelope(envelope);
          return normalise(envelope);
        } catch (error) {
          lastError = error;
          // A contract violation will not fix itself on retry. Only transient
          // transport failures are worth attempting again.
          if (error instanceof PerceptionError) throw error;
        }
      }

      throw new PerceptionError(
        `perception failed for ${message.id} after ${retries + 1} attempt(s): ${String(lastError)}`,
      );
    },
  };
}

/**
 * Tidies fields the model can technically satisfy the schema with while still
 * being wrong: an unparseable deadline string, or a confidence just outside the
 * range after floating point rounding.
 */
function normalise(envelope: PerceptionEnvelope): PerceptionEnvelope {
  let deadline = envelope.deadline;
  if (deadline !== null && Number.isNaN(Date.parse(deadline))) {
    // An uninterpretable deadline is worse than no deadline: it would silently
    // skip the multiplier while looking like it applied.
    deadline = null;
  }

  return {
    ...envelope,
    deadline,
    confidence: Math.min(1, Math.max(0, envelope.confidence)),
    reason: envelope.reason.trim(),
  };
}

/**
 * Tries each transport in order until one answers.
 *
 * Perception sits on the hot path for every message, so a single dead provider
 * should not take the whole agent down. This became a real requirement rather
 * than a nice idea the first time a key ran out of credit: every message in the
 * window failed, and the answer to that is a second provider, not a retry against
 * the same exhausted one.
 *
 * Order matters. Put the provider you want first, and a scripted or local
 * transport last if you want the system to keep functioning at reduced fidelity.
 */
export function fallbackTransport(
  ...transports: ReadonlyArray<{ name: string; transport: PerceptionTransport }>
): PerceptionTransport & { lastUsed: () => string | undefined } {
  let lastUsed: string | undefined;

  return {
    lastUsed: () => lastUsed,
    async complete(params) {
      const failures: string[] = [];

      for (const { name, transport } of transports) {
        try {
          const result = await transport.complete(params);
          lastUsed = name;
          return result;
        } catch (error) {
          failures.push(`${name}: ${String(error).slice(0, 160)}`);
        }
      }

      throw new Error(`all perception providers failed. ${failures.join(' | ')}`);
    },
  };
}

/**
 * OpenRouter, which speaks the same Chat Completions shape as OpenAI.
 *
 * Exists as the second link in the fallback chain, so one provider running out of
 * credit degrades fidelity instead of stopping the agent.
 */
export function openRouterTransport(config: {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
}): PerceptionTransport {
  return openAiTransport({
    apiKey: config.apiKey,
    model: config.model ?? 'openai/gpt-4o-mini',
    baseUrl: 'https://openrouter.ai/api/v1',
    timeoutMs: config.timeoutMs,
  });
}

/**
 * Production transport: OpenAI Chat Completions with strict structured output.
 *
 * Uses native fetch rather than the SDK to keep the dependency surface at zero
 * and to make the actual API contract visible to anyone reading the repo.
 */
export function openAiTransport(config: {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
}): PerceptionTransport {
  const model = config.model ?? 'gpt-4o-mini';
  const baseUrl = config.baseUrl ?? 'https://api.openai.com/v1';
  const timeoutMs = config.timeoutMs ?? 15_000;

  return {
    async complete({ system, user, schema }) {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.apiKey}`,
        },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({
          model,
          temperature: 0,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'perception_envelope',
              strict: true,
              schema,
            },
          },
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`openai ${response.status}: ${body.slice(0, 400)}`);
      }

      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = payload.choices?.[0]?.message?.content;

      if (typeof content !== 'string') {
        throw new Error('openai returned no message content');
      }

      return JSON.parse(content);
    },
  };
}
