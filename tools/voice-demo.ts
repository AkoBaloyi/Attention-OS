/**
 * Drives the voice interface against a running instance and prints what it would
 * say out loud. Useful for checking the phrasing without a microphone, and for
 * rehearsing the spoken part of the video.
 *
 *   npm start
 *   npm run voice
 */

const BASE = process.env.ATTENTION_OS_URL ?? 'http://localhost:4317';

const QUESTIONS = [
  'What did I miss?',
  'What interrupted me?',
  'Why did the production rollback interrupt me?',
  'Why was dinner deferred?',
  "What's waiting in the digest?",
  'How much attention budget is left?',
  'What is the capital of France?',
];

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} -> ${res.status}`);
  return (await res.json()) as T;
}

type State = { voice: string; focusActive: boolean; received: number };

const getState = async (): Promise<State> =>
  (await (await fetch(`${BASE}/api/state`)).json()) as State;

let state = await getState();

// Seed itself rather than requiring two commands in the right order. Scenario A
// is the one worth asking about, because it has an interrupt and a displacement.
if (state.received === 0) {
  console.log('  Ledger empty, running scenario A first so there is something to ask about.');
  await post('/api/window/reset', {});
  await post('/api/focus', { active: true });
  await post('/api/scenario/A', {});
  await new Promise((r) => setTimeout(r, 4500));
  state = await getState();
}

console.log('');
console.log(`  VOICE  output: ${state.voice}  focus: ${state.focusActive}  received: ${state.received}`);

for (const question of QUESTIONS) {
  const result = await post<{ intent: string; speech: string }>('/api/voice/ask', {
    transcript: question,
  });

  console.log('');
  console.log(`  Q  ${question}`);
  console.log(`     intent: ${result.intent}`);
  for (const line of wrap(result.speech, 88)) console.log(`  A  ${line}`);
}

console.log('');

function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/)) {
    if ((current + ' ' + word).trim().length > width) {
      lines.push(current.trim());
      current = word;
    } else {
      current += ' ' + word;
    }
  }
  if (current.trim()) lines.push(current.trim());
  return lines;
}
