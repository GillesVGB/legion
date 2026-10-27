import { AuditLogEvent, ButtonStyle, MessageFlags } from 'discord.js';
import { assertUser } from './errors.mjs';
import { embed, row, button } from './ui.mjs';
import { quiet, isStaff } from './service.mjs';
import { communityChannel } from './community-posts.mjs';

const REVIEW_DAYS = 14;
const rankIds = ctx => new Set(ctx.config.roster?.roleIds || []);
const probationById = (ctx, id) => ctx.store.db.prepare('SELECT * FROM probation_reviews WHERE case_id=?').get(id);

async function changeActor(guild, memberId, now) {
  try {
    const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.MemberRoleUpdate, limit: 10 });
    return logs.entries.find(entry => entry.target?.id === memberId && Math.abs(now - entry.createdTimestamp) < 30_000)?.executor?.id || null;
  } catch { return null; }
}

export async function recordRankChange(ctx, before, after, now = Date.now()) {
  const ranks = rankIds(ctx);
  const added = [...after.roles.cache.keys()].filter(id => ranks.has(id) && !before.roles.cache.has(id));
  const removed = [...before.roles.cache.keys()].filter(id => ranks.has(id) && !after.roles.cache.has(id));
  if (!added.length && !removed.length) return;

  let actor = await changeActor(after.guild, after.id, now);
  let source = 'discord';
  let approvedBy = [];
  if (added.length) {
    const proposal = ctx.store.db.prepare("SELECT id FROM promotions WHERE member_id=? AND role_id=? AND status IN ('approving','approved') AND created_at>? ORDER BY created_at DESC LIMIT 1")
      .get(after.id, added.at(-1), now - 5 * 60_000);
    if (proposal) {
      approvedBy = ctx.store.db.prepare("SELECT voter_id FROM promotion_votes WHERE proposal_id=? AND response='approve' ORDER BY updated_at").all(proposal.id).map(vote => vote.voter_id);
      source = 'promotie';
    }
  }
  if (approvedBy.length) actor = approvedBy.join(',');
  ctx.store.db.prepare('INSERT INTO rank_history(member_id,added_roles,removed_roles,actor_id,source,changed_at) VALUES(?,?,?,?,?,?)')
    .run(after.id, JSON.stringify(added), JSON.stringify(removed), actor, source, now);
  ctx.store.audit('rank.change', approvedBy.length ? approvedBy[0] : actor || '', { member: after.id, added, removed, source, ...(approvedBy.length ? { approvers: approvedBy } : {}) });
}

export function formatRankHistory(ctx, memberId) {
  const rows = ctx.store.db.prepare('SELECT * FROM rank_history WHERE member_id=? ORDER BY changed_at DESC LIMIT 15').all(memberId);
  const roleName = id => `<@&${id}>`;
  const lines = rows.map(item => {
    const added = JSON.parse(item.added_roles).map(roleName);
    const removed = JSON.parse(item.removed_roles).map(roleName);
    const changes = [...(added.map(role => `+ ${role}`)), ...(removed.map(role => `− ${role}`))].join(' · ');
    const actor = item.actor_id ? item.actor_id.split(',').map(id => `<@${id}>`).join(', ') : 'Niet beschikbaar in Discord-log';
    return `• <t:${Math.floor(item.changed_at / 1000)}:d> — ${changes || 'Rang aangepast'}\n  Door: ${actor}${item.source === 'promotie' ? ' · Goedgekeurd via /promotie' : ''}`;
  });
  return rows.length ? lines.join('\n') : 'Nog geen rangwijzigingen geregistreerd sinds deze functie actief is.';
}

export async function handleRankHistory(ctx, interaction) {
  assertUser(isStaff(interaction, ctx.config), 'Alleen de leiding kan ranggeschiedenis bekijken.');
  const member = interaction.options.getUser('lid', true);
  const history = formatRankHistory(ctx, member.id);
  const card = embed(ctx.config, 'Bakarov — Ranggeschiedenis', `**Lid:** <@${member.id}>\n\n${history}`).setColor(0xD99B12);
  return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [card], allowedMentions: quiet });
}

export function registerProbation(ctx, caseId, memberId, acceptedAt = Date.now()) {
  const startedAt = Number.isFinite(acceptedAt) ? acceptedAt : Date.now();
  ctx.store.db.prepare("INSERT OR IGNORE INTO probation_reviews(case_id,member_id,started_at,due_at) VALUES(?,?,?,?)")
    .run(caseId, memberId, startedAt, startedAt + REVIEW_DAYS * 24 * 60 * 60 * 1000);
}

export function syncProbationStarts(contexts) {
  const destinations = new Map([...contexts].map(([id, ctx]) => [id, ctx]));
  for (const source of contexts.values()) {
    const rows = source.store.db.prepare("SELECT a.case_id,a.owner_id,a.target_guild_id,c.closed_at FROM acceptance_notifications a JOIN cases c ON c.id=a.case_id WHERE c.kind='application' AND c.status='accepted'").all();
    for (const item of rows) {
      const destination = destinations.get(item.target_guild_id);
      if (destination?.config.roster?.roleIds?.length) registerProbation(destination, item.case_id, item.owner_id, item.closed_at || Date.now());
    }
  }
}

