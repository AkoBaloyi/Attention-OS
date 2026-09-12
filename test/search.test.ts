/**
 * Filtering and search.
 *
 * Two things matter here beyond the obvious. Filters must combine as AND across
 * groups and OR within a group, because that is what a set of toggled chips
 * means. And every value must be bound as a parameter, so a search term that
 * looks like SQL is just an odd string to look for.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';

import { frozenClock, computeNextDigestAt } from '../src/contracts/context.ts';
import { Ledger, type Facets, type LedgerEntry } from '../src/store/ledger.ts';
import { createPipeline } from '../src/runtime/pipeline.ts';
import { createPerceiver } from '../src/perception/perceiver.ts';
import { scriptedTransport } from '../src/perception/scripted.ts';
import { IdentityDirectory } from '../src/adapters/identity.ts';
import { DEMO_PEOPLE, toCanonicalMessage } from '../src/scenarios/replay.ts';
import { SCENARIO_A, SCENARIO_B, SCENARIO_C, SCENARIO_D } from '../src/scenarios/reference.ts';
import { createApp } from '../src/server/app.ts';

const NOW = '2026-09-12T14:30:00.000Z';
const clock = frozenClock(NOW);
const WINDOW = computeNextDigestAt(clock);

/** Every reference scenario in one window, so there is a real mix to filter. */
async function populated(): Promise<Ledger> {
  const ledger = new Ledger(':memory:');
  const pipeline = createPipeline({
    perceiver: createPerceiver({ transport: scriptedTransport({ clock }), clock }),
    ledger,
    clock,
    getFocusActive: () => true,
  });

  const identity = new IdentityDirectory(DEMO_PEOPLE);
  let index = 0;
  for (const scenario of [SCENARIO_A, SCENARIO_B, SCENARIO_C, SCENARIO_D]) {
    for (const message of scenario.messages) {
      await pipeline.ingest(
        toCanonicalMessage(message, { identity, runId: 's', index: index++, clock }),
      );
    }
  }
  return ledger;
}

describe('ledger filtering', () => {
  test('filters by route', async () => {
    const ledger = await populated();
    const pushed = ledger.query({ routes: ['push'] });

    assert.ok(pushed.length > 0);
    assert.ok(pushed.every((e) => e.decision.route === 'push'));
    ledger.close();
  });

  test('values inside one group are OR, not AND', async () => {
    const ledger = await populated();
    const either = ledger.query({ routes: ['push', 'digest'] });
    const push = ledger.query({ routes: ['push'] });
    const digest = ledger.query({ routes: ['digest'] });

    assert.equal(either.length, push.length + digest.length);
    ledger.close();
  });

  test('separate groups combine as AND', async () => {
    const ledger = await populated();
    const slackPushes = ledger.query({ routes: ['push'], platforms: ['slack'] });

    assert.ok(slackPushes.every((e) => e.decision.route === 'push' && e.message.platform === 'slack'));
    assert.ok(slackPushes.length < ledger.query({ routes: ['push'] }).length);
    ledger.close();
  });

  test('filters by tier, person and channel', async () => {
    const ledger = await populated();

    assert.ok(ledger.query({ tiers: ['inner'] }).every((e) => e.message.relationshipTier === 'inner'));
    assert.ok(
      ledger.query({ personIds: ['person:aunt'] }).every((e) => e.message.personId === 'person:aunt'),
    );
    assert.ok(ledger.query({ channels: ['family'] }).every((e) => e.message.channelName === 'family'));
    ledger.close();
  });

  test('filters by cost range, which is how you find what overrode the budget', async () => {
    const ledger = await populated();
    const expensive = ledger.query({ minCost: 4 });

    assert.ok(expensive.length > 0);
    assert.ok(expensive.every((e) => e.decision.cost >= 4));
    assert.ok(ledger.query({ maxCost: 0.5 }).every((e) => e.decision.cost <= 0.5));
    ledger.close();
  });

  test('an empty filter set returns everything, rather than nothing', async () => {
    const ledger = await populated();
    assert.equal(ledger.query({ routes: [], platforms: [] }).length, ledger.query({}).length);
    ledger.close();
  });

  test('the limit is clamped rather than trusted', async () => {
    const ledger = await populated();
    assert.equal(ledger.query({ limit: 1 }).length, 1);
    assert.ok(ledger.query({ limit: 10_000 }).length <= 500);
    assert.ok(ledger.query({ limit: -5 }).length >= 1);
    ledger.close();
  });
});

describe('search', () => {
  test('matches the message body', async () => {
    const ledger = await populated();
    const hits = ledger.query({ search: 'rollback' });

    assert.equal(hits.length, 1);
    assert.match(hits[0]!.message.text, /rollback/i);
    ledger.close();
  });

  test('matches the topic and the recorded reason', async () => {
    const ledger = await populated();

    assert.ok(ledger.query({ search: 'dinner' }).length > 0, 'topic');
    assert.ok(ledger.query({ search: 'headcount' }).length > 0, 'reason');
    ledger.close();
  });

  test('matches the routing basis, which finds everything the budget displaced', async () => {
    const ledger = await populated();
    const displaced = ledger.query({ search: 'budget_exhausted' });

    assert.ok(displaced.length > 0);
    assert.ok(displaced.every((e) => e.decision.basis === 'discretionary_budget_exhausted'));
    ledger.close();
  });

  test('is case insensitive', async () => {
    const ledger = await populated();
    assert.equal(
      ledger.query({ search: 'ROLLBACK' }).length,
      ledger.query({ search: 'rollback' }).length,
    );
    ledger.close();
  });

  test('a term that looks like SQL is treated as a string, not as SQL', async () => {
    const ledger = await populated();
    const before = ledger.query({}).length;

    for (const attempt of [
      "'; DROP TABLE decisions; --",
      "%' OR 1=1 --",
      '" UNION SELECT * FROM messages --',
    ]) {
      assert.equal(ledger.query({ search: attempt }).length, 0, attempt);
    }

    // The table is still there and still full, which is the actual assertion.
    assert.equal(ledger.query({}).length, before);
    ledger.close();
  });

  test('a person id containing a wildcard is not treated as a pattern', async () => {
    const ledger = await populated();
    assert.equal(ledger.query({ personIds: ['%'] }).length, 0, 'IN is exact, not LIKE');
    ledger.close();
  });
});

