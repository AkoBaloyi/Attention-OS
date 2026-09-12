/**
 * The three reference scenarios, asserted against a frozen clock.
 *
 * These are the demo. They are also the calibration of the cost model: if you
 * change a constant in src/policy/cost.ts and these still pass, the change was
 * safe. If they fail, the demo is broken, not the test.
 *
 * The clock is frozen at 14:30 UTC, so nextDigestAt is 15:00 UTC. Do not switch
 * these to wall-clock time. A deadline "in 12 minutes" evaluated at 14:58 falls
 * AFTER the next release, the deadline multiplier never applies, and Scenario A
 * silently inverts.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { CanonicalMessage, RelationshipTier } from '../src/contracts/message.ts';
import type { PerceptionEnvelope } from '../src/contracts/envelope.ts';
import { assertValidEnvelope } from '../src/contracts/envelope.ts';
import {
  buildEvaluationContext,
  frozenClock,
  BUDGET_CEILING_FOCUS,
} from '../src/contracts/context.ts';
import { decide } from '../src/policy/engine.ts';

const NOW = '2026-09-12T14:30:00.000Z';
const clock = frozenClock(NOW);

function msg(
  overrides: Partial<CanonicalMessage> & Pick<CanonicalMessage, 'id' | 'platform' | 'relationshipTier'>,
): CanonicalMessage {
  return {
    channelId: 'c1',
    channelName: 'general',
    personId: 'person:default',
    text: '',
    timestamp: NOW,
    threadId: null,
    mentionsUser: true,
    ...overrides,
  };
}

function envelope(overrides: Partial<PerceptionEnvelope>): PerceptionEnvelope {
  return {
    messageId: 'm1',
    speechAct: 'question',
    actionRequired: true,
    deadline: null,
    consequenceOfDelay: 'moderate',
    topic: 'unspecified',
    confidence: 0.9,
    reason: 'placeholder reason',
    ...overrides,
  };
}

/** Focus mode, full budget. */
function focusContext(budgetRemaining = BUDGET_CEILING_FOCUS) {
  return buildEvaluationContext({ clock, focusActive: true, budgetRemaining });
}

describe('the evaluation context is computed in exactly one place', () => {
  test('nextDigestAt is the top of the next hour, derived from the frozen clock', () => {
    const ctx = focusContext();
    assert.equal(ctx.now, NOW);
    assert.equal(ctx.nextDigestAt, '2026-09-12T15:00:00.000Z');
  });

  test('focus mode lowers the ceiling and clamps the remaining budget to it', () => {
    const ctx = buildEvaluationContext({
      clock,
      focusActive: true,
      budgetRemaining: 99,
    });
    assert.equal(ctx.budgetCeiling, 3.0);
    assert.equal(ctx.budgetRemaining, 3.0);
  });
});

describe('Scenario A: work wins', () => {
  const slack = msg({
    id: 'slack:A1',
    platform: 'slack',
    relationshipTier: 'work',
    personId: 'person:colleague',
    channelName: 'incidents',
    text: 'Approve the production rollback, we are at 30% errors, deadline in 12 minutes.',
  });
  const slackEnvelope = envelope({
    messageId: 'slack:A1',
    speechAct: 'alert',
    actionRequired: true,
    deadline: '2026-09-12T14:42:00.000Z', // 12 minutes out, before the 15:00 digest
    consequenceOfDelay: 'severe',
    topic: 'production rollback approval',
    confidence: 0.96,
    reason: 'Production is failing and the rollback needs your approval within 12 minutes.',
  });

  const discord = msg({
    id: 'discord:A2',
    platform: 'discord',
    relationshipTier: 'inner',
    personId: 'person:aunt',
    channelName: 'family',
    text: "Dinner's at 7 tonight btw, are you still coming?",
  });
  const discordEnvelope = envelope({
    messageId: 'discord:A2',
    speechAct: 'question',
    actionRequired: true,
    deadline: '2026-09-12T19:00:00.000Z', // after the next digest
    consequenceOfDelay: 'moderate',
    topic: 'dinner attendance',
    confidence: 0.95,
    reason: 'Your aunt needs a headcount for dinner tonight.',
  });

  test('the production rollback costs 8.64 and interrupts', () => {
    const d = decide(slack, slackEnvelope, focusContext());
    assert.equal(d.cost, 8.64);
    assert.equal(d.route, 'push');
    assert.equal(d.basis, 'non_discretionary');
  });

  test('it overrides the budget even though 8.64 exceeds the 3.0 ceiling', () => {
    const d = decide(slack, slackEnvelope, focusContext());
    assert.ok(d.cost > d.budgetBefore, 'cost must exceed the budget for this to prove anything');
    assert.equal(d.route, 'push');
    assert.equal(d.budgetAfter, 0, 'and it spends the whole budget doing so');
  });

  test('the dinner question costs 2.85', () => {
    const d = decide(discord, discordEnvelope, focusContext());
    assert.equal(d.cost, 2.85);
  });

  test('on a full budget the dinner question would have reached you', () => {
    const d = decide(discord, discordEnvelope, focusContext(3.0));
    assert.equal(d.route, 'push');
    assert.equal(d.basis, 'discretionary_within_budget');
  });

  test('but after the rollback spent the budget, it drops to the digest', () => {
    const first = decide(slack, slackEnvelope, focusContext());
    const second = decide(discord, discordEnvelope, focusContext(first.budgetAfter));

    assert.equal(first.route, 'push');
    assert.equal(second.route, 'digest');
    assert.equal(second.basis, 'discretionary_budget_exhausted');
  });
});

