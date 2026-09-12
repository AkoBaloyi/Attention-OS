/**
 * The three reference scenarios, as data, with the perception each message is
 * expected to produce.
 *
 * These live here rather than inside the tests, the injector or the dashboard so
 * that the thing being demonstrated and the thing being verified cannot drift
 * apart. If the demo shows a cost the test suite has never asserted, the demo is
 * unverified. One file, one source.
 *
 * `channelKey` and `authorKey` are symbolic. The injector resolves them to real
 * channel ids and posting identities from configuration, which is what lets the
 * same scenario run against whatever workspace you happen to have.
 *
 * Deadlines are stored as offsets, not instants. "In 12 minutes" has to mean 12
 * minutes from whenever the scenario actually runs, and hardcoding 14:42 would
 * make the demo work only between 14:30 and 14:42.
 */

import type { Platform } from '../contracts/message.ts';
import type {
  ConsequenceOfDelay,
  SpeechAct,
} from '../contracts/envelope.ts';

/** The reading a correct perception layer should produce for a message. */
export type ExpectedPerception = {
  speechAct: SpeechAct;
  actionRequired: boolean;
  /** Milliseconds from the moment the message arrives, or null for no deadline. */
  deadlineOffsetMs: number | null;
  consequenceOfDelay: ConsequenceOfDelay;
  topic: string;
  confidence: number;
  reason: string;
};

export type ScenarioMessage = {
  platform: Platform;
  /** Symbolic channel, resolved to a real id by the injector. */
  channelKey: string;
  /** Symbolic author, resolved to a posting identity by the injector. */
  authorKey: string;
  text: string;
  /** Milliseconds after the scenario starts. Controlled timing is the point:
   * the cross-platform choice depends on two messages landing seconds apart,
   * and typing fast in two windows on camera is not a plan. */
  delayMs: number;
  /** True when the message is addressed to the instance owner directly. */
  mentionsOwner?: boolean;
  /** What perception should read from this. Replayed by the scripted perceiver
   * when no API key is configured, and asserted by the scenario tests. */
  perception: ExpectedPerception;
};

