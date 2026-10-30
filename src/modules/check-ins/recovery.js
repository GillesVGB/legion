import { PermissionFlagsBits as P } from 'discord.js';
import { assertUser } from '../../common/errors.js';
import { staffLogChannel } from '../tickets/service.js';
import { communityChannel, serializeCommunity } from '../../common/discord-posts.js';
import { refreshMembers } from '../../common/members.js';
import { planningTime } from '../planning/index.js';
import { operationSettings, WEEKLY_CHECK_CHANNEL_ID } from '../../config/features.js';

const PREFIX = 'BAKAROV_CHECKIN_RECOVERY_V1\n';
const REASONS = new Set(['Wekelijkse activiteitencheck', 'Tweewekelijkse activiteitencheck']);
const MAIN_GUILD = '1555685630640652338';
const snowflake = (value) => typeof value === 'string' && /^\d{17,20}$/.test(value);
const keys = [
  'version',
  'id',
  'guildId',
  'channelId',
  'messageId',
  'deadlineDate',
  'deadlineAt',
  'createdAt',
  'reason',
  'members',
]
  .sort()
  .join(',');
const publicMarker = (id) => `Bakarov • Check-in ${id}`;
const controlMarker = (id) => `Bakarov • Check-inherstel ${id}`;

function manifestOf(message, ctx, guild, now) {
  if (
    message.author?.id !== guild.members.me.id ||
    message.channelId !== ctx.config.logChannelId ||
    typeof message.content !== 'string' ||
    message.content.length > 2000 ||
    !message.content.startsWith(PREFIX)
  )
    return null;
  let value;
  try {
    value = JSON.parse(message.content.slice(PREFIX.length));
  } catch {
    return null;
  }
  if (
    !value ||
    Array.isArray(value) ||
    typeof value !== 'object' ||
    Object.keys(value).sort().join(',') !== keys ||
    message.content !== PREFIX + JSON.stringify(value)
  )
    return null;
  if (
    value.version !== 1 ||
    typeof value.id !== 'string' ||
    !/^([a-f0-9]{12})$/.test(value.id) ||
    value.guildId !== guild.id ||
    value.channelId !== WEEKLY_CHECK_CHANNEL_ID ||
    !snowflake(value.messageId) ||
    !REASONS.has(value.reason)
  )
    return null;
  if (
    !Array.isArray(value.members) ||
    !value.members.length ||
    value.members.length > 1000 ||
    !value.members.every(snowflake) ||
    new Set(value.members).size !== value.members.length
  )
    return null;
  if (
    !Number.isSafeInteger(value.createdAt) ||
    !Number.isSafeInteger(value.deadlineAt) ||
    value.createdAt <= 0 ||
    value.createdAt > now ||
    value.deadlineAt <= now ||
    value.deadlineAt > now + 31 * 86400000 ||
    value.createdAt >= value.deadlineAt ||
    value.deadlineAt - value.createdAt > 31 * 86400000
  )
    return null;
  if (typeof value.deadlineDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.deadlineDate))
    return null;
  try {
    if (
      planningTime(value.deadlineDate, operationSettings(ctx).activityCheck.weeklyTime, now) !==
      value.deadlineAt
    )
      return null;
  } catch {
    return null;
  }
  if (
    !Number.isSafeInteger(message.createdTimestamp) ||
    message.createdTimestamp < value.createdAt - 60000 ||
    message.createdTimestamp > now ||
    message.embeds?.length !== 1 ||
    !message.embeds.some(
      (card) =>
        card.title === 'Bakarov — Activiteitencheck geplaatst' &&
        card.footer?.text === controlMarker(value.id),
    )
  )
    return null;
  return value;
}

function knownConflict(ctx, value) {
  const db = ctx.store.db;
  return Boolean(
    db
      .prepare('SELECT 1 FROM activity_check_sessions WHERE id=? OR message_id=?')
      .get(value.id, value.messageId) ||
      db.prepare("SELECT 1 FROM activity_check_sessions WHERE status='open'").get() ||
      db
        .prepare('SELECT 1 FROM activity_check_occurrences WHERE deadline_date=? OR check_id=?')
        .get(value.deadlineDate, value.id),
  );
}

async function confirmedSnapshotMembers(message, ids, botId) {
  const reaction = message.reactions.cache.get('✅'),
    snapshot = new Set(ids),
    confirmed = new Set();
  assertUser(
    reaction?.me,
    'Het eigen vinkje ontbreekt; de activiteitencheck wordt nog niet hersteld.',
  );
  let after;
  for (let page = 0; page < 100; page++) {
    const users = await reaction.users.fetch({ limit: 100, ...(after ? { after } : {}) });
    for (const user of users.values())
      if (!user.bot && user.id !== botId && snapshot.has(user.id)) confirmed.add(user.id);
    if (users.size < 100) return confirmed;
    const last = users.last()?.id;
    assertUser(
      page < 99 && snowflake(last) && last !== after,
      'De bestaande vinkjes konden niet volledig worden opgehaald. De activiteitencheck wordt nog niet hersteld.',
    );
    after = last;
  }
  return confirmed;
}

