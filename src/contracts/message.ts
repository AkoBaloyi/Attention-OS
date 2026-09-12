/**
 * The canonical message shape emitted by every platform adapter.
 *
 * CONTRACT RULE: nothing downstream of the adapters is allowed to branch on
 * `platform`. It exists for display and for auditing only. The policy engine
 * must be unable to tell Discord from Slack, because the whole thesis is that
 * one attention budget is shared across both halves of your life. If policy
 * could see the source it would be arbitrating between apps rather than
 * between people, which is what every existing notification system already
 * does badly.
 */

export type Platform = 'discord' | 'slack';

/**
 * How close someone is to you. Assigned explicitly via configuration, never
 * inferred by a model. Platform is only used as the fallback when a person
 * has no explicit mapping (Slack implies work, Discord implies other).
 */
export type RelationshipTier = 'inner' | 'work' | 'other';

export type CanonicalMessage = {
  /** Platform-prefixed so ids are globally unique: "discord:12345" */
  id: string;
  platform: Platform;
  channelId: string;
  channelName: string;
  /** Canonical human. The same person across platforms resolves to one id. */
  personId: string;
  relationshipTier: RelationshipTier;
  text: string;
  /** ISO 8601, UTC. */
  timestamp: string;
  threadId: string | null;
  /** True if the owner of this Attention OS instance was directly mentioned. */
  mentionsUser: boolean;
};
