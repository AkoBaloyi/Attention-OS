/**
 * End to end: every reference scenario driven through the real pipeline, plus the
 * HTTP surface the dashboard depends on.
 *
 * This is the test that ties the demo to the verification. The scenario texts,
 * the expected perception and the asserted costs all come from
 * src/scenarios/reference.ts, which is the same file the injector posts from and
 * the same file the scripted perceiver replays. If any of those drift, this fails.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';

import type { CanonicalMessage } from '../src/contracts/message.ts';
import { frozenClock, computeNextDigestAt, ceilingFor } from '../src/contracts/context.ts';
import { IdentityDirectory, type PersonMapping } from '../src/adapters/identity.ts';
import { createPerceiver } from '../src/perception/perceiver.ts';
import { scriptedTransport } from '../src/perception/scripted.ts';
import { Ledger, type LedgerEntry } from '../src/store/ledger.ts';
import { createPipeline } from '../src/runtime/pipeline.ts';
import { createApp } from '../src/server/app.ts';
import {
  SCENARIO_A,
  SCENARIO_B,
  SCENARIO_C,
  SCENARIO_D,
  type Scenario,
  type ScenarioMessage,
} from '../src/scenarios/reference.ts';

const NOW = '2026-09-12T14:30:00.000Z';
const clock = frozenClock(NOW);
const WINDOW = computeNextDigestAt(clock);

const PEOPLE: PersonMapping[] = [
  { personId: 'person:aunt', displayName: 'Aunt', tier: 'inner' },
  { personId: 'person:friend', displayName: 'Friend', tier: 'inner' },
  { personId: 'person:colleague', displayName: 'Colleague', tier: 'work' },
];
const identity = new IdentityDirectory(PEOPLE);

/**
 * Stands in for the adapters, which are tested separately. Produces exactly what
 * `normaliseDiscordMessage` / `normaliseSlackMessage` would for this message.
 */
function toCanonical(m: ScenarioMessage, index: number): CanonicalMessage {
  const resolved = identity.resolveByPersonId(`person:${m.authorKey}`);
  return {
    id: `${m.platform}:e2e-${index}-${m.authorKey}`,
    platform: m.platform,
    channelId: `C_${m.channelKey}`,
    channelName: m.channelKey,
    personId: resolved.personId,
    relationshipTier: resolved.relationshipTier,
    text: m.text,
    timestamp: NOW,
    threadId: null,
    mentionsUser: m.mentionsOwner ?? false,
  };
}

function harness() {
  const ledger = new Ledger(':memory:');
  const pipeline = createPipeline({
    perceiver: createPerceiver({ transport: scriptedTransport({ clock }), clock }),
    ledger,
    clock,
    getFocusActive: () => true, // focus mode: ceiling 3.0
  });
  return { ledger, pipeline };
}

async function runScenario(scenario: Scenario) {
  const { ledger, pipeline } = harness();
  const decisions = [];
  for (const [index, message] of scenario.messages.entries()) {
    // Timing is irrelevant here: the frozen clock means order alone decides.
    decisions.push(await pipeline.ingest(toCanonical(message, index)));
  }
  return { ledger, decisions };
}

describe('Scenario A through the real pipeline', () => {
  test('the rollback interrupts at 8.64 and the dinner question is displaced', async () => {
    const { ledger, decisions } = await runScenario(SCENARIO_A);
    const [rollback, dinner] = decisions;

    assert.ok(rollback && dinner);
    assert.equal(rollback.cost, 8.64);
    assert.equal(rollback.route, 'push');
    assert.equal(rollback.basis, 'non_discretionary');

    assert.equal(dinner.cost, 2.85);
    assert.equal(dinner.route, 'digest');
    assert.equal(dinner.basis, 'discretionary_budget_exhausted');

    const counters = ledger.counters(WINDOW, ceilingFor(true));
    assert.equal(counters.received, 2);
    assert.equal(counters.interrupted, 1);
    assert.equal(counters.digested, 1);
    assert.equal(counters.remaining, 0);

    ledger.close();
  });
});

describe('Scenario B through the real pipeline', () => {
  test('the same formula favours Discord at 12.15 against Slack at 1.8', async () => {
    const { ledger, decisions } = await runScenario(SCENARIO_B);
    const [dinner, pr] = decisions;

    assert.ok(dinner && pr);
    assert.equal(dinner.cost, 12.15);
    assert.equal(dinner.route, 'push');
    assert.equal(pr.cost, 1.8);
    assert.equal(pr.route, 'digest');

    ledger.close();
  });
});

describe('Scenario C through the real pipeline', () => {
  test('shouting scores zero and is held', async () => {
    const { ledger, decisions } = await runScenario(SCENARIO_C);
    const [shouty] = decisions;

    assert.ok(shouty);
    assert.equal(shouty.cost, 0);
    assert.equal(shouty.route, 'hold');
    assert.equal(shouty.envelope.consequenceOfDelay, 'none');

    ledger.close();
  });
});

