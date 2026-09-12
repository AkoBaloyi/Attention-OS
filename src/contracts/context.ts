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

/** How long a budget window lasts. */
export const WINDOW_LENGTH_MS = 60 * 60 * 1000;

/**
 * When the next digest releases. This is the ONLY place that is decided.
 *
 * A window is always one hour long. By default it is aligned to the clock hour,
 * which is what you want in normal use: the digest arrives at a predictable time.
 *
 * Passing an anchor starts a window from that instant instead. Rolling the window
 * does exactly this, and it matters more than it looks. Without it, cost depends
 * on which minute of the hour you happen to be in: a deadline twelve minutes out
 * falls before a 15:00 release at 14:30 and after it at 14:55, so the same
 * message costs 8.64 or 7.68 depending on the wall clock. Both answers are
 * correct, which is the problem, because a demo that changes its numbers between
 * takes cannot be checked against anything.
 */
export function computeNextDigestAt(clock: Clock, anchorIso?: string): string {
  const now = clock.now();

  if (anchorIso) {
    const anchor = Date.parse(anchorIso);
    if (!Number.isNaN(anchor)) {
      // Advance whole windows until we are ahead of now, so a long-lived anchor
      // keeps producing sensible windows rather than one stuck in the past.
      const elapsed = Math.max(0, now.getTime() - anchor);
      const windows = Math.floor(elapsed / WINDOW_LENGTH_MS) + 1;
      return new Date(anchor + windows * WINDOW_LENGTH_MS).toISOString();
    }
  }

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
  /** Pass the already-computed release time so it is not derived twice. Omitted
   * only in tests that do not care about the window. */
  nextDigestAt?: string;
  windowAnchor?: string;
}): EvaluationContext {
  const ceiling = ceilingFor(params.focusActive);
  return {
    now: params.clock.now().toISOString(),
    nextDigestAt:
      params.nextDigestAt ?? computeNextDigestAt(params.clock, params.windowAnchor),
    focusActive: params.focusActive,
    budgetCeiling: ceiling,
    budgetRemaining: Math.max(0, Math.min(params.budgetRemaining, ceiling)),
  };
}
