/**
 * Configuration.
 *
 * Split on a single rule: secrets come from the environment, structure comes from
 * a committed JSON file. That way `attention.config.example.json` can document
 * the whole shape of a deployment in the repo without a token ever going near it.
 */

import { readFile } from 'node:fs/promises';

import type { PersonMapping } from './adapters/identity.ts';

export type AppConfig = {
  owner: {
    discordUserId: string;
    slackUserId: string;
  };
  people: PersonMapping[];
  /** Symbolic channel key -> real Discord channel id. */
  discordChannels: Record<string, string>;
  /** Symbolic channel key -> real Slack channel id. */
  slackChannels: Record<string, string>;
  /** Symbolic channel key -> Discord webhook url, one per simulated person. */
  discordWebhooks: Record<string, string>;
  /** authorKey -> display name used when injecting. */
  injectorAuthorNames: Record<string, string>;
  /** Slack username override -> canonical person id. */
  slackUsernameToPersonId: Record<string, string>;
  /** Canonical person ids that always get through. Deterministic, not learned. */
  alwaysAllowPersonIds: string[];
};

export type Secrets = {
  openAiApiKey?: string;
  openAiModel?: string;
  discordBotToken?: string;
  slackBotToken?: string;
  slackAppToken?: string;
  ledgerPath: string;
  port: number;
  callEnabled: boolean;
};

const EMPTY: AppConfig = {
  owner: { discordUserId: '', slackUserId: '' },
  people: [],
  discordChannels: {},
  slackChannels: {},
  discordWebhooks: {},
  injectorAuthorNames: {},
  slackUsernameToPersonId: {},
  alwaysAllowPersonIds: [],
};

export async function loadConfig(path = 'attention.config.json'): Promise<AppConfig> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<AppConfig>;
    return { ...EMPTY, ...parsed, owner: { ...EMPTY.owner, ...parsed.owner } };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // Absent config is a normal first run, not a failure. The dashboard will
      // report which adapters are live, which will be none.
      return EMPTY;
    }
    throw new Error(`could not read ${path}: ${String(error)}`);
  }
}

export function loadSecrets(env = process.env): Secrets {
  return {
    openAiApiKey: nonEmpty(env.OPENAI_API_KEY),
    openAiModel: nonEmpty(env.OPENAI_MODEL),
    discordBotToken: nonEmpty(env.DISCORD_BOT_TOKEN),
    slackBotToken: nonEmpty(env.SLACK_BOT_TOKEN),
    slackAppToken: nonEmpty(env.SLACK_APP_TOKEN),
    ledgerPath: nonEmpty(env.LEDGER_PATH) ?? './data/ledger.sqlite',
    port: Number(env.PORT ?? 4317),
    callEnabled: env.CALL_ENABLED === 'true',
  };
}

/** Treats an unset variable and one set to the empty string as the same thing,
 * which matters because a half-filled .env is the common case. */
function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
