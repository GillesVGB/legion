import { ButtonBuilder, ButtonStyle, Routes, PermissionFlagsBits as P, ChannelType } from 'discord.js';
import { createHash } from 'node:crypto';
import { assertUser } from './errors.mjs';
import { embed, row } from './ui.mjs';

const snowflake = /^\d{17,20}$/;
const busy = new Set();
const admissionTasks = new Map();
async function runAdmission(key, task) {
  const previous=admissionTasks.get(key) || Promise.resolve();
  const current=previous.catch(()=>{}).then(task);
  admissionTasks.set(key,current);
  try{return await current;}finally{if(admissionTasks.get(key)===current)admissionTasks.delete(key);}
}
const quiet = { parse: [], repliedUser: false };
export function inviteTargets(csv) {
  return csv.trim().split(/\r?\n/).map(line => line.trim().replace(/^"|"$/g, '')).filter(line => snowflake.test(line));
}
export async function removeInvite(rest, code) {
  if (!code) return;
  await rest.delete(Routes.invite(code), { reason: 'Legion persoonlijke uitnodiging afgehandeld' }).catch(error => { if (error.code !== 10006) throw error; });
}
async function verifyTargets(rest, code, userId) {
  const data = await rest.get(Routes.inviteTargetUsers(code));
  const targets = inviteTargets(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));
  assertUser(targets.length === 1 && targets[0] === userId, 'Discord bevestigde geen uitnodiging voor uitsluitend deze sollicitant.');
}
export async function createPersonalInvite(rest, { channelId, guildId, userId, roleId, maxAge = 86400 }) {
  assertUser([channelId, guildId, userId, ...(roleId ? [roleId] : [])].every(id => snowflake.test(id)), 'Controleer de instellingen van de persoonlijke uitnodiging.');
  assertUser(Number.isInteger(maxAge) && maxAge >= 300 && maxAge <= 604800, 'De uitnodiging moet tussen 5 minuten en 7 dagen geldig zijn.');
  const invite = await rest.post(Routes.channelInvites(channelId), { reason: 'Legion aangenomen sollicitant: persoonlijke eenmalige uitnodiging',
    body: { max_uses: 1, max_age: maxAge, unique: true, temporary: false, target_user_ids: [userId], ...(roleId ? { role_ids: [roleId] } : {}) } });
  try {
    assertUser(invite.guild?.id === guildId && invite.max_uses === 1 && invite.code, 'Discord gaf geen geldige eenmalige uitnodiging terug.');
    await verifyTargets(rest, invite.code, userId);
    const expiresAt = Date.parse(invite.expires_at);
    assertUser(Number.isFinite(expiresAt) && expiresAt > Date.now(), 'Discord gaf geen geldige vervaltijd terug.');
    return { code: invite.code, expiresAt };
  } catch (error) { await removeInvite(rest, invite.code).catch(() => {}); throw error; }
}

