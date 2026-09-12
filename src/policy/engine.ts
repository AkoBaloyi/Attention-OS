/**
 * The policy engine. Turns a perception envelope into a routed Decision using
 * deterministic code only.
 *
 * HOW THE BUDGET ACTUALLY WORKS  (the part most likely to be built wrong)
 *
 * The budget does not gate expensive messages. It gates DISCRETIONARY ones.
 *
 * A naive "can I afford this?" check would refuse to interrupt for a production
 * incident because its cost exceeds the remaining budget. That is exactly
 * backwards: a high cost is precisely the evidence that interrupting is the
 * cheaper option.
 *
 * So anything at or above the interrupt threshold goes through regardless of
 * what is left, but it still DRAWS DOWN the budget. The consequence is the
 * sentence the whole demo turns on: a production incident interrupts you and
 * spends your entire attention budget, so the dinner question that would have
 * reached you on a quiet afternoon has to wait for the digest instead.
 */

import type { CanonicalMessage } from '../contracts/message.ts';
import type { PerceptionEnvelope } from '../contracts/envelope.ts';
import type { EvaluationContext } from '../contracts/context.ts';
import type { Decision, Route, RouteBasis } from '../contracts/decision.ts';
import { computeCost } from './cost.ts';

/** Below this, nothing bad happens if it waits. Held silently. */
export const HOLD_THRESHOLD = 1;

/** At or above this, interrupting is cheaper than staying silent. Overrides
 * the budget. */
export const INTERRUPT_THRESHOLD = 4;

/** At or above this, the top rung is warranted. */
export const CALL_THRESHOLD = 8;

export type PolicyOptions = {
  /** Explicit always-allow list, by canonical personId. Deterministic, and the
   * deliberate alternative to preference learning. */
  alwaysAllowPersonIds?: ReadonlySet<string>;
  /** The call rung is a stretch feature. When disabled, costs in the call band
   * render as a loud push and nothing else changes. */
  callEnabled?: boolean;
};

function chooseRoute(
  cost: number,
  budgetRemaining: number,
  callEnabled: boolean,
): { route: Route; basis: RouteBasis; drawsBudget: boolean } {
  if (cost >= CALL_THRESHOLD) {
    return callEnabled
      ? { route: 'call', basis: 'non_discretionary_call', drawsBudget: true }
      : { route: 'push', basis: 'non_discretionary', drawsBudget: true };
  }

  if (cost >= INTERRUPT_THRESHOLD) {
    return { route: 'push', basis: 'non_discretionary', drawsBudget: true };
  }

  if (cost < HOLD_THRESHOLD) {
    return { route: 'hold', basis: 'below_threshold', drawsBudget: false };
  }

  // Discretionary band. This is the only place the budget can change the answer.
  if (cost <= budgetRemaining) {
    return {
      route: 'push',
      basis: 'discretionary_within_budget',
      drawsBudget: true,
    };
  }

  return {
    route: 'digest',
    basis: 'discretionary_budget_exhausted',
    drawsBudget: false,
  };
}

export function decide(
  message: CanonicalMessage,
  envelope: PerceptionEnvelope,
  context: EvaluationContext,
  options: PolicyOptions = {},
): Decision {
  const callEnabled = options.callEnabled ?? false;

  const breakdown = computeCost(envelope, message.relationshipTier, context);
  const cost = breakdown.total;

  const allowlisted =
    options.alwaysAllowPersonIds?.has(message.personId) ?? false;

  let { route, basis, drawsBudget } = chooseRoute(
    cost,
    context.budgetRemaining,
    callEnabled,
  );

  // An explicit always-allow rule promotes a held or deferred item to a push.
  // It never demotes, and it never reaches the call rung, because the user
  // asked to hear from this person, not to be phoned by them.
  if (allowlisted && (route === 'hold' || route === 'digest')) {
    route = 'push';
    basis = 'always_allow_rule';
    drawsBudget = true;
  }

  const budgetBefore = context.budgetRemaining;
  const budgetAfter = drawsBudget
    ? Math.max(0, Math.round((budgetBefore - cost) * 100) / 100)
    : budgetBefore;

  return {
    messageId: envelope.messageId,
    route,
    basis,
    cost,
    breakdown,
    budgetBefore,
    budgetAfter,
    reason: envelope.reason,
    context,
    envelope,
  };
}
