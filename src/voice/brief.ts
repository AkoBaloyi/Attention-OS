/**
 * Spoken briefings, generated from the ledger.
 *
 * THE BOUNDARY THAT MATTERS
 *
 * This module is read only, and structurally so: `VoiceLedgerView` exposes no
 * write methods, so nothing here can route a message, interrupt you, or spend
 * the budget. The voice interface answers questions about decisions that have
 * already been made and recorded.
 *
 * That is not a limitation, it is the point. The entire architecture rests on the
 * model proposing while deterministic policy decides. A conversational agent that
 * could act would be a second path where a model decides things, which is exactly
 * what this project exists to avoid. So the agent reads the audit record aloud.
 *
 * Every sentence below is derived from persisted rows. None of it is generated
 * prose, which means the numbers it speaks are the numbers the tests assert.
 */

import type { LedgerEntry, WindowCounters } from '../store/ledger.ts';

/** Deliberately narrow. No write methods exist on this type. */
export type VoiceLedgerView = {
  recent(limit?: number): LedgerEntry[];
  counters(windowKey: string, ceiling: number): WindowCounters;
  digestFor(windowKey: string): LedgerEntry[];
};

export type Briefing = {
  /** Speech-friendly text. No symbols, no markup, no bullet characters. */
  speech: string;
  /** Same content for the transcript pane, where reading is easier than hearing. */
  text: string;
};

const ROUTE_WORDS: Record<string, string> = {
  hold: 'held silently',
  digest: 'waiting for the digest',
  push: 'interrupted you',
  call: 'called you',
};

/** "aunt", not "person:aunt". Spoken ids sound terrible. */
export function speakablePerson(personId: string): string {
  return personId
    .replace(/^person:/, '')
    .replace(/^unmapped:[a-z]+:/, '')
    .replace(/[_-]+/g, ' ');
}

function describe(entry: LedgerEntry): string {
  const who = speakablePerson(entry.message.personId);
  return `${entry.decision.envelope.topic}, from ${who} in ${entry.message.channelName}`;
}

function list(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0]!;
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/**
 * Capitalises a sentence that begins with a topic.
 *
 * Topics come from the perception layer in lower case, so without this the
 * spoken output reads "1 message interrupted you. production rollback approval",
 * which a speech engine renders with an audible stumble at the full stop.
 */
function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "What did I miss?" The whole window in one pass. */
export function catchUp(
  ledger: VoiceLedgerView,
  windowKey: string,
  counters: WindowCounters,
): Briefing {
  if (counters.received === 0) {
    return say('Nothing has arrived in this window, so you have not missed anything.');
  }

  const entries = ledger.recent(200).filter((e) => e.decision.context.nextDigestAt === windowKey);
  const interrupted = entries.filter((e) => e.decision.route === 'push' || e.decision.route === 'call');
  const deferred = entries.filter((e) => e.decision.route === 'digest');
  const held = entries.filter((e) => e.decision.route === 'hold');

  const parts: string[] = [
    `${counters.received} ${counters.received === 1 ? 'message' : 'messages'} arrived.`,
  ];

  if (interrupted.length > 0) {
    parts.push(
      `${interrupted.length === 1 ? 'One thing' : `${interrupted.length} things`} was worth interrupting you for: ${list(interrupted.map(describe))}.`,
    );
  } else {
    parts.push('Nothing was worth interrupting you for.');
  }

  if (deferred.length > 0) {
    parts.push(
      `${deferred.length === 1 ? 'One is' : `${deferred.length} are`} waiting for the digest: ${list(deferred.map(describe))}.`,
    );
  }

  if (held.length > 0) {
    parts.push(
      `${held.length} ${held.length === 1 ? 'was' : 'were'} held silently because nothing breaks if they wait.`,
    );
  }

  parts.push(budgetSentence(counters));

  return say(parts.join(' '));
}

/** "What interrupted me?" and its inverses, one function, three filters. */
export function byRoute(
  ledger: VoiceLedgerView,
  windowKey: string,
  routes: readonly string[],
  emptyLine: string,
): Briefing {
  const entries = ledger
    .recent(200)
    .filter((e) => e.decision.context.nextDigestAt === windowKey && routes.includes(e.decision.route));

  if (entries.length === 0) return say(emptyLine);

  const label = ROUTE_WORDS[routes[0]!] ?? 'were routed';
  return say(
    `${entries.length} ${entries.length === 1 ? 'message' : 'messages'} ${label}. ` +
      `${sentence(list(entries.map(describe)))}.`,
  );
}

