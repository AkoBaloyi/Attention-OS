/**
 * What happens when perception fails.
 *
 * Written after a real incident: an OpenAI key ran out of credit and every
 * message in the window was silently dropped. The retry worked, the loud failure
 * worked, and the agent still lost the messages, which for something whose job is
 * guarding your attention is the worst available outcome.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { CanonicalMessage } from '../src/contracts/message.ts';
import { frozenClock, computeNextDigestAt, ceilingFor } from '../src/contracts/context.ts';
import { Ledger } from '../src/store/ledger.ts';
import { createPipeline } from '../src/runtime/pipeline.ts';
import {
  createPerceiver,
  fallbackTransport,
  type PerceptionTransport,
} from '../src/perception/perceiver.ts';
import { scriptedTransport } from '../src/perception/scripted.ts';

const NOW = '2026-09-12T14:30:00.000Z';
const clock = frozenClock(NOW);
const WINDOW = computeNextDigestAt(clock);

const MESSAGE: CanonicalMessage = {
  id: 'slack:R1',
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

/** The exact body OpenAI returns when the balance is gone. */
const NO_CREDIT = new Error(
  'openai 429: {"error":{"message":"You have no credits remaining.","type":"insufficient_quota","code":"credit_balance_exhausted"}}',
);

function alwaysFails(error: Error): PerceptionTransport {
  return { async complete() { throw error; } };
}

function harness(transport: PerceptionTransport) {
  const ledger = new Ledger(':memory:');
  const errors: unknown[] = [];
  const pipeline = createPipeline({
    perceiver: createPerceiver({ transport, clock, retries: 1 }),
    ledger,
    clock,
    getFocusActive: () => true,
    onError: (e) => errors.push(e),
  });
  return { ledger, pipeline, errors };
}

describe('an unreadable message is deferred, never dropped', () => {
  test('it is recorded rather than vanishing', async () => {
    const { ledger, pipeline } = harness(alwaysFails(NO_CREDIT));

    const decision = await pipeline.ingest(MESSAGE);

    assert.ok(decision, 'the message must not be silently swallowed');
    assert.equal(ledger.recent().length, 1);
    ledger.close();
  });

  test('it goes to the digest, so it surfaces at the next break', async () => {
    const { ledger, pipeline } = harness(alwaysFails(NO_CREDIT));
    const decision = await pipeline.ingest(MESSAGE);

    assert.equal(decision?.route, 'digest');
    assert.equal(decision?.basis, 'perception_unavailable');
    assert.equal(ledger.digestFor(WINDOW).length, 1);
    ledger.close();
  });

  test('it does not interrupt, because a flaky provider must not become noise', async () => {
    const { pipeline } = harness(alwaysFails(NO_CREDIT));
    const decision = await pipeline.ingest(MESSAGE);

    assert.notEqual(decision?.route, 'push');
    assert.notEqual(decision?.route, 'call');
  });

  test('it costs no attention and claims no cost it could not compute', async () => {
    const { ledger, pipeline } = harness(alwaysFails(NO_CREDIT));
    const decision = await pipeline.ingest(MESSAGE);

    assert.equal(decision?.cost, 0);
    assert.equal(decision?.budgetBefore, decision?.budgetAfter);
    assert.equal(ledger.spentInWindow(WINDOW), 0);
    ledger.close();
  });

  test('the reason names the cause in words a human can act on', async () => {
    const { pipeline } = harness(alwaysFails(NO_CREDIT));
    const decision = await pipeline.ingest(MESSAGE);

    assert.match(decision!.reason, /could not read this message/i);
    assert.match(decision!.reason, /no remaining credit/i);
    // The provider's raw JSON body has no business in a reason a human reads.
    assert.doesNotMatch(decision!.reason, /insufficient_quota|\{/);
  });

  test('the failure is still surfaced, not quietly absorbed', async () => {
    const { errors, pipeline } = harness(alwaysFails(NO_CREDIT));
    await pipeline.ingest(MESSAGE);

    assert.equal(errors.length, 1, 'deferring must not hide the outage');
  });

  test('unreadable messages appear in the counters', async () => {
    const { ledger, pipeline } = harness(alwaysFails(NO_CREDIT));
    await pipeline.ingest(MESSAGE);

    const counters = ledger.counters(WINDOW, ceilingFor(true));
    assert.equal(counters.received, 1);
    assert.equal(counters.digested, 1);
    assert.equal(counters.interrupted, 0);
    ledger.close();
  });
});

describe('the perception fallback chain', () => {
  test('a dead first provider is survivable', async () => {
    const chain = fallbackTransport(
      { name: 'dead', transport: alwaysFails(NO_CREDIT) },
      { name: 'scripted', transport: scriptedTransport({ clock }) },
    );
    const { ledger, pipeline } = harness(chain);

    const decision = await pipeline.ingest(MESSAGE);

    // The scripted transport knows this reference text, so the real cost comes
    // back rather than the deferral.
    assert.equal(decision?.cost, 8.64);
    assert.equal(decision?.route, 'push');
    assert.equal(chain.lastUsed(), 'scripted');
    ledger.close();
  });

  test('the first working provider wins and later ones are not called', async () => {
    let secondCalled = false;
    const chain = fallbackTransport(
      { name: 'first', transport: scriptedTransport({ clock }) },
      {
        name: 'second',
        transport: { async complete() { secondCalled = true; return {}; } },
      },
    );
    const { ledger, pipeline } = harness(chain);

    await pipeline.ingest(MESSAGE);

    assert.equal(chain.lastUsed(), 'first');
    assert.equal(secondCalled, false);
    ledger.close();
  });

  test('when every provider fails the error names all of them', async () => {
    const chain = fallbackTransport(
      { name: 'alpha', transport: alwaysFails(new Error('alpha down')) },
      { name: 'beta', transport: alwaysFails(new Error('beta down')) },
    );

    await assert.rejects(
      () => chain.complete({ system: '', user: '', schema: {} }),
      /all perception providers failed.*alpha.*beta/s,
    );
  });
});