function probationMessage(ctx, item) {
  const status = { pending: 'Wacht op Lead-beoordeling', passed: '✅ Proefperiode geslaagd', extended: '🕒 Proefperiode verlengd', followup: '🟠 Verdere opvolging nodig' }[item.status] || item.status;
  const card = embed(ctx.config, 'Bakarov — Beoordeling proefperiode', `**Lid:** <@${item.member_id}>\n**Aangenomen:** <t:${Math.floor(item.started_at / 1000)}:D>\n**Beoordeling vanaf:** <t:${Math.floor(item.due_at / 1000)}:R>\n**Status:** ${status}\n\nLead kan hieronder aangeven hoe de proefperiode is verlopen.`)
    .setColor(item.status === 'passed' ? 0x22C55E : item.status === 'followup' ? 0xF59E0B : 0xD99B12)
    .setFooter({ text: `Bakarov • Proefperiode ${item.case_id}` });
  const components = item.status === 'pending' ? [row(
    button(`probation:passed:${item.case_id}`, 'Geslaagd', ButtonStyle.Success),
    button(`probation:extended:${item.case_id}`, 'Verlengen', ButtonStyle.Secondary),
    button(`probation:followup:${item.case_id}`, 'Opvolging nodig', ButtonStyle.Danger)
  )] : [];
  return { embeds: [card], components, allowedMentions: quiet };
}

export async function syncProbationReviews(ctx, guild, now = Date.now()) {
  const due = ctx.store.db.prepare("SELECT * FROM probation_reviews WHERE status='pending' AND due_at<=? AND review_due_sent_at IS NULL AND next_attempt<=? ORDER BY due_at LIMIT 10").all(now, now);
  for (const item of due) {
    try {
      const channel = ctx.config.botLogChannelId ? await communityChannel(guild, ctx.config.botLogChannelId) : null;
      assertUser(channel?.isTextBased(), 'Het Lead-logkanaal is niet beschikbaar voor proefperiodebeoordelingen.');
      const payload = probationMessage(ctx, item);
      let message = item.message_id ? await channel.messages.fetch(item.message_id).catch(() => null) : null;
      if (message) await message.edit(payload);
      else message = await channel.send(payload);
      ctx.store.db.prepare("UPDATE probation_reviews SET channel_id=?,message_id=?,review_due_sent_at=?,dirty=0,next_attempt=0,last_error=NULL WHERE case_id=?").run(channel.id, message.id, now, item.case_id);
      ctx.store.audit('probation.review_due', '', { member: item.member_id, case: item.case_id, deadline: item.due_at });
    } catch (error) {
      ctx.store.db.prepare('UPDATE probation_reviews SET next_attempt=?,last_error=? WHERE case_id=?').run(now + 60_000, String(error.code || error.name), item.case_id);
    }
  }
}

export async function handleProbationButton(ctx, interaction, action, caseId) {
  assertUser(isStaff(interaction, ctx.config), 'Alleen leden met de Lead-rol kunnen proefperioden beoordelen.');
  const item = probationById(ctx, caseId);
  assertUser(item && item.status === 'pending' && item.message_id === interaction.message.id, 'Deze proefperiode is al beoordeeld of dit is niet het oorspronkelijke bericht.');
  assertUser(['passed','extended','followup'].includes(action),'Deze beoordelingskeuze bestaat niet.');
  const decidedAt = Date.now();
  const newDue = action === 'extended' ? decidedAt + REVIEW_DAYS * 24 * 60 * 60 * 1000 : null;
  ctx.store.transaction(() => {
    if (action === 'extended') {
      ctx.store.db.prepare("UPDATE probation_reviews SET status='pending',due_at=?,reviewed_by=?,reviewed_at=?,review_due_sent_at=NULL,dirty=0,next_attempt=0 WHERE case_id=? AND status='pending'")
        .run(newDue, interaction.user.id, decidedAt, caseId);
    } else {
      ctx.store.db.prepare('UPDATE probation_reviews SET status=?,reviewed_by=?,reviewed_at=?,dirty=1,next_attempt=0 WHERE case_id=? AND status=\'pending\'')
        .run(action, interaction.user.id, decidedAt, caseId);
    }
    ctx.store.audit(`probation.${action}`, interaction.user.id, { member: item.member_id, case: caseId, started: item.started_at, ...(newDue ? { deadline: newDue } : {}) });
  });
  const updated = probationById(ctx, caseId);
  const payload = probationMessage(ctx, updated);
  if (action === 'extended') {
    payload.embeds[0].setDescription(`**Lid:** <@${item.member_id}>\n**Aangenomen:** <t:${Math.floor(item.started_at / 1000)}:D>\n**Nieuwe beoordeling:** <t:${Math.floor(newDue / 1000)}:F>\n**Verlengd door:** <@${interaction.user.id}>`);
    payload.components = [];
  }
  await interaction.update(payload);
}

