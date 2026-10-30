import { AuditLogEvent, PermissionFlagsBits as P } from 'discord.js';
import { safeText } from '../../ui/messages.js';
import { operationSettings } from '../../config/features.js';

const spamByMember = new Map(),
  linkByMember = new Map();
let lastMemoryPrune = 0,
  lastIncidentCleanup = 0;
const LINK =
  /[a-z][a-z0-9+.-]*:\/\/[^\s<>]+|\bwww\.[^\s<>]+|\b(?:[a-z0-9-]+\.)+(?:com|net|org|nl|be|gg|io|me|tv|co|eu|xyz|site|app|dev)[a-z0-9.-]*(?::\d+)?(?:[/?#][^\s<>]*)?/giu;
const COMMUNITY_GUILD_ID = '1555726440933363753';
const MAIN_GUILD_ID = '1555685630640652338';
const MEDIA_HOSTS = ['youtube.com', 'youtu.be', 'medal.tv'];
const PROFANITY =
  /\b(?:kanker|tering|tyfus|godverdomme|godver|kut|klootzak|eikel|lul|hoer|fuck(?:er|ing)?|shit|bitch|asshole|motherfucker)\b/iu;
const protectedAuditActions = new Set([
  AuditLogEvent.ChannelCreate,
  AuditLogEvent.ChannelUpdate,
  AuditLogEvent.ChannelDelete,
  AuditLogEvent.ChannelOverwriteCreate,
  AuditLogEvent.ChannelOverwriteUpdate,
  AuditLogEvent.ChannelOverwriteDelete,
  AuditLogEvent.RoleCreate,
  AuditLogEvent.RoleUpdate,
  AuditLogEvent.RoleDelete,
  AuditLogEvent.MemberKick,
  AuditLogEvent.MemberBanAdd,
  AuditLogEvent.MemberBanRemove,
  AuditLogEvent.MemberPrune,
  AuditLogEvent.InviteCreate,
  AuditLogEvent.InviteDelete,
  AuditLogEvent.WebhookCreate,
  AuditLogEvent.WebhookUpdate,
  AuditLogEvent.WebhookDelete,
  AuditLogEvent.GuildUpdate,
  AuditLogEvent.MessageBulkDelete,
]);

const key = (guildId, userId) => `${guildId}:${userId}`;
function audit(ctx, event, actor, details) {
  ctx.store.audit(event, actor || '', details);
}
export function securityTrustedRoleIds(config) {
  return [
    ...new Set(
      [config.security?.trustedRoleId, ...(config.staffRoleIds || [])].filter(
        (id) => typeof id === 'string' && id && id !== config.guildId,
      ),
    ),
  ];
}
function trusted(ctx, member) {
  return Boolean(
    member && securityTrustedRoleIds(ctx.config).some((id) => member.roles?.cache?.has(id)),
  );
}
function shortReason(reason) {
  return safeText(reason).slice(0, 300);
}
function settings(ctx) {
  return operationSettings(ctx).security;
}
export function securityIsEnabled(ctx) {
  return Boolean(ctx.config.security?.enabled && settings(ctx).enabled);
}
function linkHostAllowed(value, hosts, blockRedirects = false) {
  try {
    const input = String(value).replace(/[)\]},.!?;]+$/u, '');
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port)
      return false;
    const host = url.hostname.toLowerCase().replace(/\.$/, ''),
      path = decodeURIComponent(url.pathname).toLowerCase();
    if (blockRedirects && /^\/(?:redirect|attribution_link)(?:\/|$)/.test(path)) return false;
    return hosts.some((domain) => host === domain || host.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}