/** "How much attention have I got left?" */
export function budgetBriefing(counters: WindowCounters, focusActive: boolean): Briefing {
  const focus = focusActive
    ? 'You are in focus mode, so the ceiling is lower than usual.'
    : 'You are not in focus mode.';
  return say(`${focus} ${budgetSentence(counters)}`);
}

function budgetSentence(counters: WindowCounters): string {
  if (counters.spent === 0) {
    return `You have spent none of your attention budget. All ${counters.ceiling} is still available.`;
  }
  if (counters.remaining === 0) {
    return `Your attention budget is fully spent. All ${counters.ceiling} of it has gone, so anything discretionary from here waits for the digest.`;
  }
  return `You have spent ${counters.spent} of ${counters.ceiling}, leaving ${counters.remaining}.`;
}

/**
 * "Why did that interrupt me?"
 *
 * The most valuable thing the voice interface does. It reads the arithmetic out
 * loud, which turns the determinism claim into something you can hear rather than
 * something you have to be told.
 */
export function explain(ledger: VoiceLedgerView, windowKey: string, subject?: string): Briefing {
  const entries = ledger
    .recent(200)
    .filter((e) => e.decision.context.nextDigestAt === windowKey);

  if (entries.length === 0) {
    return say('There are no decisions in this window to explain.');
  }

  const match = subject
    ? entries.find((e) =>
        `${e.decision.envelope.topic} ${e.message.text} ${speakablePerson(e.message.personId)}`
          .toLowerCase()
          .includes(subject.toLowerCase()),
      )
    : undefined;

  // Falling back to the most recent decision is the right default: "why did that
  // happen" almost always means the thing that just happened.
  const entry = match ?? entries[0]!;
  const { decision } = entry;
  const b = decision.breakdown;

  const factors: string[] = [
    `a base of ${b.base} because the consequence of delay is ${decision.envelope.consequenceOfDelay}`,
  ];
  if (b.imminentFloorApplied) {
    factors.push('raised to the imminent deadline floor of 8 because the deadline is inside fifteen minutes');
  }
  if (b.deadlineMultiplier !== 1) {
    factors.push(`multiplied by ${b.deadlineMultiplier} because the deadline falls before the next digest`);
  }
  if (b.actionRequiredMultiplier !== 1) {
    factors.push(`scaled down to ${b.actionRequiredMultiplier} of that because you are not specifically needed`);
  }
  if (b.tierMultiplier !== 1) {
    factors.push(`multiplied by ${b.tierMultiplier} for how close this person is to you`);
  }
  // No leading "and": list() supplies it for the final item, and both together
  // produce an audible "and and".
  factors.push(`by ${b.confidence} for confidence`);

  const outcome = OUTCOME_LINES[decision.basis] ?? `It was routed to ${decision.route}.`;

  return say(
    `${sentence(entry.decision.envelope.topic)}, from ${speakablePerson(entry.message.personId)}, ` +
      `cost ${decision.cost}. That is ${list(factors)}. ${outcome} ` +
      `The recorded reason is: ${decision.reason}`,
  );
}

const OUTCOME_LINES: Record<string, string> = {
  below_threshold:
    'That is below the threshold of 1, so it was held silently and cost you no attention at all.',
  discretionary_within_budget:
    'That sits in the discretionary band and your budget covered it, so it reached you.',
  discretionary_budget_exhausted:
    'That sits in the discretionary band, but your budget was already spent, so it was deferred to the digest instead.',
  non_discretionary:
    'That is at or above the interrupt threshold of 4, so it overrode your budget entirely. Interrupting you was the cheaper option.',
  non_discretionary_call:
    'That is at or above 8, high enough for the top rung, so it called you and overrode your budget.',
  always_allow_rule:
    'You have an always allow rule for this person, so it was promoted past the hold.',
};

function say(speech: string): Briefing {
  return { speech, text: speech };
}