describe('facets describe what is actually present', () => {
  test('counts add up to the total', async () => {
    const ledger = await populated();
    const facets = ledger.facets(WINDOW);

    const sum = facets.routes.reduce((n, r) => n + r.count, 0);
    assert.equal(sum, facets.total);
    assert.ok(facets.people.length > 0);
    assert.ok(facets.channels.some((c) => c.value === 'family'));
    ledger.close();
  });

  test('facets are ordered by count so the busiest options come first', async () => {
    const ledger = await populated();
    const counts = ledger.facets(WINDOW).routes.map((r) => r.count);
    assert.deepEqual(counts, [...counts].sort((a, b) => b - a));
    ledger.close();
  });
});

describe('the search HTTP surface', () => {
  let base: string;
  let app: ReturnType<typeof createApp>;
  let ledger: Ledger;

  const get = async <T>(path: string): Promise<T> =>
    (await (await fetch(`${base}${path}`)).json()) as T;

  before(async () => {
    ledger = await populated();
    app = createApp({
      ledger,
      pipeline: createPipeline({
        perceiver: createPerceiver({ transport: scriptedTransport({ clock }), clock }),
        ledger,
        clock,
        getFocusActive: () => true,
      }),
      focus: { isActive: () => true, set: () => {} },
      clock,
      adapters: () => ({ discord: false, slack: false, perception: 'stub' }),
    });
    await app.listen(0);
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await app.close();
    ledger.close();
  });

  test('repeated parameters mean OR', async () => {
    const both = await get<LedgerEntry[]>('/api/decisions?route=push&route=digest');
    const one = await get<LedgerEntry[]>('/api/decisions?route=push');
    assert.ok(both.length > one.length);
  });

  test('comma separated values work too', async () => {
    const commas = await get<LedgerEntry[]>('/api/decisions?route=push,digest');
    const repeated = await get<LedgerEntry[]>('/api/decisions?route=push&route=digest');
    assert.equal(commas.length, repeated.length);
  });

  test('search narrows over HTTP', async () => {
    const hits = await get<LedgerEntry[]>('/api/decisions?q=rollback');
    assert.equal(hits.length, 1);
  });

  test('a nonsense filter value returns nothing rather than everything', async () => {
    // Failing open would be the dangerous bug here: a typo in a route name
    // should not quietly show the unfiltered list.
    assert.equal((await get<LedgerEntry[]>('/api/decisions?route=nonsense')).length, 0);
  });

  test('serves facets scoped to the current window', async () => {
    const facets = await get<Facets>('/api/facets');
    assert.ok(facets.total > 0);
    assert.ok(facets.routes.length > 0);
  });

  test('filters live behind a button that opens a dialog', async () => {
    const html = await (await fetch(base)).text();

    assert.match(html, /id="open-filters"[^>]*aria-haspopup="dialog"/);
    assert.match(html, /<dialog id="filter-dialog"/);
    assert.match(html, /Advanced filters/);
    // Native <dialog> via showModal gives focus trapping, Escape to close and a
    // backdrop from the platform, rather than hand-rolled focus management.
    assert.match(html, /showModal\(\)/);
  });

  test('the dialog exposes every filter dimension the API supports', async () => {
    const html = await (await fetch(base)).text();

    assert.match(html, /type="search"/, 'free text');
    assert.match(html, /id="min-cost"/, 'cost floor');
    assert.match(html, /id="max-cost"/, 'cost ceiling');
    assert.match(html, /name="scope"[^>]*value="all"/, 'search all history');
    assert.match(html, /id="facets"/, 'route, platform, tier, person, channel');
  });

  test('edits are staged and only take effect on Apply', async () => {
    const html = await (await fetch(base)).text();

    // Two copies of the state: the stream must not rearrange under you while you
    // are still deciding what you want to see.
    assert.match(html, /let applied = emptyFilters\(\)/);
    assert.match(html, /let draft = cloneFilters\(applied\)/);
    assert.match(html, /applied = cloneFilters\(draft\)/, 'Apply promotes the draft');
    assert.match(html, /id="apply-filters"/);
    assert.match(html, /id="reset-filters"/);
  });

  test('active filters stay visible outside the dialog', async () => {
    const html = await (await fetch(base)).text();
    assert.match(html, /id="active-chips"/, 'removable chips');
    assert.match(html, /id="filter-count"/, 'count badge on the button');
    assert.match(html, /Clear all/);
    // Filtering must be described as narrowing the view, never as changing a
    // decision, because it does not.
    assert.match(html, /does not change any decision/);
  });
});