function mediaLinkAllowed(ctx, message, value) {
  const guildId = message.guild?.id;
  if (
    guildId !== ctx.config.guildId ||
    guildId !== COMMUNITY_GUILD_ID ||
    !ctx.config.mediaChannelId ||
    message.channelId !== ctx.config.mediaChannelId
  )
    return false;
  return linkHostAllowed(value, MEDIA_HOSTS, true);
}
function registeredTicket(ctx, message) {
  if (message.guild?.id !== ctx.config.guildId) return false;
  const dossier = ctx.store.caseByChannel?.(message.channelId);
  return Boolean(
    dossier &&
      ['ticket', 'application'].includes(dossier.kind) &&
      dossier.channel_id === message.channelId,
  );
}
function incidentCount(ctx, userId, kind, now, days) {
  const since = now - days * 24 * 60 * 60 * 1000;
  if (now - lastIncidentCleanup > 60 * 60 * 1000) {
    ctx.store.db
      .prepare('DELETE FROM security_incidents WHERE created_at<?')
      .run(now - 365 * 24 * 60 * 60 * 1000);
    lastIncidentCleanup = now;
  }
  ctx.store.db
    .prepare('INSERT INTO security_incidents(user_id,kind,created_at,reason) VALUES(?,?,?,?)')
    .run(userId, kind, now, kind);
  return ctx.store.db
    .prepare(
      'SELECT COUNT(*) AS count FROM security_incidents WHERE user_id=? AND kind=? AND created_at>=?',
    )
    .get(userId, kind, since).count;
}
function pruneMemory(now) {
  if (now - lastMemoryPrune < 60 * 1000) return;
  lastMemoryPrune = now;
  for (const [id, items] of spamByMember) {
    const recent = items.filter((item) => now - item.at < 60_000);
    if (recent.length) spamByMember.set(id, recent);
    else spamByMember.delete(id);
  }
  for (const [id, items] of linkByMember) {
    const recent = items.filter((item) => now - item.at < 120 * 60_000);
    if (recent.length) linkByMember.set(id, recent);
    else linkByMember.delete(id);
  }
}

export async function initializeSecurity(ctx, guild) {
  const config = ctx.config.security;
  if (!config?.enabled) return false;
  const role = await guild.roles.fetch(config.trustedRoleId).catch(() => null);
  if (!role) {
    audit(ctx, 'security.unavailable', ctx.config.clientId, {
      status: 'Vertrouwensrol ontbreekt',
      roleId: config.trustedRoleId,
    });
    console.error(
      `Guild ${guild.id}: beveiliging uitgeschakeld; vertrouwensrol ${config.trustedRoleId} bestaat niet.`,
    );
    return false;
  }
  const me = guild.members.me || (await guild.members.fetchMe());
  const required = [P.ViewAuditLog, P.ManageMessages, P.ModerateMembers, P.BanMembers];
  const missing = required.filter((permission) => !me.permissions.has(permission));
  if (missing.length) {
    audit(ctx, 'security.unavailable', ctx.config.clientId, {
      status: 'Botrechten ontbreken',
      permissions: ['View Audit Log', 'Manage Messages', 'Moderate Members', 'Ban Members'].filter(
        (_, index) => !me.permissions.has(required[index]),
      ),
    });
    console.error(
      `Guild ${guild.id}: beveiliging beperkt; geef de bot View Audit Log, Manage Messages, Moderate Members en Ban Members.`,
    );
    return false;
  }
  audit(ctx, 'security.ready', ctx.config.clientId, {
    status: securityIsEnabled(ctx) ? 'Beveiliging aan' : 'Beveiliging uit via dashboard',
    roleId: config.trustedRoleId,
    raidEnabled: settings(ctx).raidEnabled,
  });
  return true;
}

