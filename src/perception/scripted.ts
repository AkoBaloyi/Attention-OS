/**
 * A scripted perception transport for running without an API key.
 *
 * BE CLEAR ABOUT WHAT THIS IS
 *
 * For the reference scenario texts it replays the expected perception recorded in
 * src/scenarios/reference.ts, which is the same data the scenario tests assert
 * against. For anything else it applies crude keyword rules at deliberately low
 * confidence.
 *
 * It exists so the pipeline, the ledger and the dashboard can be developed and
 * demonstrated before credentials land, and so the team is not blocked on a key.
 * It is not a fallback for the real thing and it must never be presented as one:
 * the dashboard reports perception as "stub" rather than "live" whenever this is
 * in use, and that indicator is not styled as healthy.
 *
 * The crude path is intentionally poor. If it were good enough to pass for the
 * real perception layer, someone would eventually ship a demo on it.
 */

import type { PerceptionTransport } from './perceiver.ts';
import type { Clock } from '../contracts/context.ts';
import { systemClock } from '../contracts/context.ts';
import { allScenarioMessages } from '../scenarios/reference.ts';

export function scriptedTransport(options: { clock?: Clock } = {}): PerceptionTransport {
  const clock = options.clock ?? systemClock;

  // Normalised text -> the expected reading, so punctuation and casing drift in
  // the injected message does not break the lookup.
  const script = new Map(
    allScenarioMessages().map((m) => [normalise(m.text), m.perception] as const),
  );

  return {
    async complete({ user }) {
      const text = extractMessage(user);
      const now = clock.now().getTime();

      const scripted = script.get(normalise(text));
      if (scripted) {
        return {
          speechAct: scripted.speechAct,
          actionRequired: scripted.actionRequired,
          deadline:
            scripted.deadlineOffsetMs === null
              ? null
              : new Date(now + scripted.deadlineOffsetMs).toISOString(),
          consequenceOfDelay: scripted.consequenceOfDelay,
          topic: scripted.topic,
          confidence: scripted.confidence,
          reason: scripted.reason,
        };
      }

      return guess(text, now);
    },
  };
}

/** The crude path. Low confidence on purpose. */
function guess(text: string, now: number): Record<string, unknown> {
  const lower = text.toLowerCase();

  const severe = /\b(down|outage|rollback|errors|emergency|waiting for you|starts in)\b/.test(lower);
  const moderate = /\b(can you|could you|are you|review|confirm|coming|approve|deadline)\b/.test(lower);

  const consequenceOfDelay = severe ? 'severe' : moderate ? 'moderate' : 'none';

  const minutes = /in (\d+) (?:minutes?|mins?)\b/.exec(lower);
  const deadline = minutes
    ? new Date(now + Number(minutes[1]) * 60_000).toISOString()
    : null;

  const speechAct = /\bi'?ll\b|\bi will\b/.test(lower)
    ? 'commitment'
    : /^anyone\b/.test(lower)
      ? 'proposal'
      : severe
        ? 'alert'
        : text.includes('?')
          ? 'question'
          : 'banter';

  return {
    speechAct,
    actionRequired: moderate || severe,
    deadline,
    consequenceOfDelay,
    topic: text.slice(0, 40),
    // Low on purpose. This is a keyword match, not a reading.
    confidence: 0.5,
    reason: 'Stub perception: keyword match only, no API key configured.',
  };
}

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/<@[^>]+>/g, '') // strip mention markup the injector added
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Pulls the message body back out of the rendered prompt. */
function extractMessage(user: string): string {
  const marker = user.indexOf('MESSAGE:');
  return marker === -1 ? user : user.slice(marker + 'MESSAGE:'.length).trim();
}
