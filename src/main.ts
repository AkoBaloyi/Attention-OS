/**
 * Entry point. Wires the adapters into the pipeline and serves the dashboard.
 *
 * Everything degrades rather than refusing to start. A missing Discord token
 * means no Discord, a missing OpenAI key means scripted perception, and either
 * way the dashboard says so out loud. This matters during a build: you want to be
 * able to see the parts that do work while the parts that do not are still
 * waiting on credentials.
 */

import { loadConfig, loadSecrets } from './config.ts';
import { IdentityDirectory } from './adapters/identity.ts';
import { startDiscordAdapter } from './adapters/discord.ts';
import { startSlackAdapter } from './adapters/slack.ts';
import { createPerceiver, openAiTransport } from './perception/perceiver.ts';
import { scriptedTransport } from './perception/scripted.ts';
import { Ledger } from './store/ledger.ts';
import { createPipeline } from './runtime/pipeline.ts';
import { createApp } from './server/app.ts';
import { createInjector } from './scenarios/injector.ts';
import type { Scenario } from './scenarios/reference.ts';

const config = await loadConfig();
const secrets = loadSecrets();

const identity = new IdentityDirectory(config.people);
const ledger = new Ledger(secrets.ledgerPath);

const perceptionMode = secrets.openAiApiKey ? 'live' : 'stub';
const perceiver = createPerceiver({
  transport: secrets.openAiApiKey
    ? openAiTransport({ apiKey: secrets.openAiApiKey, model: secrets.openAiModel })
    : scriptedTransport(),
});

let focusActive = false;
const focus = {
  isActive: () => focusActive,
  set: (active: boolean) => {
    focusActive = active;
    log(`focus mode ${active ? 'on' : 'off'}`);
  },
};

const alwaysAllow = new Set(config.alwaysAllowPersonIds);

const pipeline = createPipeline({
  perceiver,
  ledger,
  getFocusActive: () => focusActive,
  getPolicyOptions: () => ({
    alwaysAllowPersonIds: alwaysAllow,
    callEnabled: secrets.callEnabled,
  }),
  onError: (error) => log(`pipeline error: ${String(error)}`),
});

// Log every decision, so the terminal is a usable second view during a demo.
pipeline.subscribe((event) => {
  if (event.kind !== 'decision') return;
  const { decision, message } = event;
  log(
    `${decision.route.toUpperCase().padEnd(6)} cost ${decision.cost.toFixed(2).padStart(6)}  ` +
      `budget ${decision.budgetBefore.toFixed(2)} -> ${decision.budgetAfter.toFixed(2)}  ` +
      `[${message.platform}/#${message.channelName}] ${truncate(message.text, 60)}`,
  );
});

// --- Adapters -------------------------------------------------------------

const live = { discord: false, slack: false };
const stopping: Array<() => Promise<void>> = [];

if (secrets.discordBotToken && config.owner.discordUserId) {
  try {
    const adapter = await startDiscordAdapter({
      token: secrets.discordBotToken,
      channelIds: Object.values(config.discordChannels),
      config: { identity, ownerUserId: config.owner.discordUserId },
      onMessage: (message) => void pipeline.ingest(message),
      onError: (error) => log(`discord: ${String(error)}`),
    });
    stopping.push(adapter.stop);
    live.discord = true;
    log('discord adapter connected');
  } catch (error) {
    log(`discord adapter failed to start: ${String(error)}`);
  }
} else {
  log('discord adapter skipped: DISCORD_BOT_TOKEN or owner.discordUserId missing');
}

if (secrets.slackBotToken && secrets.slackAppToken && config.owner.slackUserId) {
  try {
    const adapter = await startSlackAdapter({
      botToken: secrets.slackBotToken,
      appToken: secrets.slackAppToken,
      config: {
        identity,
        ownerUserId: config.owner.slackUserId,
        usernameToPersonId: config.slackUsernameToPersonId,
      },
      onMessage: (message) => void pipeline.ingest(message),
      onError: (error) => log(`slack: ${String(error)}`),
    });
    stopping.push(adapter.stop);
    live.slack = true;
    log('slack adapter connected (socket mode)');
  } catch (error) {
    log(`slack adapter failed to start: ${String(error)}`);
  }
} else {
  log('slack adapter skipped: SLACK_BOT_TOKEN, SLACK_APP_TOKEN or owner.slackUserId missing');
}

// --- Injector -------------------------------------------------------------

const canInject =
  Object.keys(config.discordWebhooks).length > 0 || Boolean(secrets.slackBotToken);

const injector = canInject
  ? createInjector({
      discord: {
        webhooks: config.discordWebhooks,
        authorNames: config.injectorAuthorNames,
      },
      slack: {
        botToken: secrets.slackBotToken ?? '',
        channels: config.slackChannels,
        authorNames: config.injectorAuthorNames,
      },
      ownerDiscordUserId: config.owner.discordUserId || undefined,
      ownerSlackUserId: config.owner.slackUserId || undefined,
    })
  : undefined;

const runScenario = injector
  ? async (scenario: Scenario) => {
      log(`injecting scenario ${scenario.id}: ${scenario.title}`);
      const result = await injector.run(scenario);
      log(`scenario ${scenario.id}: posted ${result.posted}, failed ${result.failures.length}`);
      for (const failure of result.failures) {
        log(`  injection failed: ${failure.error}`);
        pipeline.emit({
          kind: 'error',
          messageId: `scenario:${scenario.id}`,
          stage: 'policy',
          error: failure.error,
        });
      }
    }
  : undefined;

// --- Server ---------------------------------------------------------------

const app = createApp({
  ledger,
  pipeline,
  focus,
  runScenario,
  adapters: () => ({ ...live, perception: perceptionMode }),
});

await app.listen(secrets.port);

log('');
log(`  Attention OS  ->  http://localhost:${secrets.port}`);
log(`  perception: ${perceptionMode}${perceptionMode === 'stub' ? '  (no OPENAI_API_KEY, replaying scripted reference envelopes)' : ''}`);
log(`  sources: ${live.discord ? 'discord' : '-'} ${live.slack ? 'slack' : '-'}`);
log(`  injector: ${injector ? 'ready' : 'unavailable, no webhooks or slack token configured'}`);
log(`  ledger: ${secrets.ledgerPath}`);
log('');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void (async () => {
      log('shutting down');
      await Promise.allSettled(stopping.map((stop) => stop()));
      await app.close();
      ledger.close();
      process.exit(0);
    })();
  });
}

function log(message: string): void {
  if (message === '') {
    console.log('');
    return;
  }
  console.log(`[attention-os] ${message}`);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}\u2026`;
}
