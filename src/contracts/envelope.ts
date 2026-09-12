/**
 * The output of the perception layer.
 *
 * CONTRACT RULE: there is deliberately no `route` field, and there never will
 * be one. The model's job is to describe the situation, not to decide what
 * happens. Adding a route here would collapse the entire architecture into
 * "an LLM chooses whether to bother you", which is exactly the thing this
 * project exists to avoid.
 *
 * The model proposes. The runtime decides.
 */

/**
 * What kind of utterance this is. The four middle values form the commitment
 * ladder: only `commitment` is strong enough evidence to write to a calendar.
 * A proposal ("padel Sunday?") is not a plan, and treating it as one is how
 * naive extractors fill your calendar with events you never agreed to.
 */
export type SpeechAct =
  | 'banter'
  | 'question'
  | 'proposal'
  | 'agreement'
  | 'commitment'
  | 'alert';

/**
 * How much damage is done by making this wait. This is the primary input to
 * cost, and it is deliberately about consequence rather than about how loudly
 * the message was typed. Someone shouting URGENT about a trivial question has
 * a consequence of `none`.
 */
export type ConsequenceOfDelay = 'none' | 'minor' | 'moderate' | 'severe';

export type PerceptionEnvelope = {
  messageId: string;
  speechAct: SpeechAct;
  /** Is THIS user specifically required, or is this addressed to the group? */
  actionRequired: boolean;
  /** ISO 8601 UTC, or null when the message implies no deadline. */
  deadline: string | null;
  consequenceOfDelay: ConsequenceOfDelay;
  /** Short human-readable subject, for the dashboard. */
  topic: string;
  /** 0..1. Scales cost, so an unsure model interrupts less. */
  confidence: number;
  /** One line, required, never empty. Enforced by validation. */
  reason: string;
};

export class EnvelopeValidationError extends Error {}

/**
 * Guards the contract at runtime, because the model is an untrusted producer.
 * A malformed envelope must fail loudly rather than silently routing at a
 * default cost.
 */
export function assertValidEnvelope(
  value: unknown,
): asserts value is PerceptionEnvelope {
  const e = value as Partial<PerceptionEnvelope> & Record<string, unknown>;

  if (typeof e !== 'object' || e === null) {
    throw new EnvelopeValidationError('envelope must be an object');
  }
  if (typeof e.messageId !== 'string' || e.messageId.length === 0) {
    throw new EnvelopeValidationError('messageId is required');
  }
  if (typeof e.reason !== 'string' || e.reason.trim().length === 0) {
    throw new EnvelopeValidationError(
      'reason is required and must not be empty: every decision has to be explainable',
    );
  }
  if (typeof e.confidence !== 'number' || e.confidence < 0 || e.confidence > 1) {
    throw new EnvelopeValidationError('confidence must be between 0 and 1');
  }
  if (typeof e.actionRequired !== 'boolean') {
    throw new EnvelopeValidationError('actionRequired must be a boolean');
  }
  if (e.deadline !== null && typeof e.deadline !== 'string') {
    throw new EnvelopeValidationError('deadline must be an ISO string or null');
  }
  if ('route' in e) {
    throw new EnvelopeValidationError(
      'perception must not emit a route: the model proposes, the runtime decides',
    );
  }
}
