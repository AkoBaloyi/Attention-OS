/**
 * Exercises filtering and search against a running instance.
 *
 *   npm start
 *   npm run search
 */

const BASE = process.env.ATTENTION_OS_URL ?? 'http://localhost:4317';

type Entry = {
  message: { platform: string; channelName: string; personId: string; text: string };
  decision: { route: string; basis: string; cost: number };
};

type Facets = Record<string, Array<{ value: string; count: number }>> & { total: number };

const get = async <T>(path: string): Promise<T> =>
  (await (await fetch(`${BASE}${path}`)).json()) as T;

const post = (path: string, body?: unknown) =>
  fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Seed a mixed window so there is something worth filtering.
let state = await get<{ received: number }>('/api/state');
if (state.received < 4) {
  console.log('  Seeding all four scenarios into one window...');
  await post('/api/window/reset');
  await post('/api/focus', { active: true });
  for (const id of ['A', 'B', 'C', 'D']) {
    await post(`/api/scenario/${id}`);
    await sleep(3200);
  }
  state = await get<{ received: number }>('/api/state');
}

console.log('');
console.log(`  SEARCH AND FILTER  ${state.received} decisions in this window`);

const facets = await get<Facets>('/api/facets');
console.log('');
console.log('  Facets available:');
for (const group of ['routes', 'platforms', 'tiers', 'people', 'channels']) {
  const values = facets[group] ?? [];
  console.log(
    `    ${group.padEnd(10)} ${values.map((v) => `${v.value}(${v.count})`).join('  ')}`,
  );
}

const QUERIES: Array<[string, string]> = [
  ['route=push', 'everything that interrupted'],
  ['route=push,digest', 'interrupted OR deferred, one group is OR'],
  ['route=push&platform=slack', 'separate groups are AND'],
  ['tier=inner', 'people close to you'],
  ['minCost=4', 'everything that overrode the budget'],
  ['q=rollback', 'free text over the message body'],
  ['q=headcount', 'free text over the recorded reason'],
  ['q=budget_exhausted', 'everything the budget displaced'],
  ["q=%27%3B%20DROP%20TABLE%20decisions%3B%20--", 'a term that looks like SQL'],
  ['route=nonsense', 'an unknown value fails closed, not open'],
];

for (const [query, description] of QUERIES) {
  const results = await get<Entry[]>(`/api/decisions?${query}&limit=50`);
  console.log('');
  console.log(`  ?${query}`);
  console.log(`    ${description}  ->  ${results.length} result(s)`);
  for (const entry of results.slice(0, 4)) {
    console.log(
      `      ${entry.message.platform.padEnd(8)}${entry.decision.route.toUpperCase().padEnd(8)}` +
        `${String(entry.decision.cost.toFixed(2)).padStart(6)}  ${entry.message.text.slice(0, 52)}`,
    );
  }
}

// The table surviving the injection attempts is the real assertion.
const after = await get<{ received: number }>('/api/state');
console.log('');
console.log(`  Ledger intact after injection attempts: ${after.received} decisions still present`);
console.log('');
