/**
 * The single funnel every message passes through.
 *
 * This exists to make the architecture's invariants structural rather than
 * a matter of everyone remembering them:
 *
 *   1. `nextDigestAt` is computed exactly once per evaluation, here, and then
 *      threaded through. No downstream code reaches for the clock.
 *   2. The remaining budget is read from the ledger, not from memory, so a
 *      restart cannot silently refill your attention.
 *   3. The decision is persisted before it is returned, so nothing can act on a
 *      decision that was never recorded.
 *
 * If you find yourself calling `decide()` directly outside of tests, you have
 * bypassed all three.
 */

import type { CanonicalMessage } from '../contracts/message.ts';
import type { PerceptionEnvelope } from '../contracts/envelope.ts';
import type { Decision } from '../contracts/decision.ts';
import type { Clock } from '../contracts/context.ts';
import {
  buildEvaluationContext,
  ceilingFor,
  computeNextDigestAt,
  systemClock,
} from '../contracts/context.ts';
import { assertValidEnvelope } from '../contracts/envelope.ts';
import { decide, deferUnreadable, type PolicyOptions } from '../policy/engine.ts';
import type { Ledger } from '../store/ledger.ts';

export type Runtime = {
  ledger: Ledger;
  clock?: Clock;
  /** Focus mode. A manual toggle: reading it from the calendar is a stretch
   * feature that demos identically, so it is not on the critical path. */
  focusActive: boolean;
  /** When the current budget window started. Absent means align to the clock
   * hour, which is the normal case. */
  windowAnchor?: string;
  policy?: PolicyOptions;
};

/** Builds the context for this evaluation. Shared so the unreadable path is
 * recorded against exactly the same window and budget as a normal decision. */
function contextFor(runtime: Runtime) {
  const clock = runtime.clock ?? systemClock;
  const nextDigestAt = computeNextDigestAt(clock, runtime.windowAnchor);
  const ceiling = ceilingFor(runtime.focusActive);

  return {
    clock,
    context: buildEvaluationContext({
      clock,
      focusActive: runtime.focusActive,
      budgetRemaining: runtime.ledger.remainingInWindow(nextDigestAt, ceiling),
      nextDigestAt,
    }),
  };
}

/**
 * Records a message perception could not read.
 *
 * Goes through the same funnel and the same ledger as everything else, so it
 * appears in the counters, shows up in the digest, and is auditable. The
 * alternative was dropping it, which would let an API outage quietly swallow
 * messages.
 */
export function evaluateUnreadable(
  runtime: Runtime,
  message: CanonicalMessage,
  failure: string,
): Decision {
  const { clock, context } = contextFor(runtime);
  const decision = deferUnreadable(message, context, failure);
  runtime.ledger.record(message, decision, clock.now().toISOString());
  return decision;
}

export function evaluateMessage(
  runtime: Runtime,
  message: CanonicalMessage,
  envelope: PerceptionEnvelope,
): Decision {
  // The model is an untrusted producer. Reject a malformed envelope loudly
  // rather than routing it at some default cost.
  assertValidEnvelope(envelope);

  if (envelope.messageId !== message.id) {
    throw new Error(
      `envelope/message mismatch: envelope is for ${envelope.messageId}, message is ${message.id}`,
    );
  }

  const clock = runtime.clock ?? systemClock;

  // Computed once. Everything else derives from it, including the window key.
  const nextDigestAt = computeNextDigestAt(clock, runtime.windowAnchor);
  const ceiling = ceilingFor(runtime.focusActive);
  const budgetRemaining = runtime.ledger.remainingInWindow(nextDigestAt, ceiling);

  const context = buildEvaluationContext({
    clock,
    focusActive: runtime.focusActive,
    budgetRemaining,
    nextDigestAt,
  });

  const decision = decide(message, envelope, context, runtime.policy ?? {});

  runtime.ledger.record(message, decision, clock.now().toISOString());

  return decision;
}
