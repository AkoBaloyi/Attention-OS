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
import { decide, type PolicyOptions } from '../policy/engine.ts';
import type { Ledger } from '../store/ledger.ts';

export type Runtime = {
  ledger: Ledger;
  clock?: Clock;
  /** Focus mode. A manual toggle: reading it from the calendar is a stretch
   * feature that demos identically, so it is not on the critical path. */
  focusActive: boolean;
  policy?: PolicyOptions;
};

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
  const nextDigestAt = computeNextDigestAt(clock);
  const ceiling = ceilingFor(runtime.focusActive);
  const budgetRemaining = runtime.ledger.remainingInWindow(nextDigestAt, ceiling);

  const context = buildEvaluationContext({
    clock,
    focusActive: runtime.focusActive,
    budgetRemaining,
  });

  const decision = decide(message, envelope, context, runtime.policy ?? {});

  runtime.ledger.record(message, decision, clock.now().toISOString());

  return decision;
}