describe('Scenario B: the reversal, social wins', () => {
  const discord = msg({
    id: 'discord:B1',
    platform: 'discord',
    relationshipTier: 'inner',
    personId: 'person:aunt',
    channelName: 'family',
    text: 'Dinner starts in 5 minutes and everyone is waiting for you.',
  });
  const discordEnvelope = envelope({
    messageId: 'discord:B1',
    speechAct: 'alert',
    actionRequired: true,
    deadline: '2026-09-12T14:35:00.000Z', // 5 minutes out
    consequenceOfDelay: 'severe',
    topic: 'dinner has started',
    confidence: 0.9,
    reason: 'Dinner has started and the family is waiting on you specifically.',
  });

  const slack = msg({
    id: 'slack:B2',
    platform: 'slack',
    relationshipTier: 'work',
    personId: 'person:colleague',
    channelName: 'dev',
    text: 'When you get a chance, can you review my PR?',
  });
  const slackEnvelope = envelope({
    messageId: 'slack:B2',
    speechAct: 'question',
    actionRequired: true,
    deadline: null,
    consequenceOfDelay: 'moderate',
    topic: 'PR review',
    confidence: 0.9,
    reason: 'A colleague wants a code review, with no stated deadline.',
  });

  test('the same untouched formula now favours Discord: 12.15 against 1.8', () => {
    const d1 = decide(discord, discordEnvelope, focusContext());
    const d2 = decide(slack, slackEnvelope, focusContext());

    assert.equal(d1.cost, 12.15);
    assert.equal(d2.cost, 1.8);
    assert.ok(d1.cost > d2.cost * 6, 'social should win decisively, not narrowly');
  });

  test('Discord interrupts and the PR review defers', () => {
    const first = decide(discord, discordEnvelope, focusContext());
    const second = decide(slack, slackEnvelope, focusContext(first.budgetAfter));

    assert.equal(first.route, 'push');
    assert.equal(second.route, 'digest');
    assert.equal(second.basis, 'discretionary_budget_exhausted');
  });

  test('nothing in the engine can see which platform a message came from', () => {
    // Same envelope, same tier, opposite platforms. Identical outcome.
    const asSlack = decide(
      msg({ id: 'x', platform: 'slack', relationshipTier: 'inner' }),
      envelope({ messageId: 'x' }),
      focusContext(),
    );
    const asDiscord = decide(
      msg({ id: 'x', platform: 'discord', relationshipTier: 'inner' }),
      envelope({ messageId: 'x' }),
      focusContext(),
    );
    assert.equal(asSlack.cost, asDiscord.cost);
    assert.equal(asSlack.route, asDiscord.route);
  });
});

describe('Scenario C: the refusal', () => {
  const shouty = msg({
    id: 'slack:C1',
    platform: 'slack',
    relationshipTier: 'work',
    personId: 'person:colleague',
    text: "URGENT!!! what's your favourite colour",
  });
  const shoutyEnvelope = envelope({
    messageId: 'slack:C1',
    speechAct: 'question',
    actionRequired: true,
    deadline: null,
    consequenceOfDelay: 'none',
    topic: 'favourite colour',
    confidence: 0.94,
    reason: 'No consequence follows from delaying this.',
  });

  test('shouting is not an input: cost 0, held', () => {
    const d = decide(shouty, shoutyEnvelope, focusContext());
    assert.equal(d.cost, 0);
    assert.equal(d.route, 'hold');
    assert.equal(d.basis, 'below_threshold');
  });

  test('holding costs no budget', () => {
    const d = decide(shouty, shoutyEnvelope, focusContext());
    assert.equal(d.budgetAfter, d.budgetBefore);
  });
});