async function removeMessages(ctx, messages) {
  const unique = [
    ...new Map(messages.filter(Boolean).map((message) => [message.id, message])).values(),
  ];
  const results = await Promise.all(
    unique.map((message) =>
      message
        .delete()
        .then(() => ({ message, removed: true }))
        .catch((error) => ({ message, error: error.code === 10008 ? null : error })),
    ),
  );
  const removed = results.filter((result) => result.removed),
    failed = results.filter((result) => result.error);
  if (removed.length)
    audit(ctx, 'security.messages_removed', ctx.config.clientId, {
      count: removed.length,
      channels: [...new Set(removed.map((item) => item.message.channelId))],
    });
  if (failed.length)
    audit(ctx, 'security.delete_failed', ctx.config.clientId, {
      count: failed.length,
      channels: [...new Set(failed.map((item) => item.message.channelId))],
    });
}
async function notify(ctx, member, text) {
  const user = member?.user || member;
  try {
    if (typeof user?.send !== 'function')
      throw Object.assign(new Error('DM niet beschikbaar'), { code: 'DM_UNAVAILABLE' });
    await user.send({ content: text, allowedMentions: { parse: [] } });
    audit(ctx, 'security.notice_sent', ctx.config.clientId, { user: member.id, notice: text });
  } catch (error) {
    audit(ctx, 'security.notice_failed', ctx.config.clientId, {
      user: member.id,
      notice: text,
      error: String(error.code || error.name),
    });
  }
}
async function banMember(ctx, guild, member, reason) {
  const memberId = member.id;
  await notify(
    ctx,
    member,
    `Je bent uit **${safeText(ctx.config.content.gangName)}** verbannen. Reden: ${shortReason(reason)}`,
  );
  try {
    await guild.members.ban(memberId, { reason: `Bakarov-beveiliging: ${reason}` });
    audit(ctx, 'security.ban', guild.members.me?.id, { user: memberId, reason });
    return true;
  } catch (error) {
    audit(ctx, 'security.enforcement_failed', guild.members.me?.id, {
      user: memberId,
      action: 'ban',
      reason,
      error: String(error.code || error.name),
    });
    return false;
  }
}
export async function handleSecurityMessage(ctx, message, now = Date.now()) {
  pruneMemory(now);
  if (message?.partial) message = await message.fetch().catch(() => null);
  if (
    !message ||
    !securityIsEnabled(ctx) ||
    !ctx.securityReady ||
    !message.guild ||
    !message.author ||
    message.author.bot ||
    message.webhookId
  )
    return;
  const member =
    message.member || (await message.guild.members.fetch(message.author.id).catch(() => null));
  if (!member || trusted(ctx, member)) return;
  const policy = settings(ctx),
    id = key(message.guild.id, member.id),
    allURLs = [...(message.content || '').matchAll(LINK)].map((match) => match[0]);
  const embedURLs = (message.embeds || []).map((embed) => embed.url).filter(Boolean),
    inTicket = Boolean((allURLs.length || embedURLs.length) && registeredTicket(ctx, message));
  const mainLinksAllowed =
    ctx.config.guildId === MAIN_GUILD_ID && message.guild.id === MAIN_GUILD_ID;
  const classify = (url) =>
    inTicket
      ? 'ticket'
      : mainLinksAllowed
        ? 'guild'
        : mediaLinkAllowed(ctx, message, url)
          ? 'media'
          : null;
  const contentLinks = allURLs.map((url) => ({ url, kind: classify(url) })),
    previewLinks = embedURLs.map((url) => ({ url, kind: classify(url) }));
  const urls = contentLinks.filter((link) => !link.kind).map((link) => link.url),
    blockedEmbedURLs = previewLinks.filter((link) => !link.kind);
  const linkHistory = (linkByMember.get(id) || []).filter(
    (entry) => now - entry.at < policy.linkWindowMinutes * 60 * 1000,
  );
  if (urls.length || blockedEmbedURLs.length) {
    const entries = [...linkHistory, { at: now, message }],
      count = incidentCount(ctx, member.id, 'links', now, policy.linkWindowMinutes / 1440);
    linkByMember.set(id, entries);
    if (urls.length >= 2 || count >= policy.linkBanCount) {
      await removeMessages(
        ctx,
        entries.map((entry) => entry.message),
      );
      await banMember(
        ctx,
        message.guild,
        member,
        urls.length >= 2
          ? 'meerdere links in één bericht'
          : `meerdere linkberichten binnen ${policy.linkWindowMinutes} minuten`,
      );
      linkByMember.delete(id);
      audit(ctx, 'security.links_ban', member.id, {
        count,
        urls: urls.length,
        channel: message.channelId,
      });
    } else {
      await removeMessages(ctx, [message]);
      audit(ctx, 'security.link_removed', member.id, { channel: message.channelId, urls: 1 });
      await notify(
        ctx,
        member,
        `Je bericht bevat een niet-toegestane link en is verwijderd. Bij ${policy.linkBanCount} verboden linkberichten binnen ${policy.linkWindowMinutes} minuten volgt een ban.`,
      );
    }
    return false;
  }
  for (const [kind, event] of [
    ['guild', 'security.guild_links_allowed'],
    ['media', 'security.media_links_allowed'],
    ['ticket', 'security.ticket_links_allowed'],
  ]) {
    const count =
      contentLinks.filter((link) => link.kind === kind).length ||
      previewLinks.filter((link) => link.kind === kind).length;
    if (count)
      audit(ctx, event, member.id, { user: member.id, channel: message.channelId, urls: count });
  }
  const mentionCount = message.mentions.users.size + message.mentions.roles.size;
  if (message.mentions.everyone || mentionCount > policy.allowedMentions) {
    await removeMessages(ctx, [message]);
    await banMember(
      ctx,
      message.guild,
      member,
      message.mentions.everyone
        ? '@everyone/@here vermelding'
        : `meer dan ${policy.allowedMentions} leden of rollen tegelijk taggen`,
    );
    audit(ctx, 'security.mention_ban', member.id, {
      count: mentionCount,
      everyone: message.mentions.everyone,
      channel: message.channelId,
    });
    return false;
  }
  if (PROFANITY.test(message.content || '')) {
    await timeoutMember(
      ctx,
      message.guild,
      member,
      'profanity',
      'schelden of grof taalgebruik',
      [message],
      now,
      policy,
    );
    return false;
  }
  const text = (message.content || '').trim().toLocaleLowerCase('nl-BE').replace(/\s+/g, ' ');
  if (!text) return;
  const recent = (spamByMember.get(id) || []).filter(
    (entry) => now - entry.at < policy.spamWindowSeconds * 1000,
  );
  recent.push({ at: now, text, message });
  spamByMember.set(id, recent);
  const duplicates = recent.filter((entry) => entry.text === text);
  if (
    recent.length >= policy.spamMessageCount ||
    duplicates.length >= policy.duplicateMessageCount
  ) {
    spamByMember.delete(id);
    await timeoutMember(
      ctx,
      message.guild,
      member,
      'spam',
      'berichten spammen',
      recent.map((entry) => entry.message),
      now,
      policy,
    );
    return false;
  }
  return true;
}

