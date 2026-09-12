/**
 * Adapter tests.
 *
 * The load-bearing one is the last suite: the same human sending the same words
 * from Slack and from Discord must produce output that is identical everywhere it
 * matters. If those two normalisers ever drift, cross-platform ranking silently
 * becomes cross-platform favouritism.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { IdentityDirectory, type PersonMapping } from '../src/adapters/identity.ts';
import { normaliseDiscordMessage } from '../src/adapters/discord.ts';
import { normaliseSlackMessage, slackTsToIso } from '../src/adapters/slack.ts';

const OWNER_DISCORD = 'D_OWNER';
const OWNER_SLACK = 'U_OWNER';
const SELF_DISCORD = 'D_BOT';

const PEOPLE: PersonMapping[] = [
  {
    personId: 'person:aunt',
    displayName: 'Aunt Thandi',
    tier: 'inner',
    discordUserIds: ['D_AUNT'],
    slackUserIds: ['U_AUNT'],
  },
  {
    personId: 'person:manager',
    displayName: 'Manager',
    tier: 'work',
    slackUserIds: ['U_MGR'],
  },
];

const identity = new IdentityDirectory(PEOPLE);
const discordConfig = { identity, ownerUserId: OWNER_DISCORD, selfUserId: SELF_DISCORD };
const slackConfig = { identity, ownerUserId: OWNER_SLACK };

describe('identity resolution', () => {
  test('the same human on both platforms collapses to one person', () => {
    const viaDiscord = identity.resolve('discord', 'D_AUNT');
    const viaSlack = identity.resolve('slack', 'U_AUNT');

    assert.equal(viaDiscord.personId, 'person:aunt');
    assert.equal(viaSlack.personId, 'person:aunt');
    assert.equal(viaDiscord.relationshipTier, viaSlack.relationshipTier);
  });

  test('an unmapped Slack user defaults to work, an unmapped Discord user to other', () => {
    assert.equal(identity.resolve('slack', 'U_NEW').relationshipTier, 'work');
    assert.equal(identity.resolve('discord', 'D_NEW').relationshipTier, 'other');
  });

  test('an unmapped stranger can never reach the inner tier', () => {
    // Otherwise anyone who wanders into a channel gets the 1.5x multiplier.
    for (const platform of ['slack', 'discord'] as const) {
      assert.notEqual(identity.resolve(platform, 'someone').relationshipTier, 'inner');
    }
  });

  test('unmapped ids are namespaced so platforms cannot collide', () => {
    const a = identity.resolve('slack', 'SAME_ID');
    const b = identity.resolve('discord', 'SAME_ID');
    assert.notEqual(a.personId, b.personId);
    assert.equal(a.inferred, true);
  });

  test('an explicit mapping is not marked inferred', () => {
    assert.equal(identity.resolve('slack', 'U_MGR').inferred, false);
  });
});

describe('Discord normalisation', () => {
  const base = {
    id: '111',
    channelId: 'C_FAMILY',
    channelName: 'family',
    authorId: 'D_AUNT',
    authorUsername: 'thandi',
    content: "Dinner's at 7 tonight btw, are you still coming?",
    createdAt: new Date('2026-09-12T14:30:00.000Z'),
  };

  test('maps to the canonical shape', () => {
    const m = normaliseDiscordMessage(base, discordConfig);
    assert.ok(m);
    assert.equal(m.id, 'discord:111');
    assert.equal(m.platform, 'discord');
    assert.equal(m.personId, 'person:aunt');
    assert.equal(m.relationshipTier, 'inner');
    assert.equal(m.timestamp, '2026-09-12T14:30:00.000Z');
    assert.equal(m.mentionsUser, false);
  });

  test('detects a direct mention of the owner', () => {
    const m = normaliseDiscordMessage(
      { ...base, mentionedUserIds: ['someone', OWNER_DISCORD] },
      discordConfig,
    );
    assert.equal(m?.mentionsUser, true);
  });

  test("the owner's own messages are dropped", () => {
    // An agent that reacts to you talking will interrupt you about your own plans.
    assert.equal(normaliseDiscordMessage({ ...base, authorId: OWNER_DISCORD }, discordConfig), null);
  });

  test('the agent never perceives its own output', () => {
    assert.equal(normaliseDiscordMessage({ ...base, authorId: SELF_DISCORD }, discordConfig), null);
  });

  test('empty content is dropped', () => {
    assert.equal(normaliseDiscordMessage({ ...base, content: '   ' }, discordConfig), null);
  });
});

describe('Slack normalisation', () => {
  const base = {
    ts: '1789012345.000100',
    channel: 'C_DEV',
    channelName: 'dev',
    user: 'U_MGR',
    text: 'When you get a chance, can you review my PR?',
  };

  test('maps to the canonical shape', () => {
    const m = normaliseSlackMessage(base, slackConfig);
    assert.ok(m);
    assert.equal(m.platform, 'slack');
    assert.equal(m.personId, 'person:manager');
    assert.equal(m.relationshipTier, 'work');
  });

  test('the id includes the channel, because ts alone is only unique per channel', () => {
    const a = normaliseSlackMessage(base, slackConfig);
    const b = normaliseSlackMessage({ ...base, channel: 'C_OTHER' }, slackConfig);
    assert.notEqual(a?.id, b?.id);
  });

  test('slack timestamps convert to ISO', () => {
    assert.equal(slackTsToIso('1789012345.000100'), new Date(1789012345000).toISOString());
  });

  test('mentions are read out of the inline encoding', () => {
    const m = normaliseSlackMessage(
      { ...base, text: `<@${OWNER_SLACK}> can you look at this?` },
      slackConfig,
    );
    assert.equal(m?.mentionsUser, true);
  });

  test('subtyped events are not conversation and are dropped', () => {
    for (const subtype of ['channel_join', 'message_changed', 'file_share']) {
      assert.equal(normaliseSlackMessage({ ...base, subtype }, slackConfig), null);
    }
  });

  test("the owner's own messages are dropped", () => {
    assert.equal(normaliseSlackMessage({ ...base, user: OWNER_SLACK }, slackConfig), null);
  });
});

describe('the two adapters are indistinguishable downstream', () => {
  test('same person, same words, two platforms, identical canonical output', () => {
    const text = 'Dinner starts in 5 minutes and everyone is waiting for you.';
    const at = '2026-09-12T14:30:00.000Z';

    const fromDiscord = normaliseDiscordMessage(
      {
        id: '999',
        channelId: 'C_FAMILY',
        channelName: 'family',
        authorId: 'D_AUNT',
        authorUsername: 'thandi',
        content: text,
        createdAt: new Date(at),
      },
      discordConfig,
    );

    const fromSlack = normaliseSlackMessage(
      {
        ts: '1789012200.000000',
        channel: 'C_FAMILY',
        channelName: 'family',
        user: 'U_AUNT',
        text,
      },
      slackConfig,
    );

    assert.ok(fromDiscord && fromSlack);

    // Everything the cost model can see must match. Only `id`, `platform` and
    // `timestamp` may differ, and none of those are policy inputs.
    assert.equal(fromDiscord.personId, fromSlack.personId);
    assert.equal(fromDiscord.relationshipTier, fromSlack.relationshipTier);
    assert.equal(fromDiscord.text, fromSlack.text);
    assert.equal(fromDiscord.channelName, fromSlack.channelName);
    assert.equal(fromDiscord.mentionsUser, fromSlack.mentionsUser);
  });
});
