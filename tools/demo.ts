/**
 * Demo driver. Runs every reference scenario against a running instance and
 * prints what the dashboard is showing.
 *
 * Useful for two things: rehearsing the video without staring at a browser, and
 * proving on a terminal that the costs a judge sees on screen are the same ones
 * the test suite asserts.
 *
 *   npm start          # in one terminal
 *   npm run demo       # in another
 */

const BASE = process.env.ATTENTION_OS_URL ?? 'http://localhost:4317';

type StateResponse = {
  received: number;
  held: number;
  digested: number;
  interrupted: number;
  spent: number;
  ceiling: number;
  focusActive: boolean;
  scenarioMode: 'inject' | 'replay' | 'none';
  adapters: { discord: boolean; slack: boolean; perception: string };
};

type Entry = {
  message: { platform: string; channelName: string; relationshipTier: string; text: string };
  decision: {
    cost: number;
    route: string;
    basis: string;
    budgetBefore: number;
    budgetAfter: number;
    reason: string;
  };
};

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return (await res.json()) as T;
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`POST ${path} -> ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const pad = (s: string | number, n: number) => String(s).padEnd(n);

function printEntry(entry: Entry): void {
  const { message: m, decision: d } = entry;
  console.log(
    `  ${pad(m.platform, 8)}${pad('#' + m.channelName, 12)}${pad(m.relationshipTier, 7)}` +
      `${pad('cost ' + d.cost.toFixed(2), 13)}${pad(d.route.toUpperCase(), 8)}` +
      `${pad(d.budgetBefore.toFixed(1) + ' -> ' + d.budgetAfter.toFixed(1), 12)}${d.basis}`,
  );
  console.log(`      "${m.text.slice(0, 74)}"`);
  console.log(`      ${d.reason}`);
}

const state = await get<StateResponse>('/api/state');

console.log('');
console.log('  ATTENTION OS  demo run');
console.log(`  sources: discord=${state.adapters.discord} slack=${state.adapters.slack}  perception=${state.adapters.perception}`);
console.log(`  scenario mode: ${state.scenarioMode}${state.scenarioMode === 'replay' ? '  (adapters bypassed, development only)' : ''}`);

await post('/api/focus', { active: true });
console.log('  focus mode ON, ceiling 3.0');

const scenarios = await get<Array<{ id: string; title: string; proves: string }>>('/api/scenarios');

for (const scenario of scenarios) {
  // Roll the window so each scenario starts on a full ceiling. Without this the
  // second scenario runs against an already-spent budget: still correct, but it
  // hides the displacement that makes the point.
  await post('/api/window/reset');
  await post(`/api/scenario/${scenario.id}`);
  await sleep(5000);

  const after = await get<StateResponse>('/api/state');
  const entries = (await get<Entry[]>('/api/decisions')).reverse();

  console.log('');
  console.log(`  ${scenario.id}. ${scenario.title.toUpperCase()}`);
  console.log(`  ${scenario.proves}`);
  console.log('');
  for (const entry of entries) printEntry(entry);
  console.log(
    `      received ${after.received}  held ${after.held}  deferred ${after.digested}  ` +
      `interrupts ${after.interrupted}  spent ${after.spent}/${after.ceiling}`,
  );
}

console.log('');
