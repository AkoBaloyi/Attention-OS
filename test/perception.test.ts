/**
 * Perception tests, run against a scripted transport.
 *
 * These verify the seam rather than the model: that the id is attached by us and
 * not by the model, that a smuggled route is rejected, that transient failures
 * retry and contract violations do not, and that the prompt withholds the two
 * signals it must withhold.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { CanonicalMessage } from '../src/contracts/message.ts';
import { frozenClock } from '../src/contracts/context.ts';
import {
  createPerceiver,
  PerceptionError,
  type PerceptionDraft,
  type PerceptionTransport,
} from '../src/perception/perceiver.ts';
import {
  PERCEPTION_SCHEMA,
  PERCEPTION_SYSTEM_PROMPT,
  buildPerceptionInput,
} from '../src/perception/prompt.ts';

const NOW = '2026-09-12T14:30:00.000Z';
const clock = frozenClock(NOW);

const MESSAGE: CanonicalMessage = {
  id: 'slack:A1',
  platform: 'slack',
  channelId: 'C1',
  channelName: 'incidents',
  personId: 'person:colleague',
  relationshipTier: 'work',
  text: 'Approve the production rollback, we are at 30% errors, deadline in 12 minutes.',
  timestamp: NOW,
  threadId: null,
  mentionsUser: true,
};

const GOOD_DRAFT: PerceptionDraft = {
  speechAct: 'alert',
  actionRequired: true,
  deadline: '2026-09-12T14:42:00.000Z',
  consequenceOfDelay: 'severe',
  topic: 'production rollback approval',
  confidence: 0.96,
  reason: 'Production is failing and the rollback needs your approval within 12 minutes.',
};

/** Returns each scripted response in turn; throws the value if it is an Error. */
function scriptedTransport(...responses: unknown[]): PerceptionTransport & { calls: number; lastUser?: string } {
  const state = {
    calls: 0,
    lastUser: undefined as string | undefined,
    async complete({ user }: { system: string; user: string; schema: unknown }) {
      state.lastUser = user;
      const next = responses[Math.min(state.calls, responses.length - 1)];
      state.calls++;
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return state;
}

describe('the runtime owns the message id, not the model', () => {
  test('messageId is attached from the message, never taken from the model', async () => {
    // The model returns a draft with no id at all, which is the whole point.
    const transport = scriptedTransport(GOOD_DRAFT);
    const envelope = await createPerceiver({ transport, clock }).perceive(MESSAGE);

    assert.equal(envelope.messageId, 'slack:A1');
  });

  test('a model that volunteers a wrong id cannot override ours', async () => {
    const transport = scriptedTransport({ ...GOOD_DRAFT, messageId: 'discord:WRONG' });
    const envelope = await createPerceiver({ transport, clock }).perceive(MESSAGE);

    assert.equal(envelope.messageId, 'slack:A1');
  });
});

describe('the contract is enforced at the boundary', () => {
  test('a model returning a route is rejected and not retried', async () => {
    const transport = scriptedTransport({ ...GOOD_DRAFT, route: 'push' });
    const perceiver = createPerceiver({ transport, clock, retries: 3 });

    await assert.rejects(() => perceiver.perceive(MESSAGE), PerceptionError);
    assert.equal(transport.calls, 1, 'a contract violation will not fix itself on retry');
  });

  test('an empty reason is rejected', async () => {
    const transport = scriptedTransport({ ...GOOD_DRAFT, reason: '  ' });
    await assert.rejects(
      () => createPerceiver({ transport, clock, retries: 0 }).perceive(MESSAGE),
      /reason is required/,
    );
  });
});

describe('failure handling', () => {
  test('a transient transport failure is retried', async () => {
    const transport = scriptedTransport(new Error('socket hang up'), GOOD_DRAFT);
    const envelope = await createPerceiver({ transport, clock, retries: 1 }).perceive(MESSAGE);

    assert.equal(transport.calls, 2);
    assert.equal(envelope.consequenceOfDelay, 'severe');
  });

  test('exhausting retries fails loudly rather than routing at a default cost', async () => {
    const transport = scriptedTransport(new Error('gateway timeout'));
    await assert.rejects(
      () => createPerceiver({ transport, clock, retries: 2 }).perceive(MESSAGE),
      /perception failed for slack:A1 after 3 attempt/,
    );
    assert.equal(transport.calls, 3);
  });
});

describe('normalisation of things the schema cannot catch', () => {
  test('an unparseable deadline becomes null rather than silently skipping the multiplier', async () => {
    const transport = scriptedTransport({ ...GOOD_DRAFT, deadline: 'next Tuesday-ish' });
    const envelope = await createPerceiver({ transport, clock }).perceive(MESSAGE);

    assert.equal(envelope.deadline, null);
  });

  test('confidence is clamped into range', async () => {
    const transport = scriptedTransport({ ...GOOD_DRAFT, confidence: 1 });
    const envelope = await createPerceiver({ transport, clock }).perceive(MESSAGE);
    assert.equal(envelope.confidence, 1);
  });
});

describe('the prompt withholds what it must withhold', () => {
  test('the model is never told the platform or the relationship tier', async () => {
    const transport = scriptedTransport(GOOD_DRAFT);
    await createPerceiver({ transport, clock }).perceive(MESSAGE);

    const sent = transport.lastUser ?? '';
    assert.doesNotMatch(sent, /slack/i, 'policy is platform-blind; perception must not reintroduce the signal');
    assert.doesNotMatch(sent, /\bwork\b/i, 'tier is already a cost multiplier; showing it here double-counts closeness');
  });

  test('the model is given the current time so relative deadlines resolve', async () => {
    const rendered = buildPerceptionInput({
      now: NOW,
      channelName: 'incidents',
      mentionsUser: true,
      text: 'deadline in 12 minutes',
    });
    assert.match(rendered, /CURRENT TIME \(UTC\): 2026-09-12T14:30:00\.000Z/);
  });

  test('the schema exposes no route field and forbids extra properties', () => {
    assert.equal('route' in PERCEPTION_SCHEMA.properties, false);
    assert.equal(PERCEPTION_SCHEMA.additionalProperties, false);
    assert.equal('messageId' in PERCEPTION_SCHEMA.properties, false);
  });

  test('the system prompt states the rule in the model\'s own instructions', () => {
    assert.match(PERCEPTION_SYSTEM_PROMPT, /never decide what happens/i);
    assert.match(PERCEPTION_SYSTEM_PROMPT, /not how the message is worded/i);
  });

  test('the prompt carries no few-shot examples', () => {
    // Few-shot teaches the model to pattern-match on the samples and miss
    // everything that does not resemble them. Guard against it drifting back in.
    assert.doesNotMatch(PERCEPTION_SYSTEM_PROMPT, /^EXAMPLE/im);
    assert.doesNotMatch(PERCEPTION_SYSTEM_PROMPT, /for example, if someone says/i);
  });
});
