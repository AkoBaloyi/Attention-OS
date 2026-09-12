/**
 * The cost model. Deterministic, no model involvement, no randomness.
 *
 * WHAT WE ARE ACTUALLY MEASURING
 *
 * Not "how important is this message" and not "how annoying is this message".
 * We compute the damage done by making it wait until the next digest release,
 * which is a moment the runtime already knows. That is what makes the number
 * defensible rather than arbitrary: the question is not a matter of opinion, it
 * is "does anything bad happen between now and 15:00".
 *
 * A consequence of that framing worth stating plainly: someone typing
 * "URGENT!!!" about a trivial question has a consequence of `none`, so base is
 * zero, so cost is zero, so it holds. Volume of shouting is not an input.
 */

import type { RelationshipTier } from '../contracts/message.ts';
import type {
  ConsequenceOfDelay,
  PerceptionEnvelope,
} from '../contracts/envelope.ts';
import type { EvaluationContext } from '../contracts/context.ts';
import type { CostBreakdown } from '../contracts/decision.ts';

/** Damage done by delay, before any modifiers. */
export const BASE_BY_CONSEQUENCE: Record<ConsequenceOfDelay, number> = {
  none: 0,
  minor: 0.5,
  moderate: 2,
  severe: 6,
};

/** How much closer someone is to you scales the cost of ignoring them. */
export const MULTIPLIER_BY_TIER: Record<RelationshipTier, number> = {
  inner: 1.5,
  work: 1.0,
  other: 0.5,
};

/**
 * Applied when the deadline lands before the next digest, meaning delay
 * genuinely causes harm rather than merely feeling urgent.
 *
 * DO NOT RAISE THIS. At higher values everything with a deadline saturates the
 * top band, every message reads as an interrupt, and the system loses the
 * ability to discriminate at all. 1.5 was calibrated against the three
 * reference scenarios in test/scenarios.test.ts.
 */
export const DEADLINE_MULTIPLIER = 1.5;

/** A deadline this close is treated as imminent regardless of stated
 * consequence, because the window to act is closing. */
export const IMMINENT_WINDOW_MS = 15 * 60 * 1000;

/** Floor applied to imminent deadlines. Sits at the interrupt threshold so an
 * imminent, action-required item cannot be quietly held. */
export const IMMINENT_FLOOR = 8;

/** Scales down anything the user is not specifically needed for. Group chatter
 * that happens to mention a deadline is not the user's problem. */
export const NOT_ACTION_REQUIRED_MULTIPLIER = 0.2;

/**
 * Two decimal places. Float noise (9 * 0.96 lands at 8.639999999999999) would
 * otherwise leak into both the assertions and the dashboard.
 */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function computeCost(
  envelope: PerceptionEnvelope,
  tier: RelationshipTier,
  context: EvaluationContext,
): CostBreakdown {
  const base = BASE_BY_CONSEQUENCE[envelope.consequenceOfDelay];

  const now = Date.parse(context.now);
  const nextDigest = Date.parse(context.nextDigestAt);
  const deadline =
    envelope.deadline === null ? null : Date.parse(envelope.deadline);

  const hasDeadline = deadline !== null && !Number.isNaN(deadline);

  // Delay only causes harm if the deadline arrives before we would have told
  // you anyway. A deadline after the next digest costs nothing extra.
  const beforeNextDigest = hasDeadline && deadline < nextDigest;
  const deadlineMultiplier = beforeNextDigest ? DEADLINE_MULTIPLIER : 1;

  let working = base * deadlineMultiplier;

  const imminent = hasDeadline && deadline - now <= IMMINENT_WINDOW_MS;
  const imminentFloorApplied = imminent && working < IMMINENT_FLOOR;
  if (imminentFloorApplied) {
    working = IMMINENT_FLOOR;
  }

  const actionRequiredMultiplier = envelope.actionRequired
    ? 1
    : NOT_ACTION_REQUIRED_MULTIPLIER;
  working *= actionRequiredMultiplier;

  const tierMultiplier = MULTIPLIER_BY_TIER[tier];
  const total = round2(working * tierMultiplier * envelope.confidence);

  return {
    base,
    deadlineMultiplier,
    imminentFloorApplied,
    actionRequiredMultiplier,
    tierMultiplier,
    confidence: envelope.confidence,
    total,
  };
}
