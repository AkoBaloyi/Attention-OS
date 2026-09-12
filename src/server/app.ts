/**
 * The dashboard server.
 *
 * Deliberately node:http and a single self-contained HTML page rather than a
 * bundler and a framework. There is no build step to break, no second dev
 * server, no CORS, and `npm start` runs the entire demo in one command. When you
 * are recording a two minute video, the number of processes that can fail
 * matters more than the number of components you used.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { ceilingFor, computeNextDigestAt, systemClock, type Clock } from '../contracts/context.ts';
import type { Ledger } from '../store/ledger.ts';
import type { Pipeline } from '../runtime/pipeline.ts';
import { SCENARIOS, findScenario, type Scenario } from '../scenarios/reference.ts';
import { answer } from '../voice/ask.ts';
import type { Synthesiser } from '../voice/speak.ts';

const here = dirname(fileURLToPath(import.meta.url));

export type FocusController = {
  isActive(): boolean;
  set(active: boolean): void;
};

/**
 * Owns when the current budget window started.
 *
 * Rolling anchors the window to now, which is what makes the demo reproducible.
 * Left unanchored, a window aligns to the clock hour and cost depends on which
 * minute you are in, so the same scenario yields different numbers between takes.
 */
export type WindowController = {
  anchor(): string | undefined;
  roll(): void;
};

export type ServerDeps = {
  ledger: Ledger;
  pipeline: Pipeline;
  focus: FocusController;
  window?: WindowController;
  clock?: Clock;
  /** Runs a scenario against the real platforms. Absent when no adapter
   * credentials are configured, in which case the endpoint reports why. */
  runScenario?: (scenario: Scenario) => Promise<void>;
  /**
   * Local replay, which bypasses the adapters entirely.
   *
   * main.ts only supplies this when no adapter is connected, so it cannot exist
   * alongside a real source. That is what stops it becoming the thing a demo
   * gets recorded against.
   */
  replayScenario?: (scenario: Scenario) => Promise<void>;
  /** Server-side voice. Absent means the browser speaks, which needs no key. */
  synthesiser?: Synthesiser;
  /** Which adapters actually connected. Shown on the dashboard so the demo can
   * never imply a platform is live when it is not. */
  adapters: () => { discord: boolean; slack: boolean; perception: 'live' | 'stub' };
};