/** Bind an explicitly published bot check to the real hosting database, once. */
export async function recoverPublishedActivityChecks(ctx, guild, now = Date.now()) {
  if (ctx.config.guildId !== MAIN_GUILD || guild.id !== MAIN_GUILD) return 0;
  const target = operationSettings(ctx).activityCheck.weeklyChannelId || WEEKLY_CHECK_CHANNEL_ID;
  if (target !== WEEKLY_CHECK_CHANNEL_ID) return 0;
  return serializeCommunity(`${guild.id}:weekly-checkin-recovery`, async () => {
    // The control contains the original member snapshot and must remain private.
    const control = await staffLogChannel(guild, ctx.config);
    assertUser(
      control.permissionsFor(guild.members.me)?.has(P.ReadMessageHistory),
      'De bot kan het privé herstelbericht van de activiteitencheck niet lezen.',
    );
    const history = await control.messages.fetch({ limit: 100 }),
      messages = new Map(history);
    const anchors = Array.isArray(ctx.config.checkinRecoveryMessageIds)
      ? [...new Set(ctx.config.checkinRecoveryMessageIds.filter(snowflake))].slice(0, 32)
      : [];
    for (const id of anchors) {
      const message = await control.messages.fetch({ message: id, force: true }).catch((error) => {
        if (error.code === 10008) return null;
        throw error;
      });
      if (message) messages.set(message.id, message);
    }
    const candidates = [...messages.values()]
      .map((message) => manifestOf(message, ctx, guild, now))
      .filter(Boolean);
    const counts = new Map();
    for (const value of candidates)
      counts.set(value.deadlineDate, (counts.get(value.deadlineDate) || 0) + 1);
    assertUser(
      ![...counts.values()].some((count) => count > 1),
      'Er zijn meerdere herstelberichten voor dezelfde weekcheck. De bot maakt geen extra check of gangwarns.',
    );
    let imported = 0;
    for (const value of candidates) {
      if (knownConflict(ctx, value)) continue;
      const channel = await communityChannel(guild, value.channelId);
      assertUser(
        channel
          .permissionsFor(guild.members.me)
          ?.has([P.EmbedLinks, P.AddReactions, P.ManageMessages]),
        'De bot mist rechten voor het herstellen van de activiteitencheck.',
      );
      const message = await channel.messages.fetch({ message: value.messageId, force: true });
      const description = message?.embeds?.find(
        (card) =>
          card.title === 'Bakarov — Activiteitencheck' &&
          card.footer?.text === publicMarker(value.id),
      )?.description;
      const seconds = Math.floor(value.deadlineAt / 1000),
        lines = typeof description === 'string' ? description.split('\n') : [];
      assertUser(
        message?.author?.id === guild.members.me.id &&
          message.channelId === value.channelId &&
          message.content === `<@&${ctx.config.memberRoleId}>` &&
          Number.isSafeInteger(message.createdTimestamp) &&
          Math.abs(message.createdTimestamp - value.createdAt) <= 60000 &&
          message.createdTimestamp <= now &&
          message.createdTimestamp < value.deadlineAt &&
          lines.includes(`**Reden:** ${value.reason}`) &&
          lines.includes(`**Deadline:** <t:${seconds}:F> · <t:${seconds}:R>`) &&
          lines.includes('**Status:** 🟢 Open') &&
          message.reactions.cache.get('✅')?.me,
        'Het gepubliceerde weekcheckbericht kon niet veilig worden bevestigd. Er worden geen extra check of gangwarns gemaakt.',
      );
      const members = await refreshMembers(guild);
      for (const id of value.members) {
        const member = members.get(id);
        if (member && !member.user.bot && member.roles.cache.has(ctx.config.memberRoleId))
          assertUser(
            channel.permissionsFor(member)?.has([P.ViewChannel, P.ReadMessageHistory]),
            'Niet alle oorspronkelijke Bakarov-leden kunnen de activiteitencheck lezen. Het herstel wacht.',
          );
      }
      // Discord has no reaction timestamps. Existing visible confirmations count
      // conservatively, before any deadline check can create a warning.
      const confirmed = await confirmedSnapshotMembers(message, value.members, guild.members.me.id);
      ctx.store.transaction(() => {
        if (knownConflict(ctx, value)) return;
        ctx.store.db
          .prepare(
            'INSERT INTO activity_check_sessions(id,creator_id,channel_id,message_id,created_at,deadline_at,published_at,reason) VALUES(?,?,?,?,?,?,?,?)',
          )
          .run(
            value.id,
            guild.members.me.id,
            value.channelId,
            value.messageId,
            value.createdAt,
            value.deadlineAt,
            message.createdTimestamp,
            value.reason,
          );
        for (const id of value.members)
          ctx.store.db
            .prepare(
              'INSERT INTO activity_check_members(check_id,user_id,status,responded_at) VALUES(?,?,?,?)',
            )
            .run(
              value.id,
              id,
              confirmed.has(id) ? 'responded' : 'pending',
              confirmed.has(id) ? now : null,
            );
        ctx.store.db
          .prepare('INSERT INTO activity_check_occurrences(deadline_date,check_id) VALUES(?,?)')
          .run(value.deadlineDate, value.id);
        ctx.store.audit('activitycheck.recover-published', guild.members.me.id, {
          id: value.id,
          channel: value.channelId,
          message: value.messageId,
          members: value.members.length,
          confirmed: confirmed.size,
        });
        imported++;
      });
    }
    return imported;
  });
}
