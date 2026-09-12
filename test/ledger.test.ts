/**
 * Ledger and runtime tests.
 *
 * The important one is the last suite: Scenario A driven end to end with the
 * budget derived from persisted rows rather than passed in by hand. That is what
 * proves the displacement story is a property of the system and not an artefact
 * of the unit tests setting up the numbers they wanted.
 */

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CanonicalMessage } from '../src/contracts/message.ts';
import type { PerceptionEnvelope } from '../src/contracts/envelope.ts';
import {
  frozenClock,
  computeNextDigestAt,
  ceilingFor,
  BUDGET_CEILING_FOCUS,
} from '../src/contracts/context.ts';
import { Ledger } from '../src/store/ledger.ts';
import { evaluateMessage } from '../src/runtime/evaluate.ts';

const NOW = '2026-09-12T14:30:00.000Z';
const clock = frozenClock(NOW);
const WINDOW = computeNextDigestAt(clock); // 15:00:00.000Z

const openLedgers: Ledger[] = [];
const tempDirs: string[] = [];

function ledger(path = ':memory:'): Ledger {
  const l = new Ledger(path);
  openLedgers.push(l);
  return l;
}

afterEach(() => {
  while (openLedgers.length) openLedgers.pop()?.close();
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function msg(o: Partial<CanonicalMessage> & Pick<CanonicalMessage, 'id' | 'platform' | 'relationshipTier'>): CanonicalMessage {
  return {
    channelId: 'c1',
    channelName: 'general',
    personId: 'person:default',
    text: 'hello',
    timestamp: NOW,
    threadId: null,
    mentionsUser: true,
    ...o,
  };
}

function env(o: Partial<PerceptionEnvelope> & Pick<PerceptionEnvelope, 'messageId'>): PerceptionEnvelope {
  return {
    speechAct: 'question',
    actionRequired: true,
    deadline: null,
    consequenceOfDelay: 'moderate',
    topic: 'unspecified',
    confidence: 0.9,
    reason: 'placeholder reason',
    ...o,
  };
}

// The two Scenario A messages, as the runtime would receive them.
const ROLLBACK = msg({
  id: 'slack:A1',
  platform: 'slack',
  relationshipTier: 'work',
  personId: 'person:colleague',
  channelName: 'incidents',
  text: 'Approve the production rollback, we are at 30% errors, deadline in 12 minutes.',
});
const ROLLBACK_ENV = env({
  messageId: 'slack:A1',
  speechAct: 'alert',
  deadline: '2026-09-12T14:42:00.000Z',
  consequenceOfDelay: 'severe',
  topic: 'production rollback approval',
  confidence: 0.96,
  reason: 'Production is failing and the rollback needs your approval within 12 minutes.',
});

const DINNER = msg({
  id: 'discord:A2',
  platform: 'discord',
  relationshipTier: 'inner',
  personId: 'person:aunt',
  channelName: 'family',
  text: "Dinner's at 7 tonight btw, are you still coming?",
});
const DINNER_ENV = env({
  messageId: 'discord:A2',
  deadline: '2026-09-12T19:00:00.000Z',
  confidence: 0.95,
  topic: 'dinner attendance',
  reason: 'Your aunt needs a headcount for dinner tonight.',
});

describe('the ledger round-trips a decision without losing anything', () => {
  test('a recorded decision reads back identical', () => {
    const l = ledger();
    const d = evaluateMessage({ ledger: l, clock, focusActive: true }, ROLLBACK, ROLLBACK_ENV);

    const [entry] = l.recent();
    assert.ok(entry);
    assert.deepEqual(entry.message, ROLLBACK);
    assert.deepEqual(entry.decision, d);
  });

  test('the row carries enough context to re-derive the cost by hand', () => {
    const l = ledger();
    evaluateMessage({ ledger: l, clock, focusActive: true }, ROLLBACK, ROLLBACK_ENV);

    const [entry] = l.recent();
    const { breakdown, context } = entry!.decision;

    // base 6, deadline before the 15:00 release so x1.5, work tier x1.0, x0.96
    assert.equal(breakdown.base, 6);
    assert.equal(breakdown.deadlineMultiplier, 1.5);
    assert.equal(breakdown.tierMultiplier, 1);
    assert.equal(breakdown.confidence, 0.96);
    assert.equal(context.nextDigestAt, WINDOW);
    assert.equal(
      Math.round(breakdown.base * breakdown.deadlineMultiplier * breakdown.tierMultiplier * breakdown.confidence * 100) / 100,
      entry!.decision.cost,
    );
  });
});

describe('the budget is derived from rows, not from memory', () => {
  test('spend is what was drawn, not raw cost', () => {
    const l = ledger();
    // 8.64 against a 3.0 ceiling can only ever draw 3.0.
    const d = evaluateMessage({ ledger: l, clock, focusActive: true }, ROLLBACK, ROLLBACK_ENV);

    assert.equal(d.cost, 8.64);
    assert.equal(l.spentInWindow(WINDOW), 3.0);
    assert.equal(l.remainingInWindow(WINDOW, BUDGET_CEILING_FOCUS), 0);
  });

  test('holding draws nothing', () => {
    const l = ledger();
    evaluateMessage(
      { ledger: l, clock, focusActive: true },
      msg({ id: 'x', platform: 'slack', relationshipTier: 'work' }),
      env({ messageId: 'x', consequenceOfDelay: 'none', reason: 'no consequence follows from delay' }),
    );

    assert.equal(l.spentInWindow(WINDOW), 0);
    assert.equal(l.remainingInWindow(WINDOW, BUDGET_CEILING_FOCUS), 3.0);
  });

  test('reprocessing the same message does not draw the budget twice', () => {
    const l = ledger();
    const runtime = { ledger: l, clock, focusActive: true };

    evaluateMessage(runtime, DINNER, DINNER_ENV);
    const firstSpend = l.spentInWindow(WINDOW);

    evaluateMessage(runtime, DINNER, DINNER_ENV);
    evaluateMessage(runtime, DINNER, DINNER_ENV);

    assert.equal(l.spentInWindow(WINDOW), firstSpend, 'a retry must not eat your attention');
    assert.equal(l.recent().length, 1);
  });

  test('spend survives a restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'attention-os-'));
    tempDirs.push(dir);
    const path = join(dir, 'ledger.sqlite');

    const first = new Ledger(path);
    evaluateMessage({ ledger: first, clock, focusActive: true }, ROLLBACK, ROLLBACK_ENV);
    const spentBefore = first.spentInWindow(WINDOW);
    first.close();

    const reopened = ledger(path);
    assert.equal(reopened.spentInWindow(WINDOW), spentBefore);
    assert.equal(reopened.remainingInWindow(WINDOW, BUDGET_CEILING_FOCUS), 0);
  });
});

describe('Scenario A end to end, budget derived from the ledger', () => {
  test('the rollback interrupts and the dinner question is displaced', () => {
    const l = ledger();
    const runtime = { ledger: l, clock, focusActive: true };

    // Nothing is passed in by hand. The second decision sees whatever the first
    // one left behind, read back out of sqlite.
    const rollback = evaluateMessage(runtime, ROLLBACK, ROLLBACK_ENV);
    const dinner = evaluateMessage(runtime, DINNER, DINNER_ENV);

    assert.equal(rollback.cost, 8.64);
    assert.equal(rollback.route, 'push');
    assert.equal(rollback.basis, 'non_discretionary');

    assert.equal(dinner.cost, 2.85);
    assert.equal(dinner.route, 'digest');
    assert.equal(dinner.basis, 'discretionary_budget_exhausted');
    assert.equal(dinner.budgetBefore, 0, 'the rollback had already spent it');
  });

  test('reverse the order and the dinner question gets through', () => {
    // Same two messages, same costs, opposite arrival order. The dinner
    // question is discretionary and 2.85 fits inside 3.0, so on a quiet
    // afternoon it reaches you. This is what makes the displacement real
    // rather than the dinner simply being unimportant.
    const l = ledger();
    const runtime = { ledger: l, clock, focusActive: true };

    const dinner = evaluateMessage(runtime, DINNER, DINNER_ENV);
    const rollback = evaluateMessage(runtime, ROLLBACK, ROLLBACK_ENV);

    assert.equal(dinner.route, 'push');
    assert.equal(dinner.basis, 'discretionary_within_budget');
    assert.equal(rollback.route, 'push', 'and the rollback still overrides what little is left');
  });

  test('the counters tell the story the demo closes on', () => {
    const l = ledger();
    const runtime = { ledger: l, clock, focusActive: true };

    evaluateMessage(runtime, ROLLBACK, ROLLBACK_ENV);
    evaluateMessage(runtime, DINNER, DINNER_ENV);
    for (let i = 0; i < 6; i++) {
      evaluateMessage(
        runtime,
        msg({ id: `discord:noise${i}`, platform: 'discord', relationshipTier: 'other' }),
        env({ messageId: `discord:noise${i}`, consequenceOfDelay: 'none', reason: 'banter' }),
      );
    }

    const c = l.counters(WINDOW, ceilingFor(true));
    assert.equal(c.received, 8);
    assert.equal(c.held, 6);
    assert.equal(c.digested, 1);
    assert.equal(c.interrupted, 1);
    assert.equal(c.remaining, 0);
    assert.equal(c.ceiling, 3.0);
  });

  test('the digest contains deferred items only, never held ones', () => {
    const l = ledger();
    const runtime = { ledger: l, clock, focusActive: true };

    evaluateMessage(runtime, ROLLBACK, ROLLBACK_ENV); // push
    evaluateMessage(runtime, DINNER, DINNER_ENV); // digest
    evaluateMessage(
      runtime,
      msg({ id: 'x', platform: 'slack', relationshipTier: 'work' }),
      env({ messageId: 'x', consequenceOfDelay: 'none', reason: 'no consequence follows from delay' }),
    ); // hold

    const digest = l.digestFor(WINDOW);
    assert.equal(digest.length, 1);
    assert.equal(digest[0]?.message.id, 'discord:A2');
  });
});

describe('the funnel refuses to be bypassed quietly', () => {
  test('an envelope for a different message is rejected', () => {
    const l = ledger();
    assert.throws(
      () => evaluateMessage({ ledger: l, clock, focusActive: true }, DINNER, ROLLBACK_ENV),
      /mismatch/,
    );
  });

  test('an envelope smuggling a route is rejected before anything is recorded', () => {
    const l = ledger();
    const smuggled = { ...DINNER_ENV, route: 'call' } as PerceptionEnvelope;

    assert.throws(
      () => evaluateMessage({ ledger: l, clock, focusActive: true }, DINNER, smuggled),
      /must not emit a route/,
    );
    assert.equal(l.recent().length, 0, 'and nothing was persisted');
  });
});
