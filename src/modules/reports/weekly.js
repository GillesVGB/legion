import { MessageFlags, PermissionFlagsBits as P } from 'discord.js';
import { assertUser } from '../../common/errors.js';
import { missionDay } from '../games/mission-definitions.js';
import { planningTime } from '../planning/index.js';
import { periodReport, periodReportMessage } from './monthly.js';
import { requireStaff, quiet, staffLogChannel } from '../tickets/service.js';
import { serializeCommunity } from '../../common/discord-posts.js';
import { operationSettings } from '../../config/features.js';

const shift = (date, days) =>
  new Date(Date.parse(date + 'T12:00:00Z') + days * 86400000).toISOString().slice(0, 10);
export function weekId(now = Date.now()) {
  const date = missionDay(now),
    day = new Date(date + 'T12:00:00Z').getUTCDay();
  return shift(date, -day);
}
export function weekWindow(value = missionDay()) {
  const week = weekId(planningTime(value, '12:00')),
    endDate = shift(week, 7);
  return {
    week,
    startDate: week,
    endDate: shift(endDate, -1),
    start: planningTime(week, '00:00'),
    end: planningTime(endDate, '00:00'),
  };
}
export function weeklyReport(ctx, date = missionDay(), now = Date.now()) {
  assertUser(
    ctx.config.guildId === '1555685630640652338',
    'Weekoverzichten worden in de hoofdserver beheerd.',
  );
  const window = weekWindow(date);
  assertUser(window.start <= now, 'Kies de huidige week of een afgelopen week.');
  return periodReport(ctx, window, now);
}
export function weeklyReportMessage(ctx, report) {
  const format = (date) => date.split('-').reverse().join('-');
  return periodReportMessage(
    ctx,
    report,
    `Bakarov — Weekoverzicht ${format(report.startDate)} t/m ${format(report.endDate)}`,
    'Afgeronde week',
    `Bakarov • Weekoverzicht ${report.week}`,
  );
}
export function weeklyReportIndex(ctx, now = Date.now()) {
  return {
    current: weekId(now),
    starts: ctx.store.setting('weekly:starts') || weekId(now),
    history: ctx.store.db
      .prepare(
        'SELECT week,created_at,sent_at,message_id,channel_id,last_error FROM weekly_reports ORDER BY week DESC LIMIT 52',
      )
      .all(),
  };
}
export async function syncWeeklyReports(ctx, guild, now = Date.now()) {
  if (ctx.config.guildId !== '1555685630640652338') return;
  assertUser(guild.id === ctx.config.guildId, 'Dit weekoverzicht hoort bij een andere server.');
  return serializeCommunity(`${guild.id}:weekly-reports`, async () => {
    const current = weekId(now);
    if (!ctx.store.setting('weekly:starts')) ctx.store.setSetting('weekly:starts', current);
    const settings = operationSettings(ctx).weeklyReports;
    if (!settings.enabled) return;
    let attempted = 0;
    for (
      let week = ctx.store.setting('weekly:starts');
      week < current && attempted < 2;
      week = shift(week, 7)
    ) {
      if (now < planningTime(shift(week, 7), settings.sendTime)) continue;
      let job = ctx.store.db.prepare('SELECT * FROM weekly_reports WHERE week=?').get(week);
      if (job?.message_id || job?.next_attempt > now) continue;
      attempted++;
      if (!job) {
        ctx.store.db
          .prepare('INSERT INTO weekly_reports(week,payload,created_at) VALUES(?,?,?)')
          .run(week, JSON.stringify(weeklyReport(ctx, week, now)), now);
        job = ctx.store.db.prepare('SELECT * FROM weekly_reports WHERE week=?').get(week);
      }
      try {
        const channel = await staffLogChannel(guild, {
          ...ctx.config,
          logChannelId:
            job.channel_id ||
            ctx.config.weeklyReportChannelId ||
            ctx.config.monthlyReportChannelId ||
            ctx.config.logChannelId,
        });
        assertUser(
          channel.permissionsFor(guild.members.me)?.has(P.ReadMessageHistory),
          'De bot moet de berichtgeschiedenis van het weekoverzichtkanaal kunnen lezen.',
        );
        if (!job.channel_id)
          ctx.store.db
            .prepare('UPDATE weekly_reports SET channel_id=? WHERE week=?')
            .run(channel.id, week);
        const marker = `Bakarov • Weekoverzicht ${week}`,
          history = await channel.messages.fetch({ limit: 100 });
        let message = [...history.values()].find(
          (item) =>
            item.author.id === guild.members.me.id &&
            item.embeds?.some((card) => card.footer?.text === marker),
        );
        message ??= await channel.send({
          ...weeklyReportMessage(ctx, JSON.parse(job.payload)),
          nonce: `wr:${guild.id.slice(-8)}:${week}`,
          enforceNonce: true,
          allowedMentions: quiet,
        });
        ctx.store.transaction(() => {
          ctx.store.db
            .prepare(
              'UPDATE weekly_reports SET channel_id=?,message_id=?,sent_at=?,last_error=NULL WHERE week=?',
            )
            .run(channel.id, message.id, now, week);
          ctx.store.audit('weekly.sent', guild.members.me.id, { week, channel: channel.id });
        });
      } catch (error) {
        ctx.store.db
          .prepare('UPDATE weekly_reports SET next_attempt=?,last_error=? WHERE week=?')
          .run(now + 60000, String(error.code || error.name), week);
      }
    }
  });
}
export async function handleWeeklyReport(ctx, interaction) {
  requireStaff(interaction, ctx.config);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  return interaction.editReply(
    weeklyReportMessage(
      ctx,
      weeklyReport(ctx, interaction.options.getString('datum') || missionDay()),
    ),
  );
}