async function timeoutMember(ctx, guild, member, kind, text, messages, now, policy) {
  await removeMessages(ctx, messages);
  const count = incidentCount(ctx, member.id, kind, now, policy.escalationDays);
  const durations = policy.escalationEnabled
    ? [policy.timeoutMinutes, policy.timeoutMinutes * 3, policy.timeoutMinutes * 6, 1440]
    : [policy.timeoutMinutes];
  const minutes = Math.min(1440, durations[Math.min(count - 1, durations.length - 1)]);
  await notify(
    ctx,
    member,
    `Je berichten zijn verwijderd en je hebt een time-out van ${minutes} minuten gekregen. Reden: ${shortReason(text)}${policy.escalationEnabled && count > 1 ? ` (overtreding ${count})` : ''}`,
  );
  try {
    await member.timeout(minutes * 60 * 1000, `Bakarov-beveiliging: ${text}`);
    audit(ctx, 'security.timeout', guild.members.me?.id, {
      user: member.id,
      reason: text,
      minutes,
      count,
      incident: kind,
    });
  } catch (error) {
    audit(ctx, 'security.enforcement_failed', guild.members.me?.id, {
      user: member.id,
      action: 'timeout',
      reason: text,
      error: String(error.code || error.name),
    });
  }
}

export async function handleSecurityJoin(ctx, member, now = Date.now()) {
  pruneMemory(now);
  const policy = settings(ctx);
  if (!securityIsEnabled(ctx) || !policy.raidEnabled) {
    ctx.securityRaidUntil = 0;
    ctx.securityJoins = [];
    return;
  }
  if (!ctx.securityReady || member.user.bot || trusted(ctx, member)) return;
  const recent = (ctx.securityJoins || []).filter(
    (entry) => now - entry.at < policy.raidWindowSeconds * 1000,
  );
  recent.push({ at: now, id: member.id });
  ctx.securityJoins = recent.slice(-policy.raidJoinCount);
  if (
    recent.length >= policy.raidJoinCount &&
    (!ctx.securityRaidUntil || ctx.securityRaidUntil < now)
  ) {
    ctx.securityRaidUntil = now + policy.raidModeMinutes * 60 * 1000;
    audit(ctx, 'security.raid_detected', member.id, {
      joins: recent.length,
      windowSeconds: policy.raidWindowSeconds,
      until: ctx.securityRaidUntil,
    });
  } else if (ctx.securityRaidUntil > now) {
    await notify(
      ctx,
      member,
      'De server heeft tijdelijk een beveiligingscontrole ingeschakeld vanwege veel nieuwe leden. Je account is tijdelijk beperkt.',
    );
    try {
      await member.timeout(
        policy.raidTimeoutMinutes * 60 * 1000,
        'Bakarov-beveiliging: tijdelijke raidbeveiliging',
      );
      audit(ctx, 'security.raid_timeout', ctx.config.clientId, {
        user: member.id,
        minutes: policy.raidTimeoutMinutes,
      });
    } catch (error) {
      audit(ctx, 'security.enforcement_failed', ctx.config.clientId, {
        user: member.id,
        action: 'raid timeout',
        error: String(error.code || error.name),
      });
    }
  }
}

