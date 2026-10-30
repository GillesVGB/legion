import { randomBytes } from 'node:crypto';
import { MessageFlags, ButtonStyle } from 'discord.js';
import { assertUser } from '../../common/errors.js';
import { embed, row, button, safeText } from '../../ui/messages.js';
import { staffLogChannel, quiet } from '../tickets/service.js';
import { GANGPOT_LEAD_ROLE_ID } from '../gangpot/index.js';
import { serializeCommunity, updateCommunityPost } from '../../common/discord-posts.js';
import { queueFeatureNotice, deliverFeatureNotices } from '../../common/notices.js';
const labels = {
  draft: 'Wacht op uitleg',
  pending: 'Wacht op Lead',
  approved: 'Goedgekeurd · warn ingetrokken',
  rejected: 'Afgewezen',
  cancelled: 'Gesloten · warn was al ingetrokken',
};
export const appealById = (ctx, id) =>
  ctx.store.db.prepare('SELECT * FROM warn_appeals WHERE id=?').get(id);
function requireMain(ctx, guild) {
  assertUser(
    ctx.config.guildId === '1555685630640652338' && guild?.id === ctx.config.guildId,
    'Bezwaren worden in de Bakarov-hoofdserver behandeld.',
  );
}
async function ownerWarning(ctx, guild, user, warn) {
  requireMain(ctx, guild);
  assertUser(
    typeof warn === 'string' && /^[a-f0-9]{12}$/.test(warn),
    'Gebruik het warn-ID uit /mijnwarns.',
  );
  const member = await guild.members.fetch({ user, force: true }).catch((error) => {
    if (error.code === 10007) return null;
    throw error;
  });
  assertUser(member && !member.user.bot, 'Je moet lid zijn van deze server.');
  const warning = ctx.store.db.prepare('SELECT * FROM warnings WHERE id=?').get(warn);
  assertUser(
    warning && warning.user_id === user,
    'Je kunt alleen bezwaar maken tegen je eigen gangwarn.',
  );
  assertUser(
    warning.removed_at === null,
    'Deze gangwarn is al ingetrokken. Er is geen bezwaar meer nodig.',
  );
  return warning;
}
export async function beginWarnAppeal(ctx, guild, user, warn, now = Date.now()) {
  await ownerWarning(ctx, guild, user, warn);
  return ctx.store.transaction(() => {
    let appeal = ctx.store.db.prepare('SELECT * FROM warn_appeals WHERE warn_id=?').get(warn);
    if (!appeal) {
      const id = randomBytes(6).toString('hex');
      ctx.store.db
        .prepare(
          "INSERT INTO warn_appeals(id,warn_id,user_id,status,created_at) VALUES(?,?,?,'draft',?)",
        )
        .run(id, warn, user, now);
      appeal = appealById(ctx, id);
    }
    if (appeal.status === 'draft') ctx.store.setSetting(`appeal:draft:${user}`, warn);
    return appeal;
  });
}
export async function submitWarnAppeal(ctx, guild, user, reason, warn, now = Date.now()) {
  requireMain(ctx, guild);
  assertUser(
    typeof reason === 'string' && reason.trim() && reason.trim().length <= 1000,
    'Leg je bezwaar uit in 1 tot 1000 tekens.',
  );
  const id = warn || ctx.store.setting(`appeal:draft:${user}`);
  assertUser(id, 'Klik eerst op Bezwaar maken bij je warn, of geef het ID uit /mijnwarns mee.');
  await ownerWarning(ctx, guild, user, id);
  const channel = await staffLogChannel(guild, ctx.config);
  return ctx.store.transaction(() => {
    let appeal = ctx.store.db.prepare('SELECT * FROM warn_appeals WHERE warn_id=?').get(id);
    if (appeal && appeal.status !== 'draft') return appeal;
    if (!appeal) {
      const appealId = randomBytes(6).toString('hex');
      ctx.store.db
        .prepare(
          "INSERT INTO warn_appeals(id,warn_id,user_id,status,created_at) VALUES(?,?,?,'draft',?)",
        )
        .run(appealId, id, user, now);
      appeal = appealById(ctx, appealId);
    }
    // Recheck after the awaited permission check: an automatic correction may have withdrawn the warn.
    assertUser(
      ctx.store.db.prepare('SELECT removed_at FROM warnings WHERE id=?').get(id)?.removed_at ===
        null,
      'Deze gangwarn is inmiddels ingetrokken.',
    );
    ctx.store.db
      .prepare(
        "UPDATE warn_appeals SET reason=?,status='pending',submitted_at=?,channel_id=?,dirty=1,next_attempt=0 WHERE id=?",
      )
      .run(reason.trim(), now, channel.id, appeal.id);
    ctx.store.audit('warn.appeal.submit', user, { id: appeal.id, warn: id });
    return appealById(ctx, appeal.id);
  });
}
function queueDecision(ctx, appeal, now) {
  queueFeatureNotice(ctx, {
    key: `warn.appeal:${appeal.id}:${appeal.status}`,
    kind: 'warn.appeal',
    user: appeal.user_id,
    now,
    payload: {
      embeds: [
        embed(
          ctx.config,
          'Bakarov — Beslissing over je bezwaar',
          `**Warn-ID:** \`${appeal.warn_id}\`\n**Status:** ${labels[appeal.status]}\n${appeal.status === 'approved' ? 'Lead heeft je bezwaar goedgekeurd. De gangwarn is ingetrokken.' : appeal.status === 'rejected' ? 'Lead heeft je bezwaar afgewezen. De gangwarn blijft actief zolang die niet afzonderlijk wordt ingetrokken.' : 'De gangwarn was al ingetrokken. Je bezwaar is daarom gesloten.'}\n\n**Actieve gangwarns:** ${ctx.store.warnCount(appeal.user_id)}`,
        ).setColor(appeal.status === 'rejected' ? 0xef4444 : 0x22c55e),
      ],
    },
  });
}
export async function decideWarnAppeal(ctx, guild, member, id, decision, now = Date.now()) {
  requireMain(ctx, guild);
  assertUser(['approve', 'reject'].includes(decision), 'Kies goedkeuren of afwijzen.');
  const lead = await guild.members.fetch({ user: member.id, force: true });
  assertUser(
    !lead.user.bot && lead.roles.cache.has(GANGPOT_LEAD_ROLE_ID),
    'Alleen iemand met de Lead-rol kan bezwaren beoordelen.',
  );
  return serializeCommunity(`${guild.id}:appeal:${id}`, () =>
    ctx.store.transaction(() => {
      const appeal = appealById(ctx, id);
      assertUser(appeal, 'Dit bezwaar bestaat niet.');
      if (appeal.status !== 'pending') return appeal;
      assertUser(
        lead.id !== appeal.user_id,
        'Laat een ander Lead-lid je eigen bezwaar beoordelen.',
      );
      const warning = ctx.store.db
        .prepare('SELECT * FROM warnings WHERE id=? AND user_id=?')
        .get(appeal.warn_id, appeal.user_id);
      assertUser(warning, 'De oorspronkelijke warn ontbreekt.');
      const status =
        warning.removed_at !== null
          ? 'cancelled'
          : decision === 'approve'
            ? 'approved'
            : 'rejected';
      if (status === 'approved') {
        const reason = `Bezwaar ${id} goedgekeurd door Lead.`;
        ctx.store.db
          .prepare(
            'UPDATE warnings SET removed_at=?,removed_by=?,removed_reason=? WHERE id=? AND removed_at IS NULL',
          )
          .run(now, lead.id, reason, warning.id);
        ctx.store.db
          .prepare('UPDATE gangpot_dues SET warn_cleared_by_payment=0 WHERE warn_id=?')
          .run(warning.id);
        ctx.store.db
          .prepare(
            "UPDATE gangpot_notifications SET log_id=COALESCE(log_id,'skipped'),dm_id=COALESCE(dm_id,'skipped'),last_error=NULL WHERE warn_id=? AND kind IN ('issue','restore')",
          )
          .run(warning.id);
        ctx.store.db
          .prepare(
            "UPDATE activity_check_members SET status='exempt' WHERE warn_id=? AND status='warned'",
          )
          .run(warning.id);
        ctx.store.db
          .prepare(
            'UPDATE activity_check_sessions SET dirty=1,next_attempt=0 WHERE id IN (SELECT check_id FROM activity_check_members WHERE warn_id=?)',
          )
          .run(warning.id);
        ctx.store.audit('warn.remove', lead.id, { id: warning.id, user: warning.user_id, reason });
      }
      ctx.store.db
        .prepare(
          'UPDATE warn_appeals SET status=?,reviewer_id=?,reviewed_at=?,dirty=1,next_attempt=0 WHERE id=?',
        )
        .run(status, lead.id, now, id);
      ctx.store.audit(`warn.appeal.${status}`, lead.id, {
        id,
        warn: warning.id,
        user: warning.user_id,
      });
      const result = appealById(ctx, id);
      queueDecision(ctx, result, now);
      return result;
    }),
  );
}
export function warnAppealMessage(ctx, appeal) {
  const warning = ctx.store.db.prepare('SELECT * FROM warnings WHERE id=?').get(appeal.warn_id),
    pending = appeal.status === 'pending';
  const card = embed(
    ctx.config,
    'Bakarov — Bezwaar tegen gangwarn',
    `**Lid:** <@${appeal.user_id}>\n**Warn-ID:** \`${appeal.warn_id}\`\n**Status:** ${labels[appeal.status]}${appeal.reviewer_id ? `\n**Beoordeeld door:** <@${appeal.reviewer_id}>` : ''}`,
  )
    .addFields({
      name: 'Oorspronkelijke warn',
      value: safeText(warning?.reason || 'Warn niet beschikbaar.').slice(0, 1000),
    })
    .setColor(pending ? 0xf59e0b : appeal.status === 'rejected' ? 0xef4444 : 0x22c55e)
    .setFooter({ text: `Bakarov • Bezwaar ${appeal.id}` });
  const text = safeText(appeal.reason || 'Nog niet ingediend.');
  for (let offset = 0; offset < text.length; ) {
    let end = Math.min(offset + 1000, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    card.addFields({
      name: offset ? 'Uitleg (vervolg)' : 'Uitleg van het lid',
      value: text.slice(offset, end),
    });
    offset = end;
  }
  return {
    embeds: [card],
    components: pending
      ? [
          row(
            button(
              `warnappeal:approve:${appeal.id}`,
              'Goedkeuren · warn intrekken',
              ButtonStyle.Success,
            ),
            button(`warnappeal:reject:${appeal.id}`, 'Afwijzen', ButtonStyle.Danger),
          ),
        ]
      : [],
    allowedMentions: quiet,
  };
}
export async function syncWarnAppeals(ctx, guild, now = Date.now()) {
  if (ctx.config.guildId !== '1555685630640652338') return;
  return serializeCommunity(`${guild.id}:warn-appeals`, async () => {
    requireMain(ctx, guild);
    ctx.store.transaction(() => {
      for (const item of ctx.store.db
        .prepare(
          "SELECT a.* FROM warn_appeals a JOIN warnings w ON w.id=a.warn_id WHERE a.status IN ('draft','pending') AND w.removed_at IS NOT NULL",
        )
        .all()) {
        ctx.store.db
          .prepare(
            "UPDATE warn_appeals SET status='cancelled',reviewed_at=?,dirty=?,next_attempt=0 WHERE id=?",
          )
          .run(now, item.status === 'pending' ? 1 : 0, item.id);
        if (item.status === 'pending') queueDecision(ctx, appealById(ctx, item.id), now);
      }
    });
    for (const item of ctx.store.db
      .prepare(
        "SELECT * FROM warn_appeals WHERE status!='draft' AND channel_id IS NOT NULL AND dirty=1 AND next_attempt<=? LIMIT 20",
      )
      .all(now)) {
      try {
        await staffLogChannel(guild, { ...ctx.config, logChannelId: item.channel_id });
        await updateCommunityPost(
          ctx,
          guild,
          'warn_appeals',
          item,
          warnAppealMessage(ctx, item),
          `Bakarov • Bezwaar ${item.id}`,
        );
      } catch (error) {
        ctx.store.db
          .prepare('UPDATE warn_appeals SET last_error=?,next_attempt=? WHERE id=?')
          .run(String(error.code || error.name), now + 60000, item.id);
      }
    }
    await deliverFeatureNotices(ctx, guild, now, () => true, ['warn.appeal']);
  });
}
export async function handleWarnAppealCommand(ctx, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const appeal = await submitWarnAppeal(
    ctx,
    interaction.guild,
    interaction.user.id,
    interaction.options.getString('uitleg', true),
    interaction.options.getString('id')?.trim().toLowerCase(),
  );
  await syncWarnAppeals(ctx, interaction.guild);
  return interaction.editReply({
    content: `Bezwaar \`${appeal.id}\`: **${labels[appeal.status]}**. Je krijgt de beslissing per DM. Een lopend bezwaar geeft geen uitstel of vrijstelling.`,
    allowedMentions: quiet,
  });
}
export async function handleWarnAppealButton(ctx, interaction) {
  const parts = interaction.customId.split(':'),
    inGuild = interaction.inGuild(),
    guild = inGuild ? interaction.guild : interaction.client.guilds.cache.get(parts[2]);
  if (parts[1] === 'start') {
    assertUser(
      parts[2] === ctx.config.guildId && (!inGuild || interaction.guildId === parts[2]),
      'Deze knop hoort bij een andere server.',
    );
    await interaction.deferReply(inGuild ? { flags: MessageFlags.Ephemeral } : {});
    const appeal = await beginWarnAppeal(ctx, guild, interaction.user.id, parts[3]);
    return interaction.editReply({
      content:
        appeal.status === 'draft'
          ? `Je maakt bezwaar tegen gangwarn \`${appeal.warn_id}\`. Geef je uitleg in de hoofdserver met:\n\`/bezwaar uitleg: jouw uitleg\`\nJe hebt geen formulier nodig. Alleen Lead kan het bezwaar goedkeuren.\n[Hoofdserver openen](https://discord.com/channels/${ctx.config.guildId})`
          : `Bezwaar \`${appeal.id}\`: **${labels[appeal.status]}**. Er wordt geen tweede bezwaar aangemaakt.`,
      allowedMentions: quiet,
    });
  }
  requireMain(ctx, guild);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const appeal = appealById(ctx, parts[2]);
  assertUser(
    appeal &&
      appeal.channel_id === interaction.channelId &&
      appeal.message_id === interaction.message.id,
    'Deze knop hoort niet bij dit bezwaar.',
  );
  const result = await decideWarnAppeal(ctx, guild, interaction.member, parts[2], parts[1]);
  await syncWarnAppeals(ctx, guild);
  return interaction.editReply({
    content: `Bezwaar: **${labels[result.status]}**.`,
    allowedMentions: quiet,
  });
}