export async function deliverAcceptance(ctx, client, caseId) {
  return runAdmission(`${ctx.config.guildId}:${caseId}`, () => deliverUnlocked(ctx, client, caseId));
}
export async function resendAcceptance(ctx, client, caseId) {
  return runAdmission(`${ctx.config.guildId}:${caseId}`, async () => {
    const notice=ctx.store.acceptance(caseId);
    assertUser(notice && notice.status!=='revoked','Deze uitnodiging is niet beschikbaar of is ingetrokken.');
    await removeInvite(client.rest,notice.invite_code);ctx.store.clearAcceptanceInvite(caseId);ctx.store.requeueAcceptance(caseId);
    return deliverUnlocked(ctx,client,caseId);
  });
}
async function deliverUnlocked(ctx, client, caseId) {
  const key = `${ctx.config.guildId}:${caseId}`;
  if (busy.has(key)) return ctx.store.acceptance(caseId);
  busy.add(key);
  try {
    const { store, config } = ctx;
    let notice = store.acceptance(caseId);
    if (!notice || ['sent','joined','claimed','revoked','expired','dm_blocked'].includes(notice.status)) return notice;
    const dossier = store.caseById(caseId);
    assertUser(dossier?.status === 'accepted' && dossier.owner_id === notice.owner_id, 'Deze sollicitatie is niet aangenomen.');
    const source = client.guilds.cache.get(config.guildId);
    const recipient = await source.members.fetch({ user: notice.owner_id, force: true });
    if(config.memberRoleId && !recipient.roles.cache.has(config.memberRoleId)) {
      store.markAcceptance(caseId,'revoked');await removeInvite(client.rest,notice.invite_code);store.clearAcceptanceInvite(caseId);return store.acceptance(caseId);
    }
    const destination = client.guilds.cache.get(notice.target_guild_id);
    assertUser(destination, 'De bot moet ook in de gangserver staan.');
    const present = await destination.members.fetch({ user: notice.owner_id, force: true }).catch(error => { if (error.code === 10007) return null; throw error; });
    let link;
    if (present) {
      await removeInvite(client.rest, notice.invite_code);
      store.clearAcceptanceInvite(caseId);
      link = `https://discord.com/channels/${destination.id}/${config.admission.inviteChannelId}`;
    } else {
      if (notice.invite_code && notice.expires_at <= Date.now()) { await removeInvite(client.rest, notice.invite_code); store.clearAcceptanceInvite(caseId); notice = store.acceptance(caseId); }
      if (!notice.invite_code) {
        const channel = await destination.channels.fetch(config.admission.inviteChannelId);
        assertUser(channel?.guildId === destination.id && channel.type === ChannelType.GuildText && channel.permissionsFor(destination.members.me)?.has([P.ViewChannel, P.CreateInstantInvite]), 'De bot kan geen uitnodiging maken in het gangkanaal.');
        const roleId = config.admission.targetRoleId;
        if (roleId) {
          const role = await destination.roles.fetch(roleId);
          assertUser(role && !role.managed && role.id !== destination.id && !role.permissions.has(P.Administrator) && destination.members.me.permissions.has(P.ManageRoles) && destination.members.me.roles.highest.comparePositionTo(role) > 0, 'De gangledenrol kan niet veilig worden toegekend.');
        }
        store.bindAcceptanceInvite(caseId, await createPersonalInvite(client.rest, { channelId: channel.id, guildId: destination.id, userId: notice.owner_id, roleId, maxAge: config.admission.inviteMaxAgeSeconds }));
        notice = store.acceptance(caseId);
      } else await verifyTargets(client.rest, notice.invite_code, notice.owner_id);
      link = `https://discord.gg/${notice.invite_code}`;
    }
    if(store.acceptance(caseId).status==='revoked'){await removeInvite(client.rest,store.acceptance(caseId).invite_code);store.clearAcceptanceInvite(caseId);return store.acceptance(caseId);}
    const card = embed(config, 'Je bent aangenomen bij Legion!',
      `Gefeliciteerd, je sollicitatie is **aangenomen**. Welkom bij Legion!\n\n${present ? 'Je staat al in de gangserver. Je kunt hem hieronder openen.' : 'Klik hieronder om de gangserver te joinen. Deze uitnodiging werkt alleen met jouw Discord-account, kan één keer worden gebruikt en vervalt daarna.\n\nGeldig tot: <t:' + Math.floor(notice.expires_at / 1000) + ':F>.'}`).setColor(0x22C55E);
    const message = await recipient.user.send({ embeds: [card], components: [row(new ButtonBuilder().setLabel(present ? 'Gangserver openen' : 'Legion joinen').setStyle(ButtonStyle.Link).setURL(link))],
      allowedMentions: quiet, nonce: createHash('sha256').update(`${config.guildId}:${caseId}:${notice.invite_code || 'member'}`).digest('hex').slice(0, 24), enforceNonce: true });
    store.acceptanceSent(caseId, message.id, Boolean(present));
    return store.acceptance(caseId);
  } catch (error) {
    if(ctx.store.acceptance(caseId)?.status==='revoked')return ctx.store.acceptance(caseId);
    ctx.store.retryAcceptance(caseId, error.code ?? error.message ?? error.name, error.code === 50007);
    console.error(`Guild ${ctx.config.guildId}: aanname-DM ${caseId} ${error.code === 50007 ? 'geblokkeerd door DM-instellingen' : 'wacht op herhaling'} (${error.code ?? error.name}).`);
    return ctx.store.acceptance(caseId);
  } finally { busy.delete(key); }
}

export async function expireAcceptanceInvites(ctx, client) {
  // Een gebruiker kan zijn invite tijdens een herstart hebben gebruikt.
  for (const notice of ctx.store.db.prepare("SELECT * FROM acceptance_notifications WHERE status IN ('sent','claimed')").all()) {
    const destination=client.guilds.cache.get(notice.target_guild_id);
    if(destination?.members.cache.has(notice.owner_id))ctx.store.markAcceptance(notice.case_id,'joined');
  }
  const notices = ctx.store.db.prepare("SELECT * FROM acceptance_notifications WHERE invite_code IS NOT NULL AND (status IN ('joined','revoked') OR expires_at<=?)").all(Date.now());
  for (const notice of notices) {
    try {
      await removeInvite(client.rest, notice.invite_code);
      ctx.store.markAcceptance(notice.case_id, ['joined','revoked'].includes(notice.status) ? notice.status : 'expired', true);
    } catch { /* Volgende achtergrondronde probeert het intrekken opnieuw. */ }
  }
}
export async function admissionJoined(member, contexts) {
  for (const ctx of contexts.values()) {
    const notices = ctx.store.db.prepare("SELECT * FROM acceptance_notifications WHERE owner_id=? AND target_guild_id=? AND status!='revoked'").all(member.id, member.guild.id);
    for (const notice of notices) ctx.store.markAcceptance(notice.case_id, 'joined');
    if (notices.length) await expireAcceptanceInvites(ctx, member.client);
  }
}
export async function revokeAcceptances(ctx, client, ownerId) {
  const notices = ctx.store.db.prepare("SELECT case_id FROM acceptance_notifications WHERE owner_id=? AND status NOT IN ('joined','expired','revoked')").all(ownerId);
  for (const notice of notices) ctx.store.markAcceptance(notice.case_id, 'revoked');
  await expireAcceptanceInvites(ctx, client);
}