describe('cost model branches the reference scenarios do not reach', () => {
  test('an imminent deadline floors a merely moderate consequence at 8', () => {
    const m = msg({ id: 'z', platform: 'slack', relationshipTier: 'work' });
    const e = envelope({
      messageId: 'z',
      consequenceOfDelay: 'moderate', // base 2, x1.5 = 3, below the floor
      deadline: '2026-09-12T14:40:00.000Z', // 10 minutes out
      confidence: 1,
    });
    const d = decide(m, e, focusContext());

    assert.equal(d.breakdown.imminentFloorApplied, true);
    assert.equal(d.cost, 8);
  });

  test('a message the user is not required for is scaled down hard', () => {
    const m = msg({ id: 'z', platform: 'slack', relationshipTier: 'work' });
    const e = envelope({
      messageId: 'z',
      consequenceOfDelay: 'severe',
      actionRequired: false,
      deadline: null,
      confidence: 1,
    });
    // A severe consequence the user is not needed for drops from 6 to 1.2,
    // which lands it in the discretionary band instead of the interrupt band.
    const onFullBudget = decide(m, e, focusContext(3.0));
    assert.equal(onFullBudget.cost, 1.2); // 6 * 0.2 * 1.0 * 1
    assert.equal(onFullBudget.route, 'push');
    assert.equal(onFullBudget.basis, 'discretionary_within_budget');

    // And because it is discretionary, it is the kind of thing a more expensive
    // message can crowd out. A severe consequence you ARE needed for could not be.
    const onSpentBudget = decide(m, e, focusContext(0));
    assert.equal(onSpentBudget.route, 'digest');
  });

  test('a deadline after the next digest gets no multiplier', () => {
    const m = msg({ id: 'z', platform: 'slack', relationshipTier: 'work' });
    const withLateDeadline = decide(
      m,
      envelope({ messageId: 'z', consequenceOfDelay: 'severe', deadline: '2026-09-12T23:00:00.000Z', confidence: 1 }),
      focusContext(),
    );
    assert.equal(withLateDeadline.breakdown.deadlineMultiplier, 1);
    assert.equal(withLateDeadline.cost, 6);
  });

  test('the call rung only engages when explicitly enabled', () => {
    const m = msg({ id: 'z', platform: 'discord', relationshipTier: 'inner' });
    const e = envelope({
      messageId: 'z',
      consequenceOfDelay: 'severe',
      deadline: '2026-09-12T14:35:00.000Z',
      confidence: 0.9,
    });

    const withoutCall = decide(m, e, focusContext());
    const withCall = decide(m, e, focusContext(), { callEnabled: true });

    assert.equal(withoutCall.route, 'push', 'stretch feature off: renders as a loud push');
    assert.equal(withCall.route, 'call');
    assert.equal(withoutCall.cost, withCall.cost, 'and the cost model is unchanged either way');
  });

  test('an always-allow rule promotes a held message to a push', () => {
    const m = msg({
      id: 'z',
      platform: 'discord',
      relationshipTier: 'other',
      personId: 'person:mum',
    });
    const e = envelope({ messageId: 'z', consequenceOfDelay: 'none' });

    const normal = decide(m, e, focusContext());
    const allowed = decide(m, e, focusContext(), {
      alwaysAllowPersonIds: new Set(['person:mum']),
    });

    assert.equal(normal.route, 'hold');
    assert.equal(allowed.route, 'push');
    assert.equal(allowed.basis, 'always_allow_rule');
  });
});

describe('the perception contract is enforced at runtime', () => {
  test('an envelope carrying a route is rejected outright', () => {
    const smuggled = { ...envelope({}), route: 'push' };
    assert.throws(
      () => assertValidEnvelope(smuggled),
      /must not emit a route/,
      'the model proposes, the runtime decides',
    );
  });

  test('an empty reason is rejected, because every decision must be explainable', () => {
    assert.throws(
      () => assertValidEnvelope(envelope({ reason: '   ' })),
      /reason is required/,
    );
  });

  test('confidence outside 0..1 is rejected', () => {
    assert.throws(() => assertValidEnvelope(envelope({ confidence: 1.4 })), /confidence/);
  });

  test('a well-formed envelope passes', () => {
    assert.doesNotThrow(() => assertValidEnvelope(envelope({})));
  });
});
