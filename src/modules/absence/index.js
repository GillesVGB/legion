import { recognizedAbsenceReason, missingAbsenceReason } from './reasons.js';
import { randomBytes } from 'node:crypto';
import { MessageFlags, ButtonStyle } from 'discord.js';
import { assertUser } from '../../common/errors.js';
import { embed, row, button, safeText } from '../../ui/messages.js';
import { quiet, staffLogChannel } from '../tickets/service.js';
import { serializeCommunity, updateCommunityPost } from '../../common/discord-posts.js';
import { planningTime } from '../planning/index.js';
import { missionDay } from '../games/mission-definitions.js';
import {
  gangpotWindow,
  requireGangPot,
  gangpotEligible,
  GANGPOT_LEAD_ROLE_ID,
  reconcileGangpotDebt,
} from '../gangpot/index.js';
import { operationSettings } from '../../config/features.js';
import { queueFeatureNotice, deliverFeatureNotices } from '../../common/notices.js';
const uid = () => randomBytes(6).toString('hex');
const statusLabels = {
  pending: 'Wacht op Lead',
  approved: 'Goedgekeurd',
  rejected: 'Afgewezen',
  cancelled: 'Ingetrokken',
};
const shift = (date, days) => missionDay(Date.parse(date + 'T12:00:00Z') + days * 86400000);
export const exemptionFor = (ctx, user, week) =>
  ctx.store.db
    .prepare(
      "SELECT a.*,a.id AS request_id FROM absence_requests a WHERE a.user_id=? AND a.kind='range' AND a.status='approved' AND EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(a.weeks) THEN a.weeks ELSE '[]' END) w WHERE w.value=?) ORDER BY a.reviewed_at DESC LIMIT 1",
    )
    .get(user, week) || null;
export const absenceById = (ctx, id) =>
  ctx.store.db.prepare('SELECT * FROM absence_requests WHERE id=?').get(id);
