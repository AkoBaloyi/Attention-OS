/**
 * The decision ledger. Every routing decision is persisted with the full
 * context that produced it.
 *
 * WHY PERSISTENCE IS NOT OPTIONAL HERE
 *
 * Two reasons, and neither is "we wanted a database".
 *
 * First, the budget lives here. If remaining attention were held in memory, a
 * restart would silently refill your budget and the ceiling would mean nothing.
 * Spend is derived from the rows, so it survives a crash.
 *
 * Second, auditability. A row recording `cost = 8.64` without the context that
 * produced it proves nothing. Each row carries `now`, `nextDigestAt`,
 * `focusActive`, the ceiling, the full cost breakdown and the envelope, so the
 * arithmetic can be re-derived by hand from that row alone. That is the
 * difference between claiming the policy is deterministic and showing it.
 *
 * THE WINDOW KEY
 *
 * `nextDigestAt` identifies the budget window. That is not a coincidence: the
 * window is the span of time ending at the next release, and because
 * `computeNextDigestAt` is the only place that moment is decided, the window
 * key is free and cannot drift.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { CanonicalMessage } from '../contracts/message.ts';
import type { Decision, Route } from '../contracts/decision.ts';

export type LedgerEntry = {
  message: CanonicalMessage;
  decision: Decision;
  recordedAt: string;
};

/** The demo counter: what arrived, and what it actually cost you. */
export type WindowCounters = {
  received: number;
  held: number;
  digested: number;
  interrupted: number;
  spent: number;
  remaining: number;
  ceiling: number;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id                TEXT PRIMARY KEY,
  platform          TEXT NOT NULL,
  channel_id        TEXT NOT NULL,
  channel_name      TEXT NOT NULL,
  person_id         TEXT NOT NULL,
  relationship_tier TEXT NOT NULL,
  text              TEXT NOT NULL,
  timestamp         TEXT NOT NULL,
  thread_id         TEXT,
  mentions_user     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS decisions (
  message_id     TEXT PRIMARY KEY,
  window_key     TEXT NOT NULL,
  route          TEXT NOT NULL,
  basis          TEXT NOT NULL,
  cost           REAL NOT NULL,
  budget_before  REAL NOT NULL,
  budget_after   REAL NOT NULL,
  reason         TEXT NOT NULL,
  evaluated_at   TEXT NOT NULL,
  focus_active   INTEGER NOT NULL,
  budget_ceiling REAL NOT NULL,
  breakdown_json TEXT NOT NULL,
  context_json   TEXT NOT NULL,
  envelope_json  TEXT NOT NULL,
  recorded_at    TEXT NOT NULL,
  FOREIGN KEY (message_id) REFERENCES messages (id)
);

CREATE INDEX IF NOT EXISTS idx_decisions_window ON decisions (window_key);
CREATE INDEX IF NOT EXISTS idx_decisions_recorded ON decisions (recorded_at DESC);
`;

export class Ledger {
  readonly #db: DatabaseSync;

  constructor(path = ':memory:') {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.#db = new DatabaseSync(path);
    this.#db.exec('PRAGMA journal_mode = WAL;');
    this.#db.exec('PRAGMA foreign_keys = ON;');
    this.#db.exec(SCHEMA);
  }

  /**
   * Records a message and its decision.
   *
   * Idempotent by message id. Reprocessing the same message must not draw the
   * budget twice, which matters because a retry after a transient perception
   * failure would otherwise quietly eat your remaining attention.
   *
   * Returns false when the message had already been recorded.
   */
  record(message: CanonicalMessage, decision: Decision, recordedAt = new Date().toISOString()): boolean {
    const insertMessage = this.#db.prepare(`
      INSERT OR IGNORE INTO messages
        (id, platform, channel_id, channel_name, person_id, relationship_tier,
         text, timestamp, thread_id, mentions_user)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertDecision = this.#db.prepare(`
      INSERT OR IGNORE INTO decisions
        (message_id, window_key, route, basis, cost, budget_before, budget_after,
         reason, evaluated_at, focus_active, budget_ceiling,
         breakdown_json, context_json, envelope_json, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertMessage.run(
      message.id,
      message.platform,
      message.channelId,
      message.channelName,
      message.personId,
      message.relationshipTier,
      message.text,
      message.timestamp,
      message.threadId,
      message.mentionsUser ? 1 : 0,
    );

    const result = insertDecision.run(
      decision.messageId,
      decision.context.nextDigestAt,
      decision.route,
      decision.basis,
      decision.cost,
      decision.budgetBefore,
      decision.budgetAfter,
      decision.reason,
      decision.context.now,
      decision.context.focusActive ? 1 : 0,
      decision.context.budgetCeiling,
      JSON.stringify(decision.breakdown),
      JSON.stringify(decision.context),
      JSON.stringify(decision.envelope),
      recordedAt,
    );

    return result.changes > 0;
  }

  /**
   * Attention actually spent in this window.
   *
   * Derived as the sum of `budget_before - budget_after`, which is exactly what
   * the engine drew. Summing raw `cost` would be wrong: a non-discretionary
   * message can cost 8.64 against a 3.0 ceiling, and it only ever draws what
   * was left.
   */
  spentInWindow(windowKey: string): number {
    const row = this.#db
      .prepare(
        `SELECT COALESCE(SUM(budget_before - budget_after), 0) AS spent
         FROM decisions WHERE window_key = ?`,
      )
      .get(windowKey) as { spent: number } | undefined;

    return round2(row?.spent ?? 0);
  }

  /** What the next evaluation in this window should be handed as its budget. */
  remainingInWindow(windowKey: string, ceiling: number): number {
    return round2(Math.max(0, ceiling - this.spentInWindow(windowKey)));
  }

  /** Counters for the dashboard. This is the demo's closing shot. */
  counters(windowKey: string, ceiling: number): WindowCounters {
    const byRoute = this.#db
      .prepare(
        `SELECT route, COUNT(*) AS n FROM decisions
         WHERE window_key = ? GROUP BY route`,
      )
      .all(windowKey) as Array<{ route: Route; n: number }>;

    const tally = new Map(byRoute.map((r) => [r.route, r.n]));
    const held = tally.get('hold') ?? 0;
    const digested = tally.get('digest') ?? 0;
    const interrupted = (tally.get('push') ?? 0) + (tally.get('call') ?? 0);
    const spent = this.spentInWindow(windowKey);

    return {
      received: held + digested + interrupted,
      held,
      digested,
      interrupted,
      spent,
      remaining: round2(Math.max(0, ceiling - spent)),
      ceiling,
    };
  }

  /** Most recent decisions, newest first. Feeds the live pipeline view. */
  recent(limit = 50): LedgerEntry[] {
    const rows = this.#db
      .prepare(
        `SELECT m.*, d.* FROM decisions d
         JOIN messages m ON m.id = d.message_id
         ORDER BY d.recorded_at DESC, d.rowid DESC
         LIMIT ?`,
      )
      .all(limit) as Array<Record<string, unknown>>;

    return rows.map(hydrate);
  }

  /**
   * What surfaces at the next release.
   *
   * Only `digest`. Items routed to `hold` are archived deliberately and never
   * surface, because a digest that includes everything is just the unread count
   * with extra steps.
   */
  digestFor(windowKey: string): LedgerEntry[] {
    const rows = this.#db
      .prepare(
        `SELECT m.*, d.* FROM decisions d
         JOIN messages m ON m.id = d.message_id
         WHERE d.window_key = ? AND d.route = 'digest'
         ORDER BY d.cost DESC`,
      )
      .all(windowKey) as Array<Record<string, unknown>>;

    return rows.map(hydrate);
  }

  close(): void {
    this.#db.close();
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function hydrate(row: Record<string, unknown>): LedgerEntry {
  const message: CanonicalMessage = {
    id: row.id as string,
    platform: row.platform as CanonicalMessage['platform'],
    channelId: row.channel_id as string,
    channelName: row.channel_name as string,
    personId: row.person_id as string,
    relationshipTier: row.relationship_tier as CanonicalMessage['relationshipTier'],
    text: row.text as string,
    timestamp: row.timestamp as string,
    threadId: (row.thread_id as string | null) ?? null,
    mentionsUser: row.mentions_user === 1,
  };

  const decision: Decision = {
    messageId: row.message_id as string,
    route: row.route as Decision['route'],
    basis: row.basis as Decision['basis'],
    cost: row.cost as number,
    breakdown: JSON.parse(row.breakdown_json as string),
    budgetBefore: row.budget_before as number,
    budgetAfter: row.budget_after as number,
    reason: row.reason as string,
    context: JSON.parse(row.context_json as string),
    envelope: JSON.parse(row.envelope_json as string),
  };

  return { message, decision, recordedAt: row.recorded_at as string };
}
