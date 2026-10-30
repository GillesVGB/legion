import { recoverPublishedActivityChecks } from './recovery.js';
import { warnAppealRow } from '../moderation/appeal-ui.js';
import { canonicalBrandText } from '../../ui/branding.js';
import { randomBytes, createHash } from 'node:crypto';
import { MessageFlags, PermissionFlagsBits as P } from 'discord.js';
import { assertUser, UserError } from '../../common/errors.js';
import { embed, safeText } from '../../ui/messages.js';
import { quiet, requireStaff, warnLogChannel } from '../tickets/service.js';
import {
  serializeCommunity,
  communityChannel,
  updateCommunityPost,
} from '../../common/discord-posts.js';
import { refreshMembers } from '../../common/members.js';
import { planningTime, requirePlanningGuild } from '../planning/index.js';
import { missionDay } from '../games/mission-definitions.js';
import { queueFeatureNotice, deliverFeatureNotices } from '../../common/notices.js';
import { operationSettings, WEEKLY_CHECK_CHANNEL_ID } from '../../config/features.js';

const checkById = (ctx, id) =>
  ctx.store.db.prepare('SELECT * FROM activity_check_sessions WHERE id=?').get(id);
const membersOf = (ctx, id) =>
  ctx.store.db
    .prepare('SELECT * FROM activity_check_members WHERE check_id=? ORDER BY user_id')
    .all(id);
const marker = (id) => `Bakarov • Check-in ${id}`;
const eligible = (ctx, member) =>
  Boolean(member && !member.user.bot && member.roles.cache.has(ctx.config.memberRoleId));