describe('Scenario D through the real pipeline', () => {
  test('a proposal and a commitment both pass without spending attention', async () => {
    const { ledger, decisions } = await runScenario(SCENARIO_D);
    const [padel, report] = decisions;

    assert.ok(padel && report);
    assert.equal(padel.envelope.speechAct, 'proposal');
    assert.equal(report.envelope.speechAct, 'commitment');

    // Neither interrupts. The commitment is the valuable one and it costs nothing,
    // which is the whole point: the best agent behaviour is unnoticed.
    for (const d of [padel, report]) {
      assert.equal(d.route, 'hold');
      assert.equal(d.budgetBefore, d.budgetAfter);
    }

    assert.equal(ledger.counters(WINDOW, ceilingFor(true)).interrupted, 0);
    ledger.close();
  });
});

describe('the scripted perceiver is honest about the crude path', () => {
  test('an unscripted message gets low confidence and says so', async () => {
    const { pipeline, ledger } = harness();
    const decision = await pipeline.ingest({
      id: 'discord:unscripted',
      platform: 'discord',
      channelId: 'C_friends',
      channelName: 'friends',
      personId: 'person:friend',
      relationshipTier: 'inner',
      text: 'lol did you see that goal',
      timestamp: NOW,
      threadId: null,
      mentionsUser: false,
    });

    assert.ok(decision);
    assert.equal(decision.envelope.confidence, 0.5);
    assert.match(decision.envelope.reason, /stub perception/i);
    assert.equal(decision.route, 'hold');
    ledger.close();
  });
});

describe('the HTTP surface the dashboard depends on', () => {
  let base: string;
  let app: ReturnType<typeof createApp>;
  let ledger: Ledger;

  const getJson = async <T>(path: string): Promise<T> =>
    (await (await fetch(`${base}${path}`)).json()) as T;

  before(async () => {
    const h = harness();
    ledger = h.ledger;
    app = createApp({
      ledger: h.ledger,
      pipeline: h.pipeline,
      focus: { isActive: () => true, set: () => {} },
      clock,
      adapters: () => ({ discord: false, slack: false, perception: 'stub' }),
    });
    await app.listen(0);
    const address = app.server.address() as AddressInfo;
    base = `http://127.0.0.1:${address.port}`;

    for (const [index, message] of SCENARIO_A.messages.entries()) {
      await h.pipeline.ingest(toCanonical(message, index));
    }
  });

  after(async () => {
    await app.close();
    ledger.close();
  });

  test('serves the dashboard page', async () => {
    const res = await fetch(base);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Attention budget/);
    // The pipeline sequence has to be legible on screen, not just in the code.
    for (const stage of ['Perception', 'Cost', 'Budget', 'Route']) {
      assert.match(html, new RegExp(`<h4>${stage}</h4>`));
    }
  });

  test('reports state including the honest adapter status', async () => {
    const state = await getJson<{
      nextDigestAt: string;
      ceiling: number;
      received: number;
      interrupted: number;
      adapters: { perception: string };
    }>('/api/state');

    assert.equal(state.nextDigestAt, WINDOW);
    assert.equal(state.ceiling, 3.0);
    assert.equal(state.received, 2);
    assert.equal(state.interrupted, 1);
    assert.equal(state.adapters.perception, 'stub');
  });

  test('returns decisions newest first with the full audit record', async () => {
    const entries = await getJson<LedgerEntry[]>('/api/decisions');

    assert.equal(entries.length, 2);
    assert.equal(entries[0]?.decision.route, 'digest');
    assert.ok(entries[0]?.decision.breakdown, 'the arithmetic must survive the round trip');
    assert.ok(entries[0]?.decision.context.nextDigestAt);
  });

  test('the digest holds the deferred item only', async () => {
    const digest = await getJson<LedgerEntry[]>('/api/digest');
    assert.equal(digest.length, 1);
    assert.equal(digest[0]?.decision.route, 'digest');
  });

  test('refuses to fake an injection when no credentials are configured', async () => {
    const res = await fetch(`${base}/api/scenario/A`, { method: 'POST' });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /real Discord and Slack APIs by design/);
  });

  test('an unknown scenario is a 404, not a silent no-op', async () => {
    const res = await fetch(`${base}/api/scenario/Z`, { method: 'POST' });
    assert.equal(res.status, 404);
  });

  test('reports scenarioMode so the dashboard can label the source honestly', async () => {
    // Neither injector nor replay wired here, so there is nothing to claim.
    const state = await getJson<{ scenarioMode: string }>('/api/state');
    assert.equal(state.scenarioMode, 'none');
  });

  test('rolling the window restores the ceiling and empties the stream', async () => {
    const before = await getJson<{ spent: number }>('/api/state');
    assert.equal(before.spent, 3.0);

    const rolled = (await (
      await fetch(`${base}/api/window/reset`, { method: 'POST' })
    ).json()) as { cleared: number; spent: number; remaining: number };

    assert.equal(rolled.cleared, 2);
    assert.equal(rolled.spent, 0);
    assert.equal(rolled.remaining, 3.0);
    assert.equal((await getJson<unknown[]>('/api/decisions')).length, 0);
  });

  test('streams decisions over SSE', async () => {
    const controller = new AbortController();
    const res = await fetch(`${base}/api/stream`, { signal: controller.signal });
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    controller.abort();
  });
});