export type Scenario = {
  id: string;
  title: string;
  /** The claim this scenario exists to support. Rendered on the dashboard so a
   * judge reads the argument rather than being told it. */
  proves: string;
  messages: readonly ScenarioMessage[];
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const SCENARIO_A: Scenario = {
  id: 'A',
  title: 'Work wins',
  proves:
    'Two messages land seconds apart on different platforms. The budget covers one. The production incident interrupts and spends the whole budget, so the dinner question is displaced to the digest.',
  messages: [
    {
      platform: 'slack',
      channelKey: 'incidents',
      authorKey: 'colleague',
      text: 'Approve the production rollback, we are at 30% errors, deadline in 12 minutes.',
      delayMs: 0,
      mentionsOwner: true,
      perception: {
        speechAct: 'alert',
        actionRequired: true,
        deadlineOffsetMs: 12 * MINUTE,
        consequenceOfDelay: 'severe',
        topic: 'production rollback approval',
        confidence: 0.96,
        reason:
          'Production is failing and the rollback needs your approval within 12 minutes.',
      },
    },
    {
      platform: 'discord',
      channelKey: 'family',
      authorKey: 'aunt',
      text: "Dinner's at 7 tonight btw, are you still coming?",
      delayMs: 2500,
      mentionsOwner: true,
      perception: {
        speechAct: 'question',
        actionRequired: true,
        // Tonight, comfortably past the next hourly release.
        deadlineOffsetMs: 4 * HOUR,
        consequenceOfDelay: 'moderate',
        topic: 'dinner attendance',
        confidence: 0.95,
        reason: 'Your aunt needs a headcount for dinner tonight.',
      },
    },
  ],
};

export const SCENARIO_B: Scenario = {
  id: 'B',
  title: 'The reversal',
  proves:
    'Same formula, untouched, and now social wins decisively. This exists because the first thing a sceptic thinks during Scenario A is that work was hardcoded above social. It was not.',
  messages: [
    {
      platform: 'discord',
      channelKey: 'family',
      authorKey: 'aunt',
      text: 'Dinner starts in 5 minutes and everyone is waiting for you.',
      delayMs: 0,
      mentionsOwner: true,
      perception: {
        speechAct: 'alert',
        actionRequired: true,
        deadlineOffsetMs: 5 * MINUTE,
        consequenceOfDelay: 'severe',
        topic: 'dinner has started',
        confidence: 0.9,
        reason: 'Dinner has started and the family is waiting on you specifically.',
      },
    },
    {
      platform: 'slack',
      channelKey: 'dev',
      authorKey: 'colleague',
      text: 'When you get a chance, can you review my PR?',
      delayMs: 2500,
      mentionsOwner: true,
      perception: {
        speechAct: 'question',
        actionRequired: true,
        deadlineOffsetMs: null,
        consequenceOfDelay: 'moderate',
        topic: 'PR review',
        confidence: 0.9,
        reason: 'A colleague wants a code review, with no stated deadline.',
      },
    },
  ],
};

export const SCENARIO_C: Scenario = {
  id: 'C',
  title: 'The refusal',
  proves:
    'Volume is not an input. Nothing breaks if this waits, so the cost is zero and it is held silently, with the reason recorded as no consequence following from delay.',
  messages: [
    {
      platform: 'slack',
      channelKey: 'dev',
      authorKey: 'colleague',
      text: "URGENT!!! what's your favourite colour",
      delayMs: 0,
      mentionsOwner: true,
      perception: {
        speechAct: 'question',
        actionRequired: true,
        deadlineOffsetMs: null,
        consequenceOfDelay: 'none',
        topic: 'favourite colour',
        confidence: 0.94,
        reason: 'No consequence follows from delaying this.',
      },
    },
  ],
};

/**
 * The quiet one. No interruption, no confirmation. Only `commitment` on the
 * speech-act ladder is strong enough to write to a calendar, so the proposal
 * here must produce nothing and the commitment must produce the event.
 * The best agent behaviour is the behaviour you never notice.
 */
export const SCENARIO_D: Scenario = {
  id: 'D',
  title: 'The commitment nobody noticed',
  proves:
    'A proposal is not a plan, so it writes nothing. A commitment is, so it is captured without spending any attention at all.',
  messages: [
    {
      platform: 'discord',
      channelKey: 'friends',
      authorKey: 'friend',
      text: 'anyone up for padel sunday?',
      delayMs: 0,
      perception: {
        speechAct: 'proposal',
        actionRequired: false,
        deadlineOffsetMs: null,
        consequenceOfDelay: 'none',
        topic: 'padel on Sunday',
        confidence: 0.88,
        reason: 'Someone is floating a plan that nobody has agreed to yet.',
      },
    },
    {
      platform: 'slack',
      channelKey: 'dev',
      authorKey: 'colleague',
      text: "I'll send you the report tomorrow morning.",
      delayMs: 2000,
      perception: {
        speechAct: 'commitment',
        actionRequired: false,
        deadlineOffsetMs: 18 * HOUR,
        consequenceOfDelay: 'minor',
        topic: 'report due tomorrow',
        confidence: 0.92,
        reason: 'A colleague has committed to sending a report tomorrow morning.',
      },
    },
  ],
};

export const SCENARIOS: readonly Scenario[] = [
  SCENARIO_A,
  SCENARIO_B,
  SCENARIO_C,
  SCENARIO_D,
];

export function findScenario(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id.toLowerCase() === id.toLowerCase());
}

/** Every reference message, flattened. Used by the scripted perceiver. */
export function allScenarioMessages(): readonly ScenarioMessage[] {
  return SCENARIOS.flatMap((s) => s.messages);
}