async function checkStaff(ctx, guild, member) {
  requirePlanningGuild(ctx);
  assertUser(guild.id === ctx.config.guildId, 'Gebruik de Bakarov-hoofdserver.');
  const actor = await guild.members.fetch({ user: member.id, force: true });
  requireStaff({ member: actor, memberPermissions: actor.permissions }, ctx.config);
  assertUser(!actor.user.bot, 'Alleen de leiding kan activiteiten controleren.');
  return actor;
}
export function activityCheckMessage(ctx, check) {
  const members = membersOf(ctx, check.id),
    count = (status) => members.filter((item) => item.status === status).length;
  const open = check.status === 'open';
  const card = embed(
    ctx.config,
    'Bakarov — Activiteitencheck',
    `Laat weten dat je nog actief bent binnen Bakarov. Reageer vóór de deadline met **✅** onder dit bericht. Een geregistreerde bevestiging blijft bewaard.\n\n${check.reason ? `**Reden:** ${safeText(check.reason)}\n` : ''}**Deadline:** <t:${Math.floor(check.deadline_at / 1000)}:F> · <t:${Math.floor(check.deadline_at / 1000)}:R>\n**Bevestigd:** ${count('responded')}/${members.length}\n**Status:** ${open ? '🟢 Open' : check.status === 'closed' ? '🔒 Afgerond' : '⚪ Geannuleerd'}\n\n${open ? 'Niet op tijd bevestigd en geen goedgekeurde afwezigheid? Dan geeft de bot na de deadline automatisch één gangwarn. Dit geldt voor de Bakarov-leden die bij het starten van deze check zijn opgenomen.' : check.status === 'closed' ? `**Goedgekeurd afwezig:** ${count('exempt')}\n**Gangwarns:** ${count('warned')}\n**Niet meer verplicht:** ${count('left')}` : 'Deze check is geannuleerd. Er volgen geen nieuwe gangwarns.'}\n\nDeze check-in bevestigt je activiteit binnen Bakarov. Je Discord-status bepaalt niet of je een gangwarn krijgt.`,
  )
    .setColor(open ? 0x22c55e : check.status === 'closed' ? 0x64748b : 0xf59e0b)
    .setFooter({ text: marker(check.id) });
  for (const [status, label] of [
    ['responded', '✅ Actief bevestigd'],
    ['exempt', 'Goedgekeurd afwezig'],
    ['warned', 'Gangwarn gegeven'],
  ]) {
    const list = members.filter((item) => item.status === status);
    if (list.length)
      card.addFields({
        name: label,
        value:
          list
            .slice(0, 25)
            .map((item) => `<@${item.user_id}>`)
            .join(', ') +
          (list.length > 25
            ? `\n… en ${list.length - 25} anderen. Zie het dashboard voor de volledige lijst.`
            : ''),
      });
  }
  return {
    content: `<@&${ctx.config.memberRoleId}>`,
    embeds: [card],
    components: [],
    allowedMentions: quiet,
  };
}
export async function publishActivityCheck(ctx, guild, id) {
  return serializeCommunity(`${guild.id}:checkin:${id}`, async () => {
    const check = checkById(ctx, id);
    assertUser(check, 'Deze activiteitencheck bestaat niet.');
    const posted = await updateCommunityPost(
      ctx,
      guild,
      'activity_check_sessions',
      check,
      activityCheckMessage(ctx, check),
      marker(id),
      { parse: [], roles: [ctx.config.memberRoleId], users: [], repliedUser: false },
    );
    if (posted && check.status === 'open' && Date.now() < check.deadline_at) {
      try {
        if (!posted.reactions.cache.get('✅')?.me) await posted.react('✅');
      } catch (error) {
        ctx.store.db
          .prepare('UPDATE activity_check_sessions SET dirty=1,last_error=? WHERE id=?')
          .run(String(error.code || error.name), id);
        throw error;
      }
      if (check.published_at === null)
        ctx.store.db
          .prepare('UPDATE activity_check_sessions SET published_at=? WHERE id=?')
          .run(Date.now(), id);
    }
    return posted;
  });
}
export async function createActivityCheck(ctx, guild, member, input, now = Date.now()) {
  const actor = await checkStaff(ctx, guild, member);
  return createCheck(ctx, guild, actor, input, now);
}
async function createCheck(ctx, guild, actor, input, now) {
  requirePlanningGuild(ctx);
  const reason = String(input.reason || '').trim();
  assertUser(reason.length <= 300, 'Gebruik een reden van maximaal 300 tekens.');
  const deadline = planningTime(input.date, input.time, now);
  assertUser(
    deadline >= now + 60000 && deadline <= now + 31 * 86400000,
    'Kies een deadline vanaf één minuut in de toekomst, binnen 31 dagen.',
  );
  const channel = await communityChannel(guild, input.channelId);
  assertUser(
    channel.permissionsFor(guild.members.me)?.has([P.EmbedLinks, P.AddReactions, P.ManageMessages]),
    'Geef de bot Links insluiten, Reacties toevoegen en Berichten beheren in het check-in-kanaal.',
  );
  assertUser(ctx.config.memberRoleId, 'Stel eerst de Bakarov-ledenrol in.');
  const role = await guild.roles.fetch(ctx.config.memberRoleId);
  assertUser(
    role && (role.mentionable || channel.permissionsFor(guild.members.me)?.has(P.MentionEveryone)),
    'De bot kan Bakarov nog niet taggen. Maak de Bakarov-rol vermeldbaar of geef de bot Iedereen, @here en alle rollen vermelden in dit kanaal.',
  );
  const members = await refreshMembers(guild),
    targets = [...members.values()].filter((member) => eligible(ctx, member));
  assertUser(targets.length, 'Er zijn geen mensen met de Bakarov-ledenrol om te controleren.');
  assertUser(
    targets.every((target) =>
      channel.permissionsFor(target)?.has([P.ViewChannel, P.ReadMessageHistory]),
    ),
    'Kies een kanaal dat alle Bakarov-leden kunnen bekijken. Anders kunnen zij niet op de check reageren.',
  );
  const id = randomBytes(6).toString('hex');
  ctx.store.transaction(() => {
    assertUser(
      !input.scheduleDate ||
        !ctx.store.db
          .prepare('SELECT 1 FROM activity_check_occurrences WHERE deadline_date=?')
          .get(input.scheduleDate),
      'Deze weekcheck bestaat al.',
    );
    assertUser(
      !ctx.store.db.prepare("SELECT 1 FROM activity_check_sessions WHERE status='open'").get(),
      'Er loopt al een activiteitencheck. Wacht tot deze is afgerond of annuleer die eerst.',
    );
    ctx.store.db
      .prepare(
        'INSERT INTO activity_check_sessions(id,creator_id,channel_id,created_at,deadline_at) VALUES(?,?,?,?,?)',
      )
      .run(id, actor.id, channel.id, now, deadline);
    ctx.store.db.prepare('UPDATE activity_check_sessions SET reason=? WHERE id=?').run(reason, id);
    if (input.scheduleDate)
      ctx.store.db
        .prepare('INSERT INTO activity_check_occurrences(deadline_date,check_id) VALUES(?,?)')
        .run(input.scheduleDate, id);
    for (const target of targets)
      ctx.store.db
        .prepare('INSERT INTO activity_check_members(check_id,user_id) VALUES(?,?)')
        .run(id, target.id);
    ctx.store.audit('activitycheck.create', actor.id, {
      id,
      deadline,
      members: targets.length,
      channel: channel.id,
    });
  });
  const posted = await publishActivityCheck(ctx, guild, id).catch((error) => {
    ctx.store.db
      .prepare('UPDATE activity_check_sessions SET last_error=?,next_attempt=? WHERE id=?')
      .run(String(error.code || error.name), now + 60000, id);
    return null;
  });
  return { check: checkById(ctx, id), posted };
}
export async function respondActivityCheck(ctx, guild, member, id, binding, now = Date.now()) {
  requirePlanningGuild(ctx);
  return serializeCommunity(`${guild.id}:checkin:${id}`, async () => {
    const check = checkById(ctx, id);
    assertUser(
      check &&
        guild.id === ctx.config.guildId &&
        binding.channelId === check.channel_id &&
        binding.messageId === check.message_id,
      'Deze reactie hoort niet bij deze activiteitencheck.',
    );
    assertUser(
      check.status === 'open' && now < check.deadline_at,
      'De deadline is verstreken of deze activiteitencheck is gesloten.',
    );
    const target = await guild.members.fetch({ user: member.id, force: true });
    assertUser(eligible(ctx, target), 'Alleen Bakarov-leden kunnen hun activiteit bevestigen.');
    const entry = ctx.store.db
      .prepare('SELECT * FROM activity_check_members WHERE check_id=? AND user_id=?')
      .get(id, target.id);
    assertUser(
      entry,
      'Je bent na het starten van deze check toegevoegd en hoeft hier niet aan mee te doen.',
    );
    if (entry.responded_at !== null) return false;
    ctx.store.transaction(() => {
      ctx.store.db
        .prepare(
          "UPDATE activity_check_members SET status='responded',responded_at=? WHERE check_id=? AND user_id=?",
        )
        .run(now, id, target.id);
      ctx.store.db
        .prepare('UPDATE activity_check_sessions SET dirty=1,next_attempt=0 WHERE id=?')
        .run(id);
      ctx.store.audit('activitycheck.respond', target.id, { id });
    });
    return true;
  });
}
export async function cancelActivityCheck(ctx, guild, member, id) {
  const actor = await checkStaff(ctx, guild, member);
  await serializeCommunity(`${guild.id}:checkin:${id}`, () => {
    const check = checkById(ctx, id);
    assertUser(check?.status === 'open', 'Deze activiteitencheck is al afgesloten.');
    ctx.store.transaction(() => {
      ctx.store.db
        .prepare(
          "UPDATE activity_check_sessions SET status='cancelled',dirty=1,next_attempt=0 WHERE id=?",
        )
        .run(id);
      ctx.store.audit('activitycheck.cancel', actor.id, { id });
    });
  });
  await publishActivityCheck(ctx, guild, id).catch((error) =>
    ctx.store.db
      .prepare('UPDATE activity_check_sessions SET last_error=?,next_attempt=? WHERE id=?')
      .run(String(error.code || error.name), Date.now() + 60000, id),
  );
}
export async function finishActivityCheck(ctx, guild, id, now = Date.now()) {
  requirePlanningGuild(ctx);
  return serializeCommunity(`${guild.id}:checkin:${id}`, async () => {
    const check = checkById(ctx, id);
    if (!check || check.status !== 'open' || now < check.deadline_at) return;
    // Een ongepubliceerde, te laat gepubliceerde of verwijderde check geeft geen warns.
    const channel = await communityChannel(guild, check.channel_id);
    const message = check.message_id
      ? await channel.messages.fetch({ message: check.message_id, force: true }).catch((error) => {
          if (error.code === 10008) return null;
          throw error;
        })
      : null;
    if (
      !message ||
      message.author.id !== guild.members.me.id ||
      check.published_at === null ||
      check.published_at >= check.deadline_at
    ) {
      ctx.store.transaction(() => {
        ctx.store.db
          .prepare(
            "UPDATE activity_check_sessions SET status='cancelled',dirty=1,next_attempt=0,last_error='CHECK_NOT_AVAILABLE' WHERE id=?",
          )
          .run(id);
        ctx.store.audit('activitycheck.unavailable', guild.members.me.id, { id });
      });
      return;
    }
    const members = await refreshMembers(guild),
      date = missionDay(check.deadline_at),
      reacted = await checkReactionUsers(message);
    ctx.store.transaction(() => {
      for (const entry of membersOf(ctx, id)) {
        if (entry.responded_at !== null) continue;
        const member = members.get(entry.user_id),
          away = ctx.store.db
            .prepare(
              "SELECT 1 FROM absence_requests WHERE user_id=? AND kind='range' AND status='approved' AND start_date<=? AND end_date>=?",
            )
            .get(entry.user_id, date, date);
        if (
          !eligible(ctx, member) ||
          !channel.permissionsFor(member)?.has([P.ViewChannel, P.ReadMessageHistory]) ||
          away
        ) {
          ctx.store.db
            .prepare('UPDATE activity_check_members SET status=? WHERE check_id=? AND user_id=?')
            .run(away ? 'exempt' : 'left', id, entry.user_id);
          continue;
        }
        // Discord bewaart geen reactietijd. Herstelde vinkjes tellen mee, zodat een
        // gemist gateway-event of een botonderbreking geen onterechte warn geeft.
        if (reacted.has(entry.user_id)) {
          ctx.store.db
            .prepare(
              "UPDATE activity_check_members SET status='responded',responded_at=? WHERE check_id=? AND user_id=?",
            )
            .run(now, id, entry.user_id);
          continue;
        }
        const reason = `${check.reason ? `${check.reason}: ` : ''}Niet op tijd bevestigd op activiteitencheck ${id}. Deadline: ${new Date(check.deadline_at).toLocaleString('nl-BE', { timeZone: 'Europe/Brussels' })} (Belgische tijd).`;
        const warning = ctx.store.addWarnInside(entry.user_id, guild.members.me.id, reason, now);
        ctx.store.db
          .prepare(
            'INSERT INTO activity_check_warnings(activity_id,user_id,warn_id,created_at) VALUES(?,?,?,?)',
          )
          .run(id, entry.user_id, warning.id, now);
        ctx.store.db
          .prepare(
            "UPDATE activity_check_members SET status='warned',warn_id=? WHERE check_id=? AND user_id=?",
          )
          .run(warning.id, id, entry.user_id);
        queueFeatureNotice(ctx, {
          key: `activity.warn:${id}:${entry.user_id}`,
          kind: 'activity.warn',
          user: entry.user_id,
          now,
          payload: {
            components: [warnAppealRow(ctx.config.guildId, warning.id)],
            embeds: [
              embed(
                ctx.config,
                'Bakarov — Gangwarn: activiteitencheck',
                `${safeText(reason)}\n\nJe had vóór de deadline niet met **✅** gereageerd en geen goedgekeurde afwezigheid.\n**Actieve gangwarns:** ${warning.count}\n**Warn-ID:** \`${warning.id}\`\n[Check-in bekijken](https://discord.com/channels/${guild.id}/${check.channel_id}/${check.message_id})\nNeem contact op met de leiding als deze waarschuwing niet klopt.`,
              ).setColor(0xef4444),
            ],
          },
        });
      }
      ctx.store.db
        .prepare(
          "UPDATE activity_check_sessions SET status='closed',checked_at=?,dirty=1,next_attempt=0,last_error=NULL WHERE id=?",
        )
        .run(now, id);
      ctx.store.audit('activitycheck.finish', guild.members.me.id, {
        id,
        results: membersOf(ctx, id),
      });
    });
    return checkById(ctx, id);
  });
}

