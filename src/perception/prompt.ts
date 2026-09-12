/**
 * The perception prompt.
 *
 * TWO RULES ABOUT THIS FILE
 *
 * 1. Hard rules only. No example conversations. Few-shot examples teach the
 *    model to pattern-match on the examples and miss anything that does not
 *    look like them, which is fatal here because real group chat never looks
 *    like the samples you thought of. One crisp rule generalises; three
 *    examples do not.
 *
 * 2. Nothing in here may ask the model what to do about a message. It describes
 *    the situation and stops. The schema has no route field, and if a route ever
 *    appears in the output `assertValidEnvelope` throws.
 */

export const PERCEPTION_SYSTEM_PROMPT = `You extract structure from group chat messages. You never decide what happens to them.

Your entire job is to describe a message accurately enough that separate, deterministic code can compute whether it is worth interrupting a human for. That code, not you, makes every decision. Do not recommend an action, a priority, an urgency level, or a route.

HARD RULES

1. consequenceOfDelay measures what actually breaks if this message waits, not how the message is worded. Capital letters, exclamation marks and the word "urgent" are not evidence. A message shouting URGENT about a trivial question has consequence "none". Judge the outcome, not the tone.
   - none: nothing happens. Banter, opinions, links, questions with no stakes.
   - minor: a small inconvenience or a bit of friction for someone.
   - moderate: someone is blocked, a plan needs confirming, or a real decision waits.
   - severe: money, safety, a job, a live system, or someone's trust is at stake.

2. actionRequired is true only when THIS user specifically must act. If anyone in the channel could answer, or the message is addressed to the group, it is false. A question naming someone else is false.

3. deadline must be an absolute ISO 8601 UTC timestamp, resolved against the CURRENT TIME given to you. Convert relative language ("in 12 minutes", "by 5", "tonight", "Sunday") into an absolute instant. Use null when the message carries no time pressure at all. Do not invent a deadline to signal that something feels important.

4. speechAct places the message on the commitment ladder. Be strict, because only "commitment" is treated as evidence strong enough to act on:
   - banter: social talk, jokes, reactions.
   - question: asking for information or a decision.
   - proposal: floating a plan that nobody has accepted yet. "Padel Sunday?" is a proposal.
   - agreement: accepting someone else's proposal.
   - commitment: a specific person is now definitively expected to do or attend something, with enough detail to act on. "I'll send the report tomorrow morning" is a commitment. "I should probably send that report" is not.
   - alert: something is already wrong or already happening.

5. confidence is your honesty about your own reading, from 0 to 1. Lower it when the message is ambiguous, depends on context you cannot see, relies on sarcasm, or could plausibly be read another way. Low confidence reduces the chance of a wrongful interruption, so understating is safer than overstating.

6. reason is one plain sentence naming what is at stake and for whom. A human reads this to understand the decision, so write it for them. Never restate the message verbatim.

7. topic is a short noun phrase, at most six words.

Describe only what the message supports. Do not speculate about intent beyond the text.`;

/**
 * The JSON schema for structured output.
 *
 * `messageId` is deliberately absent: the runtime attaches it afterwards, so
 * the model cannot mislabel which message it just read. The mismatch check in
 * `evaluateMessage` then becomes defence in depth rather than the only guard.
 *
 * `route` is deliberately absent and must stay that way.
 */
export const PERCEPTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'speechAct',
    'actionRequired',
    'deadline',
    'consequenceOfDelay',
    'topic',
    'confidence',
    'reason',
  ],
  properties: {
    speechAct: {
      type: 'string',
      enum: ['banter', 'question', 'proposal', 'agreement', 'commitment', 'alert'],
      description: 'Where the message sits on the commitment ladder.',
    },
    actionRequired: {
      type: 'boolean',
      description: 'True only if this specific user must act.',
    },
    deadline: {
      type: ['string', 'null'],
      description: 'Absolute ISO 8601 UTC instant, or null when there is no time pressure.',
    },
    consequenceOfDelay: {
      type: 'string',
      enum: ['none', 'minor', 'moderate', 'severe'],
      description: 'What breaks if this waits. Not how the message is worded.',
    },
    topic: { type: 'string', description: 'Short noun phrase, six words maximum.' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    reason: {
      type: 'string',
      description: 'One plain sentence naming what is at stake and for whom.',
    },
  },
} as const;

/**
 * Builds the user-side content for one message.
 *
 * Note what is withheld. The model is not told the platform, because policy is
 * platform-blind and perception has no business reintroducing the signal. It is
 * also not told the relationship tier, because the tier is already a multiplier
 * in the cost model and letting perception see it would double-count closeness.
 */
export function buildPerceptionInput(params: {
  now: string;
  channelName: string;
  mentionsUser: boolean;
  text: string;
}): string {
  return [
    `CURRENT TIME (UTC): ${params.now}`,
    `CHANNEL: ${params.channelName}`,
    `USER WAS DIRECTLY MENTIONED: ${params.mentionsUser ? 'yes' : 'no'}`,
    '',
    'MESSAGE:',
    params.text,
  ].join('\n');
}
