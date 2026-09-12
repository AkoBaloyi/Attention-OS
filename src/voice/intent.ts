/**
 * Intent routing for the voice interface.
 *
 * Deterministic pattern matching rather than a model call, for the same reason
 * the policy engine is deterministic: the answers are read out of the ledger, so
 * they should be reached the same way every time. It is also instant, free, and
 * works with no API key, which matters because a voice demo that pauses for a
 * network round trip feels broken even when it is fine.
 *
 * A model is only consulted when nothing matches, and only to pick an intent. It
 * never composes the answer, because the answer is a fact about persisted rows
 * rather than something to be written.
 */

export type VoiceIntent =
  | 'catch_up'
  | 'interrupts'
  | 'digest'
  | 'held'
  | 'budget'
  | 'focus'
  | 'explain'
  | 'help'
  | 'unknown';

export type IntentMatch = {
  intent: VoiceIntent;
  /** For `explain`, the thing being asked about, if the user named one. */
  subject?: string;
};

/**
 * Ordered, and the order is load bearing. "Why did the rollback interrupt me"
 * contains "interrupt", so `explain` has to be tested before `interrupts` or the
 * question gets answered with a list instead of a reason.
 */
/**
 * Note the `\w*` suffixes. Wrapping an alternation in `\b(...)\b` forces every
 * alternative to be a complete word, so a bare `interrupt` silently fails to
 * match "interrupted" and `summar` fails to match "summary". Where a prefix is
 * intended it has to say so.
 */
const PATTERNS: ReadonlyArray<{ intent: VoiceIntent; test: RegExp }> = [
  { intent: 'explain', test: /\b(why|how come|explain\w*|reason\w*|justif\w*|what made)\b/ },
  { intent: 'help', test: /\b(help|what can (you|i) (do|ask)|commands|options)\b/ },
  {
    intent: 'catch_up',
    test: /\b(what did i miss|catch me up|catch up|bring me up|summar\w*|brief me|what happened|what have i missed|debrief\w*)\b/,
  },
  { intent: 'interrupts', test: /\b(interrupt\w*|got through|broke through|reach\w* me|bother\w* me)\b/ },
  { intent: 'digest', test: /\b(digest\w*|waiting|deferred|defer|later|queue\w*|pending)\b/ },
  { intent: 'held', test: /\b(held|hold|ignor\w*|silent\w*|filter\w*|block\w*|hidden|suppress\w*)\b/ },
  { intent: 'budget', test: /\b(budget|attention left|how much|remaining|spent|capacity)\b/ },
  { intent: 'focus', test: /\b(focus mode|am i focus\w*|focusing|in focus)\b/ },
];

/** Words to strip when working out what an "explain" question is about. */
const FILLER =
  /\b(why|did|does|do|the|that|this|a|an|it|me|my|i|was|were|is|are|interrupt\w*|held|hold|defer\w*|come|through|get|got|reach\w*|explain\w*|reason\w*|happen\w*|how|what|made|about|for|to|of|and|so|then|please|tell|you|us|just|now|again)\b/g;

export function matchIntent(transcript: string): IntentMatch {
  const text = transcript.toLowerCase().trim();
  if (text.length === 0) return { intent: 'unknown' };

  for (const { intent, test } of PATTERNS) {
    if (test.test(text)) {
      return intent === 'explain'
        ? { intent, subject: extractSubject(text) }
        : { intent };
    }
  }

  return { intent: 'unknown' };
}

/**
 * Pulls the topic out of "why did the production rollback interrupt me".
 *
 * Returns undefined rather than a guess when nothing meaningful is left, so the
 * briefing falls back to the most recent decision, which is what "why did that
 * happen" almost always means anyway.
 */
function extractSubject(text: string): string | undefined {
  const remaining = text
    .replace(/[?.!,]/g, ' ')
    .replace(FILLER, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return remaining.length >= 3 ? remaining : undefined;
}

export const HELP_LINE =
  'You can ask what you missed, what interrupted you, what is waiting for the digest, ' +
  'what was held, how much attention budget is left, or why something was routed the way it was.';

export const UNKNOWN_LINE =
  'I did not catch a question I can answer from the record. ' + HELP_LINE;