export async function syncActivityWarnings(ctx, guild, now = Date.now()) {
  return serializeCommunity(`${guild.id}:activity-warn-notices`, async () => {
    const db = ctx.store.db;
    for (const item of db
      .prepare(
        `SELECT c.*,w.reason,w.removed_at FROM activity_check_warnings c JOIN warnings w ON w.id=c.warn_id
      WHERE c.log_id IS NULL AND c.next_attempt<=? ORDER BY c.created_at LIMIT 30`,
      )
      .all(now)) {
      try {
        if (item.removed_at !== null) {
          db.prepare(
            "UPDATE activity_check_warnings SET log_id='skipped',last_error=NULL WHERE warn_id=?",
          ).run(item.warn_id);
          continue;
        }
        const channel = await warnLogChannel(guild, ctx.config),
          marker = `Bakarov • Activiteitencheck ${item.warn_id}`;
        let message;
        if (channel.permissionsFor(guild.members.me)?.has(P.ReadMessageHistory)) {
          const history = await channel.messages.fetch({ limit: 100 });
          message = [...history.values()].find(
            (value) =>
              value.author.id === guild.members.me.id &&
              value.embeds?.some((card) => canonicalBrandText(card.footer?.text) === marker),
          );
        }
        const count = ctx.store.warnCount(item.user_id),
          threshold =
            count >= ctx.config.warnThreshold
              ? `\n⚠️ Drempel bereikt: ${count}/${ctx.config.warnThreshold}. De leiding moet dit beoordelen.`
              : '';
        message ??= await channel.send({
          components: [warnAppealRow(ctx.config.guildId, item.warn_id)],
          embeds: [
            embed(
              ctx.config,
              'Bakarov — Gangwarn: activiteitencheck',
              `**Lid:** <@${item.user_id}>\n**Reden:** ${safeText(item.reason)}\n**Warn-ID:** \`${item.warn_id}\`\n**Actieve warns:** ${count}${threshold}`,
            )
              .setColor(0xef4444)
              .setFooter({ text: marker }),
          ],
          nonce: `ac:${item.warn_id}`,
          enforceNonce: true,
          allowedMentions: quiet,
        });
        db.prepare(
          'UPDATE activity_check_warnings SET log_id=?,last_error=NULL WHERE warn_id=?',
        ).run(message.id, item.warn_id);
      } catch (error) {
        db.prepare(
          'UPDATE activity_check_warnings SET next_attempt=?,last_error=? WHERE warn_id=?',
        ).run(now + 60000, String(error.code || error.name), item.warn_id);
      }
    }
    await deliverFeatureNotices(
      ctx,
      guild,
      now,
      (item) => {
        const warning = db
          .prepare(
            "SELECT w.removed_at FROM activity_check_warnings c JOIN warnings w ON w.id=c.warn_id WHERE c.user_id=? AND ? = 'activity.warn:' || c.activity_id || ':' || c.user_id",
          )
          .get(item.user_id, item.notice_key);
        return Boolean(warning && warning.removed_at === null);
      },
      ['activity.warn'],
    );
  });
}

