/**
 * The output of the policy engine. Produced by deterministic code only.
 *
 * A Decision is a complete audit record: the envelope that went in, the context
 * it was evaluated against, the arithmetic that produced the cost, and the
 * route that followed. Given one row you can re-derive everything by hand,
 * which is the difference between claiming the policy is deterministic and
 * showing it.
 */

import type { EvaluationContext } from './context.ts';
import type { PerceptionEnvelope } from './envelope.ts';

/**
 * The escalation ladder, cheapest first.
 *
 * hold     archived silently, never surfaces unless you go looking
 * digest   surfaces in the next scheduled digest
 * push     interrupts now, quietly
 * call     interrupts now, loudly. Top rung.
 */
export type Route = 'hold' | 'digest' | 'push' | 'call';

/**
 * Why the route was chosen. Rendered verbatim on the dashboard, so a judge can
 * read the mechanism off the screen without a verbal explanation.
 */
export type RouteBasis =
  /** Cost below the floor. Nothing bad happens if this waits. */
  | 'below_threshold'
  /** Cost is in the discretionary band and the budget covered it. */
  | 'discretionary_within_budget'
  /** Discretionary, but the budget was already spent. Downgraded. */
  | 'discretionary_budget_exhausted'
  /** Cost at or above the interrupt threshold. Overrides the budget. */
  | 'non_discretionary'
  /** Non-discretionary and loud enough for the top rung. */
  | 'non_discretionary_call'
  /** An explicit always-allow rule for this person forced it through. */
  | 'always_allow_rule'
  /**
   * Perception could not read the message, so it was deferred rather than
   * dropped. Not a cost decision: no cost could be computed. A message we
   * failed to understand is not a message that does not matter, and dropping it
   * would mean an API outage silently swallowed things you needed to see.
   */
  | 'perception_unavailable';

/** The intermediate arithmetic, kept so the cost is inspectable rather than
 * an opaque number. Every field corresponds to one line of the cost model. */
export type CostBreakdown = {
  /** Base from consequenceOfDelay. */
  base: number;
  /** Applied when the deadline falls before nextDigestAt. */
  deadlineMultiplier: number;
  /** True when the imminent-deadline floor of 8 was applied. */
  imminentFloorApplied: boolean;
  /** Applied when the user is not specifically required. */
  actionRequiredMultiplier: number;
  /** From relationshipTier. */
  tierMultiplier: number;
  /** From the model's confidence. */
  confidence: number;
  /** The final product. */
  total: number;
};

export type Decision = {
  messageId: string;
  route: Route;
  basis: RouteBasis;
  cost: number;
  breakdown: CostBreakdown;
  /** Budget state before and after this decision drew on it. */
  budgetBefore: number;
  budgetAfter: number;
  /** Carried verbatim from the envelope so the row explains itself. */
  reason: string;
  /** The full context this was evaluated against. Enables re-derivation. */
  context: EvaluationContext;
  /** The perception that fed it. Enables re-derivation. */
  envelope: PerceptionEnvelope;
};