function timeoutChange(entry) {
  return (
    entry.changes?.some(
      (change) => change.key === 'communication_disabled_until' && change.old !== change.new,
    ) ?? false
  );
}
export async function handleSecurityAudit(ctx, entry, guild) {
  if (
    !securityIsEnabled(ctx) ||
    !ctx.securityReady ||
    !entry.executorId ||
    entry.executorId === guild.members.me?.id
  )
    return;
  const risky =
    protectedAuditActions.has(entry.action) ||
    (entry.action === AuditLogEvent.MemberUpdate && timeoutChange(entry));
  if (!risky) return;
  let actor = await guild.members.fetch(entry.executorId).catch(() => null);
  if (actor?.user.bot || entry.executor?.bot || trusted(ctx, actor)) return;
  if (entry.action === AuditLogEvent.InviteCreate && settings(ctx).allowInviteCreation) {
    audit(ctx, 'security.invite_created', entry.executorId, {
      action: 'Uitnodiging aangemaakt',
      status: 'Toegestaan',
    });
    return;
  }
  const action =
    entry.action === AuditLogEvent.MemberKick
      ? 'iemand kicken'
      : entry.action === AuditLogEvent.MemberBanAdd
        ? 'iemand bannen'
        : entry.action === AuditLogEvent.MemberBanRemove
          ? 'een ban intrekken'
          : entry.action === AuditLogEvent.MemberUpdate
            ? 'iemand time-outen'
            : entry.action === AuditLogEvent.ChannelOverwriteCreate ||
                entry.action === AuditLogEvent.ChannelOverwriteUpdate ||
                entry.action === AuditLogEvent.ChannelOverwriteDelete
              ? 'kanaalrechten wijzigen'
              : entry.action === AuditLogEvent.MemberPrune
                ? 'leden verwijderen via prune'
                : entry.action === AuditLogEvent.InviteCreate
                  ? 'een uitnodiging maken'
                  : entry.action === AuditLogEvent.InviteDelete
                    ? 'een uitnodiging verwijderen'
                    : entry.action === AuditLogEvent.MessageBulkDelete
                      ? 'berichten in bulk verwijderen'
                      : `serveronderdeel wijzigen (${entry.action})`;
  const reason = `onbevoegde actie: ${action}`;
  if (!actor)
    actor = {
      id: entry.executorId,
      send: async () => {
        throw new Error('DM_UNAVAILABLE');
      },
    };
  const banned = await banMember(ctx, guild, actor, reason);
  audit(
    ctx,
    banned ? 'security.unauthorized_action' : 'security.unauthorized_action_failed',
    entry.executorId,
    { action, target: entry.targetId || null, entry: String(entry.id), reason },
  );
}

export function resetSecurityState() {
  spamByMember.clear();
  linkByMember.clear();
  lastMemoryPrune = 0;
  lastIncidentCleanup = 0;
}
