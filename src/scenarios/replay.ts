/**
 * Local replay: feeds reference scenarios straight into the pipeline.
 *
 * READ THIS BEFORE USING IT
 *
 * This bypasses the adapters. It is a development affordance so the pipeline,
 * the ledger and the dashboard can be seen working before any credentials exist,
 * and it must never be what a demo is recorded against. The injector
 * (src/scenarios/injector.ts) is the real path: it posts over the Discord and
 * Slack APIs and the messages come back in through the same route a human
 * message takes.
 *
 * The guarantee that keeps this honest is structural rather than a matter of
 * discipline: main.ts only wires replay up when NO adapter is connected. The
 * moment a real token is present, this path does not exist, so it is impossible
 * to accidentally film it. The dashboard also reports the mode as `replay`.
 */

import type { CanonicalMessage } from '../contracts/message.ts';
import type { Clock } from '../contracts/context.ts';
import { systemClock } from '../contracts/context.ts';
import { IdentityDirectory, type PersonMapping } from '../adapters/identity.ts';
import type { Pipeline } from '../runtime/pipeline.ts';
import type { Scenario, ScenarioMessage } from './reference.ts';

/**
 * The people the reference scenarios talk about.
 *
 * Tiers are the point: the scenarios only mean anything if the aunt is `inner`
 * and the colleague is `work`, because that multiplier is what the comparison
 * turns on. In a real deployment these come from attention.config.json.
 */
export const DEMO_PEOPLE: readonly PersonMapping[] = [
  { personId: 'person:aunt', displayName: 'Aunt Thandi', tier: 'inner' },
  { personId: 'person:friend', displayName: 'Sipho', tier: 'inner' },
  { personId: 'person:colleague', displayName: 'Ops on call', tier: 'work' },
];

/**
 * Produces exactly what the platform normalisers would produce for this message.
 * Kept in one place so the replay path, the e2e tests and the adapters cannot
 * disagree about the canonical shape.
 */
export function toCanonicalMessage(
  message: ScenarioMessage,
  options: {
    identity: IdentityDirectory;
    /** Unique per run, so replaying twice is two distinct messages rather than
     * being silently swallowed by the ledger's idempotency guard. */
    runId: string;
    index: number;
    clock?: Clock;
  },
): CanonicalMessage {
  const clock = options.clock ?? systemClock;
  const resolved = options.identity.resolveByPersonId(`person:${message.authorKey}`);

  return {
    id: `${message.platform}:replay-${options.runId}-${options.index}`,
    platform: message.platform,
    channelId: `C_${message.channelKey}`,
    channelName: message.channelKey,
    personId: resolved.personId,
    relationshipTier: resolved.relationshipTier,
    text: message.text,
    timestamp: clock.now().toISOString(),
    threadId: null,
    mentionsUser: message.mentionsOwner ?? false,
  };
}

export function createReplayer(deps: {
  pipeline: Pipeline;
  clock?: Clock;
  people?: readonly PersonMapping[];
  sleepImpl?: (ms: number) => Promise<void>;
}) {
  const identity = new IdentityDirectory(deps.people ?? DEMO_PEOPLE);
  const sleep = deps.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  return {
    /**
     * Posts a scenario on its scripted timing.
     *
     * `delayMs` controls when a message ARRIVES, not when perception finishes with
     * it, so ingestion is not awaited inside the timing loop. Awaiting it made
     * perception latency push the schedule out: with a slow provider, a message
     * scheduled 2.5 seconds in landed after five, drifting into the next
     * scenario's budget window.
     *
     * This also matches how the real adapters behave. Discord and Slack hand
     * messages over on their own schedule and main.ts ingests them without
     * awaiting, so replaying any other way would be testing a path that does not
     * exist in production.
     *
     * Concurrent ingestion is safe. Everything after perception, meaning reading
     * the remaining budget, deciding, and recording, is synchronous, so on Node's
     * single thread it cannot interleave and two messages cannot both spend the
     * same budget. Which of them gets the budget is decided by which is
     * understood first, and the scripted delays are far larger than the spread in
     * perception latency.
     */
    async replay(scenario: Scenario): Promise<void> {
      const runId = Date.now().toString(36);
      const inFlight: Array<Promise<unknown>> = [];
      let elapsed = 0;

      for (const [index, message] of scenario.messages.entries()) {
        const wait = message.delayMs - elapsed;
        if (wait > 0) {
          await sleep(wait);
          elapsed = message.delayMs;
        }

        inFlight.push(
          deps.pipeline.ingest(
            toCanonicalMessage(message, { identity, runId, index, clock: deps.clock }),
          ),
        );
      }

      // Resolve only once every message has been through the pipeline, so a
      // caller that awaits replay() knows the window is settled.
      await Promise.allSettled(inFlight);
    },
  };
}