export function approvedAway(ctx, activity, user) {
  const date = missionDay(activity.starts_at);
  return ctx.store.db
    .prepare(
      "SELECT * FROM absence_requests WHERE user_id=? AND status='approved' AND ((kind='planning' AND activity_id=?) OR (kind='range' AND start_date<=? AND end_date>=?)) ORDER BY reviewed_at DESC LIMIT 1",
    )
    .get(user, activity.id, date, date);
}
export function activityAbsences(ctx, activity) {
  const date = missionDay(activity.starts_at),
    rows = ctx.store.db
      .prepare(
        "SELECT * FROM absence_requests WHERE status IN ('pending','approved','rejected') AND ((kind='planning' AND activity_id=?) OR (kind='range' AND status='approved' AND start_date<=? AND end_date>=?)) ORDER BY CASE status WHEN 'approved' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,created_at DESC",
      )
      .all(activity.id, date, date);
  const result = new Map();
  for (const item of rows) {
    const response = ctx.store.db
      .prepare('SELECT response FROM activity_rsvps WHERE activity_id=? AND user_id=?')
      .get(activity.id, item.user_id)?.response;
    if (response && response !== 'no') continue;
    if (!result.has(item.user_id)) result.set(item.user_id, item);
  }
  return [...result.values()];
}
export function syncAbsenceExemptions(ctx, actor, now = Date.now(), inside = false) {
  if (!ctx.config.gangpot) return;
  const run = () => {
    ctx.store.db
      .prepare(
        "UPDATE gangpot_exemptions SET revoked_at=?,revoked_by=?,revoke_reason='Losse gangpotvrijstellingen zijn afgeschaft.' WHERE revoked_at IS NULL",
      )
      .run(now, actor || ctx.config.clientId);
    const approved = ctx.store.db
      .prepare(
        "SELECT DISTINCT a.user_id,w.value AS week FROM absence_requests a,json_each(CASE WHEN json_valid(a.weeks) THEN a.weeks ELSE '[]' END) w WHERE a.kind='range' AND a.status='approved'",
      )
      .all();
    for (const item of approved)
      reconcileGangpotDebt(ctx, item.week, item.user_id, actor || ctx.config.clientId, now);
  };
  return inside ? run() : ctx.store.transaction(run);
}
function autoApprove(ctx, guild, item, now) {
  if (
    item.kind !== 'planning' ||
    item.status !== 'pending' ||
    !operationSettings(ctx).planning.autoApproveAbsences ||
    !recognizedAbsenceReason(item.reason)
  )
    return item;
  if (
    ctx.store.db
      .prepare(
        "SELECT 1 FROM absence_requests WHERE activity_id=? AND user_id=? AND status='rejected' AND reviewer_id<>? LIMIT 1",
      )
      .get(item.activity_id, item.user_id, guild.members.me.id)
  )
    return item;
  const actor = guild.members.me.id;
  ctx.store.db
    .prepare(
      "UPDATE absence_requests SET status='approved',reviewer_id=?,reviewed_at=?,dirty=1,next_attempt=0 WHERE id=?",
    )
    .run(actor, now, item.id);
  ctx.store.db
    .prepare('UPDATE activities SET dirty=1,next_attempt=0 WHERE id=?')
    .run(item.activity_id);
  ctx.store.audit('absence.approve', actor, {
    id: item.id,
    user: item.user_id,
    automatic: true,
    activity: item.activity_id,
  });
  queueFeatureNotice(ctx, {
    key: `absence:${item.id}:automatic`,
    kind: 'absence',
    user: item.user_id,
    payload: {
      embeds: [
        embed(
          ctx.config,
          'Bakarov — Afmelding goedgekeurd',
          `Je reden is herkend en je planningsafmelding is automatisch goedgekeurd.\nPlanning: ${item.activity_id}\nDit geldt alleen voor deze activiteit. Lead kan de beslissing controleren.`,
        ).setColor(0x22c55e),
      ],
      allowedMentions: quiet,
    },
    now,
  });
  return absenceById(ctx, item.id);
}
export async function requireLead(ctx, guild, member) {
  requireGangPot(ctx);
  assertUser(guild.id === ctx.config.guildId, 'Kies de Bakarov-hoofdserver.');
  const fresh = await guild.members.fetch({ user: member.id, force: true });
  assertUser(
    !fresh.user.bot && fresh.roles.cache.has(GANGPOT_LEAD_ROLE_ID),
    'Alleen Lead kan afmeldingen beoordelen.',
  );
  return fresh;
}
export async function createAbsence(ctx, guild, user, input, now = Date.now()) {
  requireGangPot(ctx);
  const member = await guild.members.fetch({ user, force: true });
  assertUser(
    input.activityId ? !member.user.bot : gangpotEligible(ctx, member),
    'Alleen Bakarov-leden kunnen afwezigheid aanvragen.',
  );
  const channel = await staffLogChannel(guild, ctx.config),
    reason = String(input.reason || '').trim();
  assertUser(reason && reason.length <= 500, 'Geef een reden van 1 tot 500 tekens.');
  let start,
    end,
    weeks = [];
  if (input.activityId) {
    const activity = ctx.store.db
      .prepare('SELECT * FROM activities WHERE id=?')
      .get(input.activityId);
    assertUser(
      activity?.status === 'open' && activity.ends_at > now,
      'Deze planning is niet meer open.',
    );
    const approved = approvedAway(ctx, activity, user);
    if (approved) {
      ctx.store.transaction(() => {
        ctx.store.db
          .prepare(
            "INSERT INTO activity_rsvps(activity_id,user_id,response,updated_at) VALUES(?,?,'no',?) ON CONFLICT(activity_id,user_id) DO UPDATE SET response='no',updated_at=excluded.updated_at",
          )
          .run(activity.id, user, now);
        ctx.store.db
          .prepare('UPDATE activities SET dirty=1,next_attempt=0 WHERE id=?')
          .run(activity.id);
        ctx.store.audit('planning.absence.approved', user, {
          activity: activity.id,
          request: approved.id,
        });
      });
      return approved;
    }
  } else {
    start = missionDay(planningTime(input.start, '12:00', now));
    end = missionDay(planningTime(input.end, '12:00', now));
    assertUser(
      start >= missionDay(now) && end >= start,
      'Gebruik vandaag of een toekomstige begindatum en een einddatum na de begindatum.',
    );
    assertUser(
      Date.parse(end) - Date.parse(start) < operationSettings(ctx).absence.maxDays * 86400000,
      'Deze afwezigheid duurt langer dan de ingestelde maximale duur.',
    );
    assertUser(
      Date.parse(start) - Date.parse(missionDay(now)) <= 366 * 86400000,
      'Kies een begindatum binnen een jaar.',
    );
    for (let date = start; date <= end; date = shift(date, 1)) {
      const week = gangpotWindow(ctx.config.gangpot, planningTime(date, '12:00', now))?.id;
      if (week && !weeks.includes(week)) weeks.push(week);
    }
  }
  return serializeCommunity(`${guild.id}:absences`, () =>
    ctx.store.transaction(() => {
      const previous = input.activityId
        ? ctx.store.db
            .prepare(
              "SELECT * FROM absence_requests WHERE user_id=? AND activity_id=? AND status IN ('pending','approved') ORDER BY created_at DESC LIMIT 1",
            )
            .get(user, input.activityId)
        : ctx.store.db
            .prepare(
              "SELECT * FROM absence_requests WHERE user_id=? AND kind='range' AND status='pending' AND start_date<=? AND end_date>=?",
            )
            .get(user, end, start);
      if (previous) {
        assertUser(input.activityId, 'Je hebt al een overlappende afwezigheidsaanvraag.');
        if (previous.status === 'pending' && !input.automatic && input.reason !== previous.reason)
          ctx.store.db
            .prepare('UPDATE absence_requests SET reason=?,dirty=1,next_attempt=0 WHERE id=?')
            .run(reason, previous.id);
        return input.automatic
          ? absenceById(ctx, previous.id)
          : autoApprove(ctx, guild, absenceById(ctx, previous.id), now);
      }
      const id = uid();
      ctx.store.db
        .prepare(
          'INSERT INTO absence_requests(id,user_id,kind,activity_id,start_date,end_date,weeks,reason,created_at,channel_id) VALUES(?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          id,
          user,
          input.activityId ? 'planning' : 'range',
          input.activityId || null,
          start || null,
          end || null,
          JSON.stringify(weeks),
          reason,
          now,
          channel.id,
        );
      if (input.activityId) {
        ctx.store.db
          .prepare(
            "INSERT INTO activity_rsvps(activity_id,user_id,response,updated_at) VALUES(?,?,'no',?) ON CONFLICT(activity_id,user_id) DO UPDATE SET response='no',updated_at=excluded.updated_at",
          )
          .run(input.activityId, user, now);
        ctx.store.db
          .prepare('UPDATE activities SET dirty=1,next_attempt=0 WHERE id=?')
          .run(input.activityId);
      }
      ctx.store.audit('absence.request', user, {
        id,
        kind: input.activityId ? 'planning' : 'range',
        weeks,
        activity: input.activityId,
      });
      return input.automatic
        ? absenceById(ctx, id)
        : autoApprove(ctx, guild, absenceById(ctx, id), now);
    }),
  );
}
export async function decideAbsence(ctx, guild, member, id, decision, now = Date.now()) {
  const lead = await requireLead(ctx, guild, member);
  assertUser(['approve', 'reject'].includes(decision), 'Kies goedkeuren of afwijzen.');
  return serializeCommunity(`${guild.id}:absences`, () =>
    ctx.store.transaction(() => {
      const item = absenceById(ctx, id);
      assertUser(item, 'Deze aanvraag bestaat niet.');
      if (
        item.status !== 'pending' &&
        !(
          decision === 'reject' &&
          item.status === 'approved' &&
          item.kind === 'planning' &&
          item.reviewer_id === guild.members.me.id
        )
      )
        return item;
      assertUser(
        decision !== 'approve' || !missingAbsenceReason(item.reason),
        'Het lid moet eerst een reden opgeven via /afmelden of het afmeldpaneel.',
      );
      const target = guild.members.cache.get(item.user_id);
      assertUser(
        item.kind === 'planning' ? target && !target.user.bot : gangpotEligible(ctx, target),
        'De aanvrager heeft geen Bakarov-ledenrol meer.',
      );

      ctx.store.db
        .prepare(
          'UPDATE absence_requests SET status=?,reviewer_id=?,reviewed_at=?,dirty=1,next_attempt=0 WHERE id=?',
        )
        .run(decision === 'approve' ? 'approved' : 'rejected', lead.id, now, id);
      syncAbsenceExemptions(ctx, guild.members.me.id, now, true);
      if (item.activity_id)
        ctx.store.db
          .prepare('UPDATE activities SET dirty=1,next_attempt=0 WHERE id=?')
          .run(item.activity_id);
      else
        ctx.store.db
          .prepare(
            'UPDATE activities SET dirty=1,next_attempt=0 WHERE starts_at>=? AND starts_at<=?',
          )
          .run(
            planningTime(item.start_date, '00:00', now),
            planningTime(shift(item.end_date, 1), '00:00', now),
          );
      ctx.store.audit(`absence.${decision}`, lead.id, {
        id,
        user: item.user_id,
        weeks: JSON.parse(item.weeks),
        activity: item.activity_id,
      });
      queueFeatureNotice(ctx, {
        key: `absence:${id}:decision`,
        kind: 'absence',
        user: item.user_id,
        payload: {
          embeds: [
            embed(
              ctx.config,
              decision === 'approve'
                ? 'Bakarov — Afmelding goedgekeurd'
                : 'Bakarov — Afmelding afgewezen',
              `Je aanvraag is ${decision === 'approve' ? 'goedgekeurd' : 'afgewezen'}.${item.kind === 'range' ? `\nPeriode: ${item.start_date} t/m ${item.end_date}` : `\nPlanning: ${item.activity_id}`}\n${item.kind === 'planning' ? 'Deze beslissing geldt uitsluitend voor de activiteit; de gangpotplicht verandert niet.' : decision === 'approve' ? 'Je afwezigheid is geregistreerd. Voor de betrokken gangpotweken ben je vrijgesteld.' : 'De gangpotbijdrage blijft verplicht.'}`,
            ).setColor(decision === 'approve' ? 0x22c55e : 0xef4444),
          ],
          allowedMentions: quiet,
        },
        now,
      });
      return absenceById(ctx, id);
    }),
  );
}
export async function setExemption() {
  assertUser(
    false,
    'Losse gangpotvrijstellingen zijn afgeschaft. Alleen een goedgekeurde langere afmelding geeft vrijstelling.',
  );
}
export function absenceMessage(ctx, item) {
  const planning = item.kind === 'planning',
    pending = item.status === 'pending',
    automatic = item.status === 'approved' && item.reviewer_id === ctx.config.clientId;
  return {
    embeds: [
      embed(
        ctx.config,
        planning ? 'Bakarov — Afmelding planning' : 'Bakarov — Afwezigheidsaanvraag',
        `**Lid:** <@${item.user_id}>\n${planning ? `**Planning:** ${item.activity_id}` : `**Periode:** ${item.start_date} t/m ${item.end_date}`}\n**Reden:** ${safeText(item.reason)}\n**Status:** ${statusLabels[item.status] || item.status}${item.reviewer_id ? `\n**Beoordeeld door:** <@${item.reviewer_id}>` : ''}\n\n${planning ? 'Een rode reactie alleen is niet voldoende. Geef een reden op; duidelijke redenen kan de bot goedkeuren. Dit geldt alleen voor deze activiteit.' : 'Na goedkeuring geldt je afwezigheid voor activiteiten en check-ins en ben je vrijgesteld voor de betrokken gangpotweken.'}`,
      )
        .setColor(
          item.status === 'approved' ? 0x22c55e : item.status === 'pending' ? 0xf59e0b : 0xef4444,
        )
        .setFooter({ text: `Bakarov • Afmelding ${item.id}` }),
    ],
    components: pending
      ? [
          row(
            button(`absence:approve:${item.id}`, 'Goedkeuren', ButtonStyle.Success).setDisabled(
              missingAbsenceReason(item.reason),
            ),
            button(`absence:reject:${item.id}`, 'Afwijzen', ButtonStyle.Danger),
          ),
        ]
      : automatic
        ? [row(button(`absence:reject:${item.id}`, 'Goedkeuring intrekken', ButtonStyle.Danger))]
        : [],
    allowedMentions: quiet,
  };
}
export async function syncAbsences(ctx, guild, now = Date.now()) {
  if (!ctx.config.gangpot) return;
  for (const item of ctx.store.db
    .prepare('SELECT * FROM absence_requests WHERE dirty=1 AND next_attempt<=? LIMIT 20')
    .all(now)) {
    try {
      await staffLogChannel(guild, { ...ctx.config, logChannelId: item.channel_id });
      await updateCommunityPost(
        ctx,
        guild,
        'absence_requests',
        item,
        absenceMessage(ctx, item),
        `Bakarov • Afmelding ${item.id}`,
      );
    } catch (error) {
      ctx.store.db
        .prepare('UPDATE absence_requests SET next_attempt=?,last_error=? WHERE id=?')
        .run(now + 60000, String(error.code || error.name), item.id);
    }
  }
  await deliverFeatureNotices(
    ctx,
    guild,
    now,
    (notice) => {
      if (notice.kind !== 'absence') return null;
      const [, id, type] = notice.notice_key.split(':'),
        item = absenceById(ctx, id);
      if (!item || !['approved', 'rejected'].includes(item.status)) return false;
      if (type === 'automatic')
        return item.status === 'approved' && item.reviewer_id === guild.members.me.id;
      const card = JSON.parse(notice.payload).embeds?.[0];
      return card?.color === (item.status === 'approved' ? 0x22c55e : 0xef4444);
    },
    ['absence'],
  );
}
export async function handleAbsenceButton(ctx, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const [, decision, id] = interaction.customId.split(':'),
    item = absenceById(ctx, id);
  assertUser(
    item && item.channel_id === interaction.channelId && item.message_id === interaction.message.id,
    'Deze knop hoort niet bij de aanvraag.',
  );
  const result = await decideAbsence(ctx, interaction.guild, interaction.member, id, decision);
  await syncAbsences(ctx, interaction.guild);
  return interaction.editReply({
    content: `Afmelding: ${statusLabels[result.status] || result.status}.`,
    allowedMentions: quiet,
  });
}
export async function handleAbsenceCommand(ctx, interaction) {
  requireGangPot(ctx);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const action =
    interaction.commandName === 'afmelden' ? 'planning' : interaction.options.getSubcommand();
  if (['aanvragen', 'planning'].includes(action)) {
    const item = await createAbsence(ctx, interaction.guild, interaction.user.id, {
      activityId: action === 'planning' ? interaction.options.getString('planning', true) : null,
      start: interaction.options.getString('van'),
      end: interaction.options.getString('tot'),
      reason: interaction.options.getString('reden', true),
    });
    await syncAbsences(ctx, interaction.guild);
    return interaction.editReply({
      content:
        item.status === 'approved'
          ? 'Je afmelding is goedgekeurd.'
          : `Aanvraag \`${item.id}\` opgeslagen. Lead moet je afmelding goedkeuren.`,
      allowedMentions: quiet,
    });
  }
  if (action === 'status') {
    const requests = ctx.store.db
      .prepare('SELECT * FROM absence_requests WHERE user_id=? ORDER BY created_at DESC LIMIT 10')
      .all(interaction.user.id);
    return interaction.editReply({
      content: `## Jouw afmeldingen\n${requests.map((item) => `• ${item.id} · ${item.status} · ${item.activity_id || `${item.start_date} t/m ${item.end_date}`}`).join('\n') || 'Nog geen aanvragen.'}`,
      allowedMentions: quiet,
    });
  }
  await setExemption(
    ctx,
    interaction.guild,
    interaction.member,
    interaction.options.getUser('gebruiker', true).id,
    interaction.options.getString('termijn', true),
    interaction.options.getString('reden', true),
    action === 'vrijstelling-intrekken',
  );
  return interaction.editReply({
    content:
      action === 'vrijstelling-intrekken'
        ? 'Vrijstelling ingetrokken.'
        : 'Vrijstelling voor deze week opgeslagen.',
    allowedMentions: quiet,
  });
}
