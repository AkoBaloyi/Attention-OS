# Attention OS

An agent that lives in your Discord and Slack and treats your attention as a budget with a hard ceiling.

Every notification assumes it deserves your attention. Attention OS makes it prove it.

And because your attention is one budget shared by work and social life, Attention OS has to see both.

## The problem

Notifications are per-app. Slack decides what Slack thinks is urgent. Discord decides what Discord thinks is urgent. Nothing on your phone can weigh a message from your mother against a message from your manager, because no app sees both.

So people do the only thing available: mute everything. Then the dinner gets arranged without them, the deadline moves without them, and someone who actually needed them gets nothing.

Attention OS sees both platforms, so it is the only thing that can rank them against each other.

## The rule the whole system is built on

**The model proposes. The runtime decides.**

The LLM never chooses whether to interrupt you. It reads a message and describes the situation: what kind of utterance this is, whether you specifically are needed, what the deadline is, what happens if this waits. Its output schema contains no route field, and `assertValidEnvelope` throws if one is smuggled in.

Deterministic code then computes a cost and picks a route. No model involvement, no randomness, and every decision is reproducible from its own audit record.

When a judge asks "why did the AI decide to interrupt?", the answer is that it didn't. The model perceived the situation, and policy you can read made the decision.

## What it actually measures

Not how important a message is, and not how loudly it was typed. It computes **the damage done by making it wait until the next digest release**, which is a moment the runtime already knows.

That reframing is what makes the number defensible instead of arbitrary. The question is not a matter of taste, it is: does anything bad happen between now and 15:00?

A consequence worth stating plainly: someone typing `URGENT!!!` about a trivial question has a consequence of `none`, so a base of zero, so a cost of zero, so it holds. Volume of shouting is not an input.

## How the budget works

The budget does not gate expensive messages. It gates *discretionary* ones.

| Cost | Route | Behaviour |
|---|---|---|
| under 1 | `hold` | Archived silently. Never surfaces unless you go looking. |
| 1 to 4 | `push` or `digest` | Discretionary. Pushes if the budget covers it, otherwise defers. |
| 4 and above | `push` | Non-discretionary. Overrides the budget, but still spends it. |
| 8 and above | `call` | Top rung, when enabled. |

A naive "can I afford this?" check would refuse to interrupt for a production incident, because its cost exceeds the remaining budget. That is exactly backwards: a high cost is precisely the evidence that interrupting is the cheaper option.

So the outcome is this: **a production incident interrupts you and spends your entire attention budget, so the dinner question that would have reached you on a quiet afternoon has to wait for the digest instead.**

## The three reference scenarios

These are verified in [`test/scenarios.test.ts`](test/scenarios.test.ts) against a clock frozen at 14:30 UTC, which puts the next digest at 15:00.

**A. Work wins.** A Slack message asking for production rollback approval with a 12 minute deadline costs **8.64** and interrupts, spending the whole budget. A Discord message asking about dinner at 7 costs **2.85** and drops to the digest, even though on a quiet afternoon it would have reached you.

**B. The reversal.** "Dinner starts in 5 minutes and everyone is waiting for you" costs **12.15** and interrupts. A Slack PR review request with no deadline costs **1.8** and defers. Same formula, untouched. This scenario exists because the first thing a sceptic thinks during A is that work was hardcoded above social. It wasn't.

**C. The refusal.** `URGENT!!! what's your favourite colour` costs **0** and is held, with the reason recorded as no consequence following from delay.

## Architecture

```
Discord adapter ─┐
                 ├─→ CanonicalMessage ─→ Perception (LLM) ─→ PerceptionEnvelope
Slack adapter ───┘                                                   │
                                                                     ▼
                          Decision ←── Policy engine (deterministic) ─┤
                             │                                        │
                             │         EvaluationContext ─────────────┘
                             ▼         (now, nextDigestAt, focus, budget)
                    hold · digest · push · call
```

Two contract rules hold it together:

1. **Nothing downstream of the adapters may branch on `platform`.** If policy could see the source it would be arbitrating between apps rather than between people, which is what existing notification systems already do badly. Enforced by a test.
2. **`nextDigestAt` is computed in exactly one place** and persisted with every decision. Cost depends on whether a deadline falls before the next release, so independent calculation makes routing non-deterministic. The clock is injectable and freezable for precisely this reason: a deadline "in 12 minutes" evaluated at 14:58 falls *after* the next release, and Scenario A would silently invert.

Every `Decision` carries the envelope and the full context that produced it, so the arithmetic can be re-derived by hand from a single row. That is the difference between claiming the policy is deterministic and showing it.

## Running it

Requires Node 24 or later, which runs the TypeScript directly with no build step.

```bash
npm install
npm test          # the three scenarios and the contract guards
npm run typecheck
```

## Status

Built for a hackathon. The policy core, contracts and scenario verification are complete and green. Adapters, perception, persistence, dashboard and the scenario injector are in progress.
