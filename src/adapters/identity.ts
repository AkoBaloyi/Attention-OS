/**
 * Canonical identity across platforms.
 *
 * This is the piece that makes cross-platform ranking possible at all. Your
 * manager on Slack and your aunt on Discord have to become comparable people
 * before the cost model can weigh one against the other, and the same human
 * appearing in both places has to collapse to one identity rather than
 * competing with themselves.
 *
 * Tiers are assigned explicitly, in configuration, by the user. They are never
 * inferred by a model. Closeness is a fact about your life, not something to be
 * guessed from message text, and guessing it wrong is how a system ends up
 * deciding your mother is less important than a stranger in a work channel.
 */

import type { Platform, RelationshipTier } from '../contracts/message.ts';

export type PersonMapping = {
  /** Canonical id, stable across platforms. Convention: "person:aunt". */
  personId: string;
  displayName: string;
  tier: RelationshipTier;
  /** Native ids this person appears under, per platform. */
  discordUserIds?: readonly string[];
  slackUserIds?: readonly string[];
};

export type ResolvedIdentity = {
  personId: string;
  displayName: string;
  relationshipTier: RelationshipTier;
  /** True when this person had no explicit mapping and fell back to defaults. */
  inferred: boolean;
};

/**
 * Tier used when a person has no explicit mapping.
 *
 * Platform is a genuinely useful prior here and it is the only place platform is
 * allowed to influence anything: someone appearing in your work Slack is
 * probably a colleague, someone appearing in your Discord probably is not. This
 * is a default for strangers, and it is overridden the moment the user maps
 * them. Note it never defaults to `inner`: an unmapped stranger must not be
 * able to reach the highest multiplier.
 */
const FALLBACK_TIER: Record<Platform, RelationshipTier> = {
  slack: 'work',
  discord: 'other',
};

export class IdentityDirectory {
  readonly #byPlatformId = new Map<string, PersonMapping>();
  readonly #people: readonly PersonMapping[];

  constructor(people: readonly PersonMapping[] = []) {
    this.#people = people;

    for (const person of people) {
      for (const id of person.discordUserIds ?? []) {
        this.#byPlatformId.set(key('discord', id), person);
      }
      for (const id of person.slackUserIds ?? []) {
        this.#byPlatformId.set(key('slack', id), person);
      }
    }
  }

  resolve(
    platform: Platform,
    platformUserId: string,
    displayNameHint?: string,
  ): ResolvedIdentity {
    const mapped = this.#byPlatformId.get(key(platform, platformUserId));

    if (mapped) {
      return {
        personId: mapped.personId,
        displayName: mapped.displayName,
        relationshipTier: mapped.tier,
        inferred: false,
      };
    }

    return {
      // Namespaced so an unmapped Slack user and an unmapped Discord user with
      // the same native id can never collide into one person.
      personId: `unmapped:${platform}:${platformUserId}`,
      displayName: displayNameHint ?? platformUserId,
      relationshipTier: FALLBACK_TIER[platform],
      inferred: true,
    };
  }

  /** People with an explicit mapping. Used by the dashboard's allow-list UI. */
  people(): readonly PersonMapping[] {
    return this.#people;
  }
}

function key(platform: Platform, id: string): string {
  return `${platform}:${id}`;
}