export function createApp(deps: ServerDeps) {
  const clock = deps.clock ?? systemClock;
  const sseClients = new Set<ServerResponse>();

  deps.pipeline.subscribe((event) => {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of sseClients) {
      client.write(payload);
    }
  });

  const windowKey = () => computeNextDigestAt(clock, deps.window?.anchor());

  function state() {
    const windowKey_ = windowKey();
    const ceiling = ceilingFor(deps.focus.isActive());
    return {
      now: clock.now().toISOString(),
      nextDigestAt: windowKey_,
      focusActive: deps.focus.isActive(),
      ...deps.ledger.counters(windowKey_, ceiling),
      adapters: deps.adapters(),
      voice: deps.synthesiser ? 'server' : 'browser',
      // How scenarios reach the pipeline. 'inject' posts over the real platform
      // APIs; 'replay' bypasses the adapters and is development only. The
      // dashboard labels the buttons differently for each.
      scenarioMode: deps.runScenario ? 'inject' : deps.replayScenario ? 'replay' : 'none',
    };
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((error) => {
      json(res, 500, { error: String(error) });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    if (path === '/' || path === '/index.html') {
      const html = await readFile(join(here, 'dashboard.html'), 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    if (path === '/api/state') {
      json(res, 200, state());
      return;
    }

    if (path === '/api/decisions') {
      const limit = Number(url.searchParams.get('limit') ?? 60);
      json(res, 200, deps.ledger.recent(Number.isFinite(limit) ? limit : 60));
      return;
    }

    if (path === '/api/digest') {
      json(res, 200, deps.ledger.digestFor(windowKey()));
      return;
    }

    if (path === '/api/scenarios') {
      json(
        res,
        200,
        SCENARIOS.map((s) => ({
          id: s.id,
          title: s.title,
          proves: s.proves,
          messageCount: s.messages.length,
        })),
      );
      return;
    }

    if (path === '/api/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    if (path === '/api/voice/ask' && req.method === 'POST') {
      const body = (await readJson(req)) as { transcript?: unknown };
      const transcript = typeof body.transcript === 'string' ? body.transcript : '';

      const key = windowKey();
      const ceiling = ceilingFor(deps.focus.isActive());

      // The ledger is handed over as a read-only view. There is no path from a
      // spoken question to a routing decision, and there must never be one.
      json(res, 200, {
        ...answer({
          transcript,
          ledger: deps.ledger,
          windowKey: key,
          counters: deps.ledger.counters(key, ceiling),
          focusActive: deps.focus.isActive(),
        }),
        voice: deps.synthesiser ? 'server' : 'browser',
      });
      return;
    }

    if (path === '/api/voice/speak' && req.method === 'POST') {
      if (!deps.synthesiser) {
        // Not an error. The browser speaks by default and the client falls back
        // to it without needing to be told twice.
        json(res, 409, { error: 'no server voice configured, use browser speech synthesis' });
        return;
      }

      const body = (await readJson(req)) as { text?: unknown };
      const text = typeof body.text === 'string' ? body.text.slice(0, 4000) : '';
      if (text.trim().length === 0) {
        json(res, 400, { error: 'text is required' });
        return;
      }

      try {
        const audio = await deps.synthesiser.synthesise(text);
        res.writeHead(200, {
          'content-type': 'audio/mpeg',
          'content-length': String(audio.byteLength),
          'cache-control': 'no-store',
        });
        res.end(Buffer.from(audio));
      } catch (error) {
        // Degrade rather than go silent: the client retries with the browser voice.
        json(res, 502, { error: String(error) });
      }
      return;
    }

    if (path === '/api/window/reset' && req.method === 'POST') {
      // Rolls the current budget window so the next scenario starts on a full
      // ceiling. It clears recorded decisions rather than exempting anything
      // from the budget.
      //
      // Anchoring to now is the part that matters for the demo: it puts a full
      // hour between now and the next release, so a short deadline is always
      // measured the same way regardless of what time you press the button.
      const cleared = deps.ledger.clearWindow(windowKey());
      deps.window?.roll();
      json(res, 200, { cleared, ...state() });
      return;
    }

    if (path === '/api/focus' && req.method === 'POST') {
      const body = await readJson(req);
      const active = Boolean((body as { active?: unknown }).active);
      deps.focus.set(active);
      deps.pipeline.emit({ kind: 'focus', focusActive: active });
      json(res, 200, state());
      return;
    }

    const scenarioMatch = /^\/api\/scenario\/([A-Za-z0-9_-]+)$/.exec(path);
    if (scenarioMatch && req.method === 'POST') {
      const scenario = findScenario(scenarioMatch[1]!);
      if (!scenario) {
        json(res, 404, { error: `unknown scenario: ${scenarioMatch[1]}` });
        return;
      }
      // Prefer the real path whenever it exists. Replay is only reachable when
      // there is no adapter to inject into.
      const run = deps.runScenario ?? deps.replayScenario;
      if (!run) {
        // Say exactly why rather than failing vaguely.
        json(res, 409, {
          error:
            'no platform credentials configured, so there is nothing to inject into. The injector posts through the real Discord and Slack APIs by design.',
        });
        return;
      }

      // Fire and forget: the scenario spaces its messages out over seconds, and
      // the client is watching the event stream anyway.
      void run(scenario);
      json(res, 202, {
        started: scenario.id,
        messages: scenario.messages.length,
        mode: deps.runScenario ? 'inject' : 'replay',
      });
      return;
    }

    json(res, 404, { error: 'not found' });
  }

  return {
    server,
    state,
    listen: (port: number) =>
      new Promise<void>((resolve) => server.listen(port, () => resolve())),
    close: async () => {
      for (const client of sseClients) client.end();
      sseClients.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}
