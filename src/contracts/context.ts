/**
 * The evaluation context: every time-and-state value the policy engine is
 * allowed to read, captured once per message and persisted with the decision.
 *
 * WHY THIS EXISTS AS ITS OWN TYPE
 *
 * `nextDigestAt` is load-bearing. Cost depends on whether a deadline falls
 * before the next digest release, so if two parts of the system compute that
 * moment independently they will disagree and routing becomes
 * non-deterministic.
 *
 * There is a sharper failure mode underneath. If the digest fires hourly and a
 * test runs at 14:58, then a deadline "in 12 minutes" lands AFTER the next
 * release, the multiplier never applies, and a scenario that passes at 14:30
 * fails at 14:58. That looks like a broken cost model and costs an hour to
 * find. So the clock is injectable and freezable, and the scenario tests assert
 * against fixed values rather than wall time.
 *
 * Finally, the whole context is stored on every decision row. A ledger entry
 * recording cost 8.64 without the context that produced it is not auditable.
 * With it, anyone can re-derive the arithmetic by hand from a single row.
 */

export type EvaluationContext = {
  /** ISO 8601 UTC. The single source of "now" for this evaluation. */
  now: string;
  /** ISO 8601 UTC. The next digest release. Computed once, never recomputed. */
  nextDigestAt: string;
  /** True while the user is in a focus block. Lowers the budget ceiling. */
  focusActive: boolean;
  /** Total discretionary attention available this window. */
  budgetCeiling: number;
  /** Discretionary attention still unspent. Floors at zero. */
  budgetRemaining: number;
};

/**
 * Injectable time source. Production uses `systemClock`; tests use
 * `frozenClock` so the pre-computed scenario costs are exactly reproducible.
 */
export type Clock = {
  now(): Date;
};

export const systemClock: Clock = {
  now: () => new Date(),
};

export function frozenClock(instant: string | Date): Clock {
  const fixed = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(fixed.getTime())) {
    throw new Error(`frozenClock received an invalid instant: ${String(instant)}`);
  }
  return { now: () => new Date(fixed) };
}

/** Budget ceilings. Focus mode must sit above a typical discretionary
 * message cost, otherwise displacement can never be demonstrated: a message
 * that would have reached you on a quiet afternoon has to be capable of
 * reaching you before something more expensive crowds it out. */
export const BUDGET_CEILING_NORMAL = 10;
export const BUDGET_CEILING_FOCUS = 3.0;

/** The digest releases on the hour. This is the ONLY place that is decided. */
export function computeNextDigestAt(clock: Clock): string {
  const now = clock.now();
  const next = new Date(now);
  next.setUTCMinutes(0, 0, 0);
  next.setUTCHours(next.getUTCHours() + 1);
  return next.toISOString();
}

export function ceilingFor(focusActive: boolean): number {
  return focusActive ? BUDGET_CEILING_FOCUS : BUDGET_CEILING_NORMAL;
}

/**
 * Builds the one context for this evaluation. Call this once per message and
 * thread the result through everything; never let a downstream function reach
 * for the clock itself.
 */
export function buildEvaluationContext(params: {
  clock: Clock;
  focusActive: boolean;
  budgetRemaining: number;
}): EvaluationContext {
  const ceiling = ceilingFor(params.focusActive);
  return {
    now: params.clock.now().toISOString(),
    nextDigestAt: computeNextDigestAt(params.clock),
    focusActive: params.focusActive,
    budgetCeiling: ceiling,
    budgetRemaining: Math.max(0, Math.min(params.budgetRemaining, ceiling)),
  };
}
