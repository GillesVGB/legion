import { MessageFlags, PermissionFlagsBits as P } from 'discord.js';
import { assertUser } from '../../common/errors.js';
import { missionDay } from '../games/mission-definitions.js';
import { planningTime } from '../planning/index.js';
import { embed } from '../../ui/messages.js';
import { requireStaff, quiet, staffLogChannel } from '../tickets/service.js';
import { serializeCommunity } from '../../common/discord-posts.js';
import { operationSettings } from '../../config/features.js';
import { gangpotMoney } from '../gangpot/index.js';

export const monthId = (now = Date.now()) => missionDay(now).slice(0, 7);
export function nextMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return `${y + (m === 12 ? 1 : 0)}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}`;
}
export function monthWindow(month) {
  assertUser(
    typeof month === 'string' && /^20\d{2}-(0[1-9]|1[0-2])$/.test(month),
    'Gebruik een maand als JJJJ-MM, bijvoorbeeld 2026-10.',
  );
  return {
    month,
    start: planningTime(`${month}-01`, '00:00'),
    end: planningTime(`${nextMonth(month)}-01`, '00:00'),
  };
}
export function monthlyReport(ctx, month = monthId(), now = Date.now()) {
  assertUser(
    ctx.config.guildId === '1555685630640652338',
    'Maandoverzichten worden in de hoofdserver beheerd.',
  );
  const { start, end } = monthWindow(month);
  assertUser(start <= now, 'Kies de huidige maand of een afgelopen maand.');
  return periodReport(ctx, { month, start, end }, now);
}
export function periodReport(ctx, window, now = Date.now()) {
  const { start, end } = window;
  const db = ctx.store.db,
    activities = db
      .prepare(
        'SELECT id,title,starts_at,status FROM activities WHERE starts_at>=? AND starts_at<? ORDER BY starts_at',
      )
      .all(start, end);
  const rsvps = db
    .prepare(
      "SELECT r.activity_id,r.user_id,r.response FROM activity_rsvps r JOIN activities a ON a.id=r.activity_id WHERE a.starts_at>=? AND a.starts_at<? AND a.status!='cancelled'",
    )
    .all(start, end);
  const checks = db
    .prepare(
      'SELECT id,status,deadline_at FROM activity_check_sessions WHERE deadline_at>=? AND deadline_at<? ORDER BY deadline_at',
    )
    .all(start, end);
  const confirmations = db
    .prepare(
      "SELECT m.* FROM activity_check_members m JOIN activity_check_sessions c ON c.id=m.check_id WHERE c.deadline_at>=? AND c.deadline_at<? AND c.status!='cancelled'",
    )
    .all(start, end);
  const proposals = db
    .prepare(
      'SELECT id,member_id,role_id,status,created_at,closed_at FROM promotions WHERE created_at>=? AND created_at<? OR closed_at>=? AND closed_at<?',
    )
    .all(start, end, start, end);
  const entries = db
    .prepare(
      'SELECT kind,user_id,amount,paid_at FROM gangpot_entries WHERE paid_at>=? AND paid_at<? AND voided_at IS NULL',
    )
    .all(start, end);
  const absences = db
    .prepare(
      "SELECT user_id FROM absence_requests WHERE status='approved' AND kind='range' AND start_date<? AND end_date>=?",
    )
    .all(missionDay(end), missionDay(start));
  const people = new Map(),
    person = (id) => {
      if (!people.has(id))
        people.set(id, {
          id,
          yes: 0,
          late: 0,
          no: 0,
          maybe: 0,
          confirmed: 0,
          exempt: 0,
          warned: 0,
          contribution: 0,
        });
      return people.get(id);
    };
  for (const item of rsvps) person(item.user_id)[item.response]++;
  for (const item of confirmations) {
    const row = person(item.user_id);
    if (item.status === 'responded') row.confirmed++;
    if (item.status === 'exempt') row.exempt++;
    if (item.status === 'warned') row.warned++;
  }
  for (const item of entries)
    if (item.kind === 'payment' && item.user_id) person(item.user_id).contribution += item.amount;
  const sum = (kind) =>
    entries.filter((item) => item.kind === kind).reduce((n, item) => n + item.amount, 0);
  const count = (items, key, value) => items.filter((item) => item[key] === value).length;
  return {
    ...window,
    start,
    end,
    generatedAt: now,
    partial: now < end,
    activities: {
      total: activities.length,
      cancelled: count(activities, 'status', 'cancelled'),
      items: activities,
    },
    attendance: {
      yes: count(rsvps, 'response', 'yes'),
      late: count(rsvps, 'response', 'late'),
      no: count(rsvps, 'response', 'no'),
      maybe: count(rsvps, 'response', 'maybe'),
      approvedAway: new Set(absences.map((item) => item.user_id)).size,
    },
    checkins: {
      total: checks.length,
      cancelled: count(checks, 'status', 'cancelled'),
      closed: count(checks, 'status', 'closed'),
      confirmed: count(confirmations, 'status', 'responded'),
      exempt: count(confirmations, 'status', 'exempt'),
      warned: count(confirmations, 'status', 'warned'),
      pending: count(confirmations, 'status', 'pending'),
    },
    promotions: {
      proposed: proposals.filter((item) => item.created_at >= start && item.created_at < end)
        .length,
      approved: proposals.filter(
        (item) => item.status === 'approved' && item.closed_at >= start && item.closed_at < end,
      ).length,
      rejected: proposals.filter(
        (item) => item.status === 'rejected' && item.closed_at >= start && item.closed_at < end,
      ).length,
    },
    gangpot: {
      payments: sum('payment'),
      donations: sum('donation'),
      expenses: sum('expense'),
      net: sum('payment') + sum('donation') - sum('expense'),
      contributors: new Set(
        entries.filter((item) => item.kind === 'payment').map((item) => item.user_id),
      ).size,
    },
    members: [...people.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
}
export const reportMonthName = (month) =>
  new Intl.DateTimeFormat('nl-BE', {
    month: 'long',
    year: 'numeric',
    timeZone: 'Europe/Brussels',
  }).format(new Date(`${month}-15T12:00:00Z`));
export function monthlyReportMessage(ctx, report) {
  return periodReportMessage(
    ctx,
    report,
    `Bakarov — Maandoverzicht ${reportMonthName(report.month)}`,
    'Afgeronde maand',
    `Bakarov • Maandoverzicht ${report.month}`,
  );
}
export function periodReportMessage(ctx, report, title, completedLabel, marker) {
  const { activities: a, attendance: r, checkins: c, promotions: p, gangpot: g } = report;
  return {
    embeds: [
      embed(
        ctx.config,
        title,
        `${report.partial ? '🟠 Tussentijds overzicht' : `📊 ${completedLabel}`} · Belgische tijd\nDe cijfers komen uit bewaarde botregistraties. Planningreacties geven de aangegeven beschikbaarheid weer, geen vastgestelde aanwezigheid in FiveM.`,
      )
        .addFields(
          {
            name: '📅 Activiteiten',
            value: `Gepland: **${a.total}** · geannuleerd: **${a.cancelled}**\n🟢 Erbij: **${r.yes}** · 🕒 Later: **${r.late}**\n🔴 Niet erbij: **${r.no}** · 🟠 Onzeker: **${r.maybe}**`,
          },
          {
            name: '✅ Check-ins & afwezigheid',
            value: `Checks: **${c.total}** · afgerond: **${c.closed}** · geannuleerd: **${c.cancelled}**\nBevestigd: **${c.confirmed}** · vrijgesteld: **${c.exempt}**\nMet gangwarn: **${c.warned}** · nog open: **${c.pending}**\nLeden met goedgekeurde langere afwezigheid: **${r.approvedAway}**`,
          },
          {
            name: '📈 Promoties',
            value: `Voorgesteld: **${p.proposed}**\nGoedgekeurd: **${p.approved}** · afgewezen: **${p.rejected}**`,
          },
          {
            name: '💰 Gangpotbijdragen',
            value: `Goedgekeurde betalingen: **${gangpotMoney(g.payments)}** van **${g.contributors}** leden\nDonaties: **${gangpotMoney(g.donations)}** · uitgaven: **${gangpotMoney(g.expenses)}**\nNettomutatie in deze periode: **${gangpotMoney(g.net)}**\nAlleen geldige boekingen op boekingsdatum; fictieve coins tellen niet mee.`,
          },
        )
        .setFooter({ text: marker }),
    ],
    allowedMentions: quiet,
  };
}
export function monthlyReportIndex(ctx, now = Date.now()) {
  return {
    current: monthId(now),
    starts: ctx.store.setting('monthly:starts') || monthId(now),
    history: ctx.store.db
      .prepare(
        'SELECT month,created_at,sent_at,message_id,channel_id,last_error FROM monthly_reports ORDER BY month DESC LIMIT 36',
      )
      .all(),
  };
}
export async function syncMonthlyReports(ctx, guild, now = Date.now()) {
  if (ctx.config.guildId !== '1555685630640652338') return;
  assertUser(guild.id === ctx.config.guildId, 'Dit maandoverzicht hoort bij een andere server.');
  return serializeCommunity(`${guild.id}:monthly-reports`, async () => {
    const current = monthId(now);
    if (!ctx.store.setting('monthly:starts')) ctx.store.setSetting('monthly:starts', current);
    const settings = operationSettings(ctx).monthlyReports;
    if (!settings.enabled) return;
    // No historic spam on installation. Missed months after installation catch up, two per round.
    let attempted = 0;
    for (
      let month = ctx.store.setting('monthly:starts');
      month < current && attempted < 2;
      month = nextMonth(month)
    ) {
      const due = planningTime(nextMonth(month) + '-01', settings.sendTime);
      if (now < due) continue;
      let job = ctx.store.db.prepare('SELECT * FROM monthly_reports WHERE month=?').get(month);
      if (job?.message_id || job?.next_attempt > now) continue;
      attempted++;
      if (!job) {
        ctx.store.db
          .prepare('INSERT INTO monthly_reports(month,payload,created_at) VALUES(?,?,?)')
          .run(month, JSON.stringify(monthlyReport(ctx, month, now)), now);
        job = ctx.store.db.prepare('SELECT * FROM monthly_reports WHERE month=?').get(month);
      }
      try {
        const channel = await staffLogChannel(guild, {
          ...ctx.config,
          logChannelId:
            job.channel_id || ctx.config.monthlyReportChannelId || ctx.config.logChannelId,
        });
        assertUser(
          channel.permissionsFor(guild.members.me)?.has(P.ReadMessageHistory),
          'De bot moet de berichtgeschiedenis van het maandoverzichtkanaal kunnen lezen.',
        );
        // Retrying uses the original destination, even if settings changed after an acknowledged send.
        if (!job.channel_id)
          ctx.store.db
            .prepare('UPDATE monthly_reports SET channel_id=? WHERE month=?')
            .run(channel.id, month);
        const marker = `Bakarov • Maandoverzicht ${month}`,
          history = await channel.messages.fetch({ limit: 100 });
        let message = [...history.values()].find(
          (item) =>
            item.author.id === guild.members.me.id &&
            item.embeds?.some((card) => card.footer?.text === marker),
        );
        message ??= await channel.send({
          ...monthlyReportMessage(ctx, JSON.parse(job.payload)),
          nonce: `mr:${guild.id}:${month}`,
          enforceNonce: true,
        });
        ctx.store.transaction(() => {
          ctx.store.db
            .prepare(
              'UPDATE monthly_reports SET channel_id=?,message_id=?,sent_at=?,last_error=NULL WHERE month=?',
            )
            .run(channel.id, message.id, now, month);
          ctx.store.audit('monthly.sent', guild.members.me.id, { month, channel: channel.id });
        });
      } catch (error) {
        ctx.store.db
          .prepare('UPDATE monthly_reports SET next_attempt=?,last_error=? WHERE month=?')
          .run(now + 60000, String(error.code || error.name), month);
      }
    }
  });
}
export async function handleMonthlyReport(ctx, interaction) {
  requireStaff(interaction, ctx.config);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  return interaction.editReply(
    monthlyReportMessage(
      ctx,
      monthlyReport(ctx, interaction.options.getString('maand') || monthId()),
    ),
  );
}
