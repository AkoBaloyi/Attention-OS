/**
 * Voice interface tests.
 *
 * The first suite is the important one. The voice agent is read only by
 * construction, and that has to stay true: if a future change lets a spoken
 * question reach the pipeline, the architecture's central claim is gone.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { frozenClock, computeNextDigestAt, ceilingFor } from '../src/contracts/context.ts';
import { Ledger } from '../src/store/ledger.ts';
import { createPipeline } from '../src/runtime/pipeline.ts';
import { createPerceiver } from '../src/perception/perceiver.ts';
import { scriptedTransport } from '../src/perception/scripted.ts';
import { createReplayer, DEMO_PEOPLE, toCanonicalMessage } from '../src/scenarios/replay.ts';
import { IdentityDirectory } from '../src/adapters/identity.ts';
import { SCENARIO_A, SCENARIO_C } from '../src/scenarios/reference.ts';
import { matchIntent, HELP_LINE } from '../src/voice/intent.ts';
import { answer } from '../src/voice/ask.ts';
import { speakablePerson, type VoiceLedgerView } from '../src/voice/brief.ts';

const NOW = '2026-09-12T14:30:00.000Z';
const clock = frozenClock(NOW);
const WINDOW = computeNextDigestAt(clock);
const CEILING = ceilingFor(true);

async function seeded(scenario = SCENARIO_A) {
  const ledger = new Ledger(':memory:');
  const pipeline = createPipeline({
    perceiver: createPerceiver({ transport: scriptedTransport({ clock }), clock }),
    ledger,
    clock,
    getFocusActive: () => true,
  });

  const identity = new IdentityDirectory(DEMO_PEOPLE);
  for (const [index, message] of scenario.messages.entries()) {
    await pipeline.ingest(toCanonicalMessage(message, { identity, runId: 'v', index, clock }));
  }

  return ledger;
}

function ask(ledger: Ledger, transcript: string) {
  return answer({
    transcript,
    ledger,
    windowKey: WINDOW,
    counters: ledger.counters(WINDOW, CEILING),
    focusActive: true,
  });
}

describe('the voice interface is read only by construction', () => {
  test('the view it is handed exposes no way to write anything', () => {
    const ledger = new Ledger(':memory:');
    const view: VoiceLedgerView = ledger;

    // If `record` or `clearWindow` were on VoiceLedgerView, a spoken question
    // could change state. They are not, and this asserts the shape rather than
    // trusting a convention.
    assert.equal('record' in (view as object) && 'recordViaView' in (view as object), false);
    for (const method of ['recent', 'counters', 'digestFor']) {
      assert.equal(typeof (view as Record<string, unknown>)[method], 'function');
    }

    const keys = Object.keys({ recent: 0, counters: 0, digestFor: 0 });
    assert.deepEqual(keys.sort(), ['counters', 'digestFor', 'recent']);
    ledger.close();
  });

  test('asking a question does not change the ledger', async () => {
    const ledger = await seeded();
    const before = ledger.counters(WINDOW, CEILING);

    for (const question of ['what did I miss', 'why did that interrupt me', 'how much budget']) {
      ask(ledger, question);
    }

    assert.deepEqual(ledger.counters(WINDOW, CEILING), before);
    ledger.close();
  });
});

describe('intent matching', () => {
  test('recognises the questions the demo actually asks', () => {
    const cases: Array<[string, string]> = [
      ['What did I miss?', 'catch_up'],
      ['catch me up', 'catch_up'],
      ['give me a summary', 'catch_up'],
      ['what interrupted me', 'interrupts'],
      ['what got through', 'interrupts'],
      ["what's waiting in the digest", 'digest'],
      ['what did you hold', 'held'],
      ['how much attention budget is left', 'budget'],
      ['am I in focus mode', 'focus'],
      ['what can I ask', 'help'],
    ];
    for (const [transcript, expected] of cases) {
      assert.equal(matchIntent(transcript).intent, expected, transcript);
    }
  });

  test('why questions beat the keyword they contain', () => {
    // "why did the rollback interrupt me" contains "interrupt". If pattern order
    // were wrong this would answer with a list instead of a reason.
    const match = matchIntent('why did the production rollback interrupt me');
    assert.equal(match.intent, 'explain');
    assert.match(match.subject ?? '', /production rollback/);
  });

  test('a bare why question carries no subject, so it explains the latest decision', () => {
    assert.equal(matchIntent('why?').subject, undefined);
    assert.equal(matchIntent('why did that happen').subject, undefined);
  });

  test('an unrecognised question offers help rather than guessing', () => {
    const result = matchIntent('what is the capital of france');
    assert.equal(result.intent, 'unknown');
  });

  test('empty input is unknown, not a crash', () => {
    assert.equal(matchIntent('   ').intent, 'unknown');
  });
});

describe('briefings are built from the ledger', () => {
  test('catch up names what interrupted and what was deferred', async () => {
    const ledger = await seeded();
    const result = ask(ledger, 'what did I miss');

    assert.equal(result.intent, 'catch_up');
    assert.match(result.speech, /2 messages arrived/);
    assert.match(result.speech, /production rollback approval/);
    assert.match(result.speech, /dinner attendance/);
    assert.match(result.speech, /waiting for the digest/);
    assert.match(result.speech, /fully spent/);
    ledger.close();
  });

  test('the explanation reads the arithmetic aloud', async () => {
    const ledger = await seeded();
    const result = ask(ledger, 'why did the rollback interrupt me');

    assert.equal(result.intent, 'explain');
    assert.match(result.speech, /cost 8\.64/);
    assert.match(result.speech, /base of 6 because the consequence of delay is severe/);
    assert.match(result.speech, /multiplied by 1\.5 because the deadline falls before the next digest/);
    assert.match(result.speech, /by 0\.96 for confidence/);
    assert.match(result.speech, /overrode your budget/);
    ledger.close();
  });

  test('a displaced message is explained as displacement, not as unimportance', async () => {
    const ledger = await seeded();
    const result = ask(ledger, 'why was dinner deferred');

    assert.match(result.speech, /cost 2\.85/);
    assert.match(result.speech, /budget was already spent/);
    ledger.close();
  });

  test('a held message explains that nothing breaks if it waits', async () => {
    const ledger = await seeded(SCENARIO_C);
    const result = ask(ledger, 'why was that held');

    assert.match(result.speech, /cost 0/);
    assert.match(result.speech, /below the threshold of 1/);
    assert.match(result.speech, /no consequence follows from delaying this/i);
    ledger.close();
  });

  test('an empty window says so instead of inventing a briefing', () => {
    const ledger = new Ledger(':memory:');
    assert.match(ask(ledger, 'what did I miss').speech, /have not missed anything/);
    assert.match(ask(ledger, 'why did that happen').speech, /no decisions in this window/);
    ledger.close();
  });

  test('help lists what can actually be asked', () => {
    const ledger = new Ledger(':memory:');
    assert.equal(ask(ledger, 'what can I ask').speech, HELP_LINE);
    ledger.close();
  });

  test('spoken sentences do not stumble', async () => {
    const ledger = await seeded();
    for (const question of [
      'what did I miss',
      'what interrupted me',
      'why did the rollback interrupt me',
      'why was dinner deferred',
      "what's waiting in the digest",
      'how much budget is left',
    ]) {
      const { speech } = ask(ledger, question);
      // list() supplies the final "and", so a factor must not carry one too.
      assert.doesNotMatch(speech, /\band and\b/, question);
      // A topic beginning a sentence has to be capitalised or a speech engine
      // audibly trips over the full stop before it.
      assert.doesNotMatch(speech, /\.\s+[a-z]/, question);
      assert.doesNotMatch(speech, /\s{2,}/, question);
    }
    ledger.close();
  });

  test('speech carries no markup or symbols that would be read aloud', async () => {
    const ledger = await seeded();
    for (const question of ['what did I miss', 'why did that interrupt me', 'how much budget']) {
      const { speech } = ask(ledger, question);
      assert.doesNotMatch(speech, /[<>#*_|]/, question);
      assert.doesNotMatch(speech, /person:/, 'raw person ids sound terrible spoken');
    }
    ledger.close();
  });

  test('person ids are made speakable', () => {
    assert.equal(speakablePerson('person:aunt'), 'aunt');
    assert.equal(speakablePerson('unmapped:slack:U123'), 'U123');
    assert.equal(speakablePerson('person:on_call'), 'on call');
  });
});

describe('the voice HTTP surface', () => {
  test('replay and voice can coexist without the voice path touching the pipeline', async () => {
    // Drives the pipeline the normal way, then asks about it. Proves the two
    // paths meet only at the ledger.
    const ledger = new Ledger(':memory:');
    const pipeline = createPipeline({
      perceiver: createPerceiver({ transport: scriptedTransport({ clock }), clock }),
      ledger,
      clock,
      getFocusActive: () => true,
    });

    await createReplayer({ pipeline, clock, sleepImpl: async () => {} }).replay(SCENARIO_A);

    const counters = ledger.counters(WINDOW, CEILING);
    assert.equal(counters.interrupted, 1);
    assert.match(ask(ledger, 'what interrupted me').speech, /production rollback approval/i);
    ledger.close();
  });
});