export async function handleActivitiesCheck(ctx, interaction) {
  requireStaff(interaction, ctx.config);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const result = await createActivityCheck(ctx, interaction.guild, interaction.member, {
    date: interaction.options.getString('datum', true),
    time: interaction.options.getString('tijd', true),
    channelId: interaction.options.getChannel('kanaal')?.id || interaction.channelId,
    reason: interaction.options.getString('reden') || '',
  });
  return interaction.editReply({
    content: result.posted
      ? `Activiteitencheck geplaatst in <#${result.check.channel_id}>. Leden reageren vóór <t:${Math.floor(result.check.deadline_at / 1000)}:F> met **✅**. Na de deadline controleert de bot automatisch wie niet heeft gereageerd.`
      : 'Activiteitencheck opgeslagen. Het plaatsen wordt opnieuw geprobeerd. Zolang de check niet op tijd is geplaatst, worden er geen gangwarns gegeven.',
    allowedMentions: quiet,
  });
}
async function checkReactionUsers(message) {
  const result = new Set(),
    reaction = message.reactions.cache.get('✅');
  assertUser(
    reaction?.me,
    'Het vinkje van de check ontbreekt. De controle wacht; er worden geen gangwarns gegeven.',
  );
  let after;
  for (let page = 0; page < 100; page++) {
    const users = await reaction.users.fetch({ limit: 100, ...(after ? { after } : {}) });
    for (const user of users.values()) if (!user.bot) result.add(user.id);
    if (users.size < 100) return result;
    assertUser(
      page < 99,
      'De vinkjes konden niet volledig worden opgehaald; er worden geen gangwarns gegeven.',
    );
    after = users.last().id;
  }
  return result;
}
export async function handleActivityCheckReaction(ctx, reaction, user, added, now = Date.now()) {
  if (
    !added ||
    user.bot ||
    reaction.emoji.name !== '✅' ||
    ctx.config.guildId !== '1555685630640652338'
  )
    return;
  const check =
    ctx.store.db
      .prepare('SELECT * FROM activity_check_sessions WHERE message_id=? AND channel_id=?')
      .get(reaction.message.id, reaction.message.channelId) ||
    checkById(
      ctx,
      ctx.store.setting(
        `activitycheck:moved-from:${reaction.message.channelId}:${reaction.message.id}`,
      ) || '',
    );
  if (!check) return;
  if (check.status !== 'open' || now >= check.deadline_at) {
    await reaction.users.remove(user.id);
    return;
  }
  if (
    !ctx.store.db
      .prepare('SELECT 1 FROM activity_check_members WHERE check_id=? AND user_id=?')
      .get(check.id, user.id)
  )
    return;
  try {
    await respondActivityCheck(
      ctx,
      reaction.message.guild,
      { id: user.id },
      check.id,
      { channelId: check.channel_id, messageId: check.message_id },
      now,
    );
  } catch (error) {
    if (
      error instanceof UserError ||
      error.code === 10007 ||
      checkById(ctx, check.id)?.status !== 'open'
    )
      return;
    throw error;
  }
  await publishActivityCheck(ctx, reaction.message.guild, check.id).catch(() => {});
}
export async function handleStopActivityCheck(ctx, interaction) {
  requirePlanningGuild(ctx);
  requireStaff(interaction, ctx.config);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const check = ctx.store.db
    .prepare("SELECT * FROM activity_check_sessions WHERE status='open'")
    .get();
  assertUser(check, 'Er loopt geen activiteitencheck.');
  await cancelActivityCheck(ctx, interaction.guild, interaction.member, check.id);
  return interaction.editReply({
    content: 'Activiteitencheck geannuleerd. Er volgen geen nieuwe gangwarns.',
    allowedMentions: quiet,
  });
}
async function syncOpenCheckReactions(ctx, guild, id, now) {
  return serializeCommunity(`${guild.id}:checkin:${id}`, async () => {
    const check = checkById(ctx, id);
    if (check?.status !== 'open' || now >= check.deadline_at || !check.message_id) return false;
    const channel = await communityChannel(guild, check.channel_id),
      message = await channel.messages.fetch({ message: check.message_id, force: true });
    assertUser(message?.author.id === guild.members.me.id, 'Het check-in-bericht ontbreekt.');
    if (!message.reactions.cache.get('✅')?.me) await message.react('✅');
    const reacted = await checkReactionUsers(message);
    let changed = 0;
    ctx.store.transaction(() => {
      for (const user of reacted)
        changed += ctx.store.db
          .prepare(
            "UPDATE activity_check_members SET status='responded',responded_at=? WHERE check_id=? AND user_id=? AND responded_at IS NULL",
          )
          .run(now, id, user).changes;
      if (changed) {
        ctx.store.db
          .prepare('UPDATE activity_check_sessions SET dirty=1,next_attempt=0 WHERE id=?')
          .run(id);
        ctx.store.audit('activitycheck.reconcile', guild.members.me.id, { id, restored: changed });
      }
    });
    return changed > 0;
  });
}
export async function syncActivityChecks(ctx, guild, now = Date.now()) {
  if (ctx.config.guildId !== '1555685630640652338') return;
  await recoverPublishedActivityChecks(ctx, guild, now);
  await cleanupMovedActivityChecks(ctx, guild, now);
  if (ctx.store.setting('activitycheck:layout') !== '2') {
    ctx.store.transaction(() => {
      ctx.store.db
        .prepare("UPDATE activity_check_sessions SET dirty=1,next_attempt=0 WHERE status='open'")
        .run();
      ctx.store.setSetting('activitycheck:layout', '2');
    });
  }
  for (const item of ctx.store.db
    .prepare(
      "SELECT id FROM activity_check_sessions WHERE status='open' AND deadline_at<=? AND next_attempt<=?",
    )
    .all(now, now)) {
    try {
      await finishActivityCheck(ctx, guild, item.id, now);
    } catch (error) {
      ctx.store.db
        .prepare('UPDATE activity_check_sessions SET last_error=?,next_attempt=? WHERE id=?')
        .run(String(error.code || error.name), now + 60000, item.id);
    }
  }
  for (const item of ctx.store.db
    .prepare('SELECT * FROM activity_check_sessions WHERE dirty=1 AND next_attempt<=? LIMIT 10')
    .all(now)) {
    try {
      if (item.message_id || now < item.deadline_at)
        await publishActivityCheck(ctx, guild, item.id);
      else
        ctx.store.db.prepare('UPDATE activity_check_sessions SET dirty=0 WHERE id=?').run(item.id);
    } catch (error) {
      ctx.store.db
        .prepare('UPDATE activity_check_sessions SET last_error=?,next_attempt=? WHERE id=?')
        .run(String(error.code || error.name), now + 60000, item.id);
    }
  }
  for (const item of ctx.store.db
    .prepare(
      "SELECT id FROM activity_check_sessions WHERE status='open' AND deadline_at>? AND next_attempt<=?",
    )
    .all(now, now)) {
    try {
      if (await syncOpenCheckReactions(ctx, guild, item.id, now))
        await publishActivityCheck(ctx, guild, item.id);
    } catch (error) {
      ctx.store.db
        .prepare('UPDATE activity_check_sessions SET last_error=?,next_attempt=? WHERE id=?')
        .run(String(error.code || error.name), now + 60000, item.id);
    }
  }
  await syncCheckReminders(ctx, guild, now);
  await syncActivityWarnings(ctx, guild, now);
  // A broken destination for the next week must not block logs/DMs of completed checks.
  await syncWeeklyActivityCheck(ctx, guild, now);
}
export async function cleanupMovedActivityChecks(ctx, guild, now = Date.now()) {
  for (const item of ctx.store.db
    .prepare("SELECT key,value FROM settings WHERE key LIKE 'activitycheck:move-cleanup:%'")
    .all()) {
    let job;
    try {
      job = JSON.parse(item.value);
      if (job.nextAttempt > now) continue;
      const current = checkById(ctx, job.id);
      if (current?.channel_id === job.channelId && current?.message_id === job.messageId) continue;
      const channel = await guild.channels.fetch(job.channelId).catch((error) => {
        if (error.code === 10003) return null;
        throw error;
      });
      const message = channel
        ? await channel.messages.fetch(job.messageId).catch((error) => {
            if (error.code === 10008) return null;
            throw error;
          })
        : null;
      if (message) {
        assertUser(
          message.author.id === guild.members.me.id &&
            message.embeds?.some(
              (card) => canonicalBrandText(card.footer?.text) === marker(job.id),
            ),
          'Het oude checkbericht hoort niet bij deze bot.',
        );
        await message.delete();
      }
      ctx.store.db.prepare('DELETE FROM settings WHERE key=?').run(item.key);
    } catch (error) {
      if (job)
        ctx.store.setSetting(
          item.key,
          JSON.stringify({
            ...job,
            nextAttempt: now + 60000,
            error: String(error.code || error.name),
          }),
        );
    }
  }
}
export async function moveActivityCheck(ctx, guild, id, channelId, now = Date.now()) {
  requirePlanningGuild(ctx);
  return serializeCommunity(`${guild.id}:checkin:${id}`, async () => {
    const check = checkById(ctx, id);
    assertUser(
      check?.status === 'open' && now < check.deadline_at,
      'Deze activiteitencheck is niet meer open.',
    );
    if (check.channel_id === channelId) {
      await cleanupMovedActivityChecks(ctx, guild, now);
      return check;
    }
    const target = await communityChannel(guild, channelId);
    assertUser(
      target
        .permissionsFor(guild.members.me)
        ?.has([P.EmbedLinks, P.AddReactions, P.ManageMessages]),
      'Geef de bot Links insluiten, Reacties toevoegen en Berichten beheren in het nieuwe kanaal.',
    );
    const role = await guild.roles.fetch(ctx.config.memberRoleId);
    assertUser(
      role && (role.mentionable || target.permissionsFor(guild.members.me)?.has(P.MentionEveryone)),
      'De bot kan Bakarov niet taggen in het nieuwe kanaal.',
    );
    const fresh = await refreshMembers(guild),
      members = membersOf(ctx, id)
        .map((item) => fresh.get(item.user_id))
        .filter((member) => eligible(ctx, member));
    assertUser(
      members.every((member) =>
        target.permissionsFor(member)?.has([P.ViewChannel, P.ReadMessageHistory]),
      ),
      'Alle opgenomen Bakarov-leden moeten het nieuwe kanaal kunnen bekijken.',
    );
    const source = await communityChannel(guild, check.channel_id),
      previous = check.message_id
        ? await source.messages.fetch({ message: check.message_id, force: true })
        : null;
    assertUser(
      !check.message_id || previous?.author.id === guild.members.me.id,
      'Het oorspronkelijke checkbericht ontbreekt.',
    );
    const confirmed = previous ? await checkReactionUsers(previous) : new Set();
    const saveResponses = (users) => {
      for (const user of users)
        ctx.store.db
          .prepare(
            "UPDATE activity_check_members SET status='responded',responded_at=? WHERE check_id=? AND user_id=? AND responded_at IS NULL",
          )
          .run(now, id, user);
    };
    ctx.store.transaction(() => saveResponses(confirmed));
    // The old binding stays usable until the replacement and its ✅ are confirmed.
    let replacement, before;
    for (let page = 0; page < 10; page++) {
      const history = await target.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
      replacement = [...history.values()].find(
        (message) =>
          message.author.id === guild.members.me.id &&
          message.embeds?.some((card) => canonicalBrandText(card.footer?.text) === marker(id)),
      );
      if (replacement || history.size < 100) break;
      before = history.last().id;
    }
    replacement ??= await target.send({
      ...activityCheckMessage(ctx, check),
      nonce: createHash('sha256')
        .update(`check-move:${id}:${channelId}`)
        .digest('hex')
        .slice(0, 24),
      enforceNonce: true,
      allowedMentions: {
        parse: [],
        roles: [ctx.config.memberRoleId],
        users: [],
        repliedUser: false,
      },
    });
    if (!replacement.reactions.cache.get('✅')?.me) await replacement.react('✅');
    const targetResponses = await checkReactionUsers(replacement);
    const latestSourceResponses = previous ? await checkReactionUsers(previous) : new Set();
    ctx.store.transaction(() => {
      saveResponses(targetResponses);
      saveResponses(latestSourceResponses);
      ctx.store.db
        .prepare(
          'UPDATE activity_check_sessions SET channel_id=?,message_id=?,published_at=COALESCE(published_at,?),dirty=1,next_attempt=0,last_error=NULL WHERE id=?',
        )
        .run(channelId, replacement.id, now, id);
      if (previous) {
        ctx.store.setSetting(
          `activitycheck:move-cleanup:${id}:${previous.id}`,
          JSON.stringify({ id, channelId: check.channel_id, messageId: previous.id }),
        );
        ctx.store.setSetting(`activitycheck:moved-from:${check.channel_id}:${previous.id}`, id);
      }
      ctx.store.audit('activitycheck.move', guild.members.me.id, { id, channel: channelId });
    });
    await cleanupMovedActivityChecks(ctx, guild, now);
    return checkById(ctx, id);
  });
}
export function weeklyCheckDeadline(ctx, now = Date.now()) {
  const settings = operationSettings(ctx).activityCheck;
  if (!settings.weeklyEnabled) return null;
  const intervalDays = settings.weeklyIntervalWeeks * 7;
  let date = settings.weeklyStartDate,
    deadline = planningTime(date, settings.weeklyTime, now);
  // Calendar weeks preserve the configured local time through Belgian summer/winter time changes.
  while (deadline < now + 60000) {
    date = new Date(Date.parse(date + 'T12:00:00Z') + intervalDays * 86400000)
      .toISOString()
      .slice(0, 10);
    deadline = planningTime(date, settings.weeklyTime, now);
  }
  return { date, deadline };
}
export async function syncWeeklyActivityCheck(ctx, guild, now = Date.now()) {
  if (ctx.config.guildId !== '1555685630640652338') return;
  return serializeCommunity(`${guild.id}:weekly-checkin`, async () => {
    const next = weeklyCheckDeadline(ctx, now);
    if (
      !next ||
      next.deadline - now >
        operationSettings(ctx).activityCheck.weeklyIntervalWeeks * 7 * 86400000 + 3600000
    )
      return;
    const settings = operationSettings(ctx).activityCheck,
      target = settings.weeklyChannelId || WEEKLY_CHECK_CHANNEL_ID;
    const scheduled = ctx.store.db
      .prepare(
        'SELECT c.* FROM activity_check_sessions c JOIN activity_check_occurrences o ON o.check_id=c.id WHERE o.deadline_date=?',
      )
      .get(next.date);
    if (scheduled) {
      if (scheduled.status === 'open' && scheduled.channel_id !== target)
        await moveActivityCheck(ctx, guild, scheduled.id, target, now);
      return;
    }
    const open = ctx.store.db
      .prepare("SELECT * FROM activity_check_sessions WHERE status='open'")
      .get();
    if (open) {
      // Reuse a manually started check with this exact deadline instead of duplicating it.
      if (open.deadline_at === next.deadline) {
        ctx.store.transaction(() => {
          ctx.store.db
            .prepare('INSERT INTO activity_check_occurrences(deadline_date,check_id) VALUES(?,?)')
            .run(next.date, open.id);
          ctx.store.db
            .prepare(
              'UPDATE activity_check_sessions SET reason=?,dirty=1,next_attempt=0 WHERE id=?',
            )
            .run(operationSettings(ctx).activityCheck.weeklyReason, open.id);
        });
        if (open.channel_id !== target) await moveActivityCheck(ctx, guild, open.id, target, now);
      }
      return;
    }
    await createCheck(
      ctx,
      guild,
      guild.members.me,
      {
        date: next.date,
        time: settings.weeklyTime,
        reason: settings.weeklyReason,
        channelId: target,
        scheduleDate: next.date,
      },
      now,
    );
  });
}
export async function syncCheckReminders(ctx, guild, now = Date.now()) {
  const settings = operationSettings(ctx).activityCheck;
  const due = settings.remindersEnabled
    ? ctx.store.db
        .prepare(
          "SELECT * FROM activity_check_sessions WHERE status='open' AND published_at IS NOT NULL AND created_at+60000<=? AND deadline_at>? AND deadline_at<=?",
        )
        .all(now, now, now + settings.reminderMinutes * 60000)
    : [];
  if (due.length) await refreshMembers(guild);
  const canRemind = (check, user) => {
    if (
      !settings.remindersEnabled ||
      !check ||
      check.status !== 'open' ||
      now >= check.deadline_at ||
      !eligible(ctx, guild.members.cache.get(user))
    )
      return false;
    const entry = ctx.store.db
      .prepare('SELECT responded_at FROM activity_check_members WHERE check_id=? AND user_id=?')
      .get(check.id, user);
    if (!entry || entry.responded_at !== null) return false;
    const date = missionDay(check.deadline_at);
    return !ctx.store.db
      .prepare(
        "SELECT 1 FROM absence_requests WHERE user_id=? AND kind='range' AND status='approved' AND start_date<=? AND end_date>=?",
      )
      .get(user, date, date);
  };
  for (const check of due)
    for (const member of membersOf(ctx, check.id))
      if (canRemind(check, member.user_id))
        queueFeatureNotice(ctx, {
          key: `checkin.reminder:${check.id}:${member.user_id}`,
          kind: 'checkin.reminder',
          user: member.user_id,
          period: check.id,
          now,
          payload: {
            embeds: [
              embed(
                ctx.config,
                'Bakarov — Check-in-herinnering',
                `Je hebt de activiteitencheck nog niet bevestigd.\n\nReageer vóór <t:${Math.floor(check.deadline_at / 1000)}:F> met **✅** onder [het check-in-bericht](https://discord.com/channels/${guild.id}/${check.channel_id}/${check.message_id}).\n\nZonder bevestiging of goedgekeurde afwezigheid volgt na de deadline één gangwarn.`,
              ).setColor(0xf59e0b),
            ],
          },
        });
  await deliverFeatureNotices(
    ctx,
    guild,
    now,
    (item) => canRemind(checkById(ctx, item.period_id), item.user_id),
    ['checkin.reminder'],
  );
}
