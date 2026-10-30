import { operationSettings } from '../config/features.js';
const RECENT_MESSAGE_TTL = 24 * 60 * 60 * 1000;
const RECENT_MESSAGE_LIMIT = 1000;
export function redactMessageText(value, config = {}) {
  let text = String(value ?? '');
  if (config.token) text = text.split(config.token).join('[token afgeschermd]');
  return text
    .replace(/[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/g, '[token afgeschermd]')
    .replace(
      /((?:DISCORD_TOKEN|password|wachtwoord|secret|api[_-]?key)\s*[:=]\s*)\S+/gi,
      '$1[afgeschermd]',
    )
    .replace(/([#?&](?:login|token|key|k|code)=)[^\s&#]+/gi, '$1[afgeschermd]')
    .replace(
      /https?:\/\/(?:discord\.gg|discord(?:app)?\.com\/invite)\/[^\s]+/gi,
      '[uitnodiging afgeschermd]',
    );
}
function snapshot(message, config) {
  const available = Boolean(message && !message.partial && typeof message.content === 'string');
  const attachments = [];
  for (const file of message?.attachments?.values?.() || []) {
    let url;
    try {
      const parsed = new URL(file.url);
      if (
        parsed.protocol === 'https:' &&
        ['cdn.discordapp.com', 'media.discordapp.net'].includes(parsed.hostname)
      )
        url = parsed.href;
    } catch {}
    attachments.push({
      name: redactMessageText(file.name || 'Bijlage', config).slice(0, 200),
      url: url || null,
      size: file.size || 0,
    });
    if (attachments.length === 10) break;
  }
  return {
    available,
    text: available ? redactMessageText(message.content, config).slice(0, 8000) : null,
    attachments,
  };
}
function belongsToContext(ctx, message) {
  return Boolean(
    ctx &&
      message &&
      typeof message.id === 'string' &&
      typeof message.channelId === 'string' &&
      (message.guildId || message.guild?.id) === ctx.config.guildId &&
      (!message.guild?.id || message.guild.id === ctx.config.guildId),
  );
}
function authorDetails(message, config) {
  const author = message.author;
  return {
    authorId: author?.id || null,
    authorName: redactMessageText(
      message.member?.displayName || author?.globalName || author?.username || 'Onbekend',
      config,
    ).slice(0, 100),
    sentAt: message.createdTimestamp || null,
  };
}
function rememberInside(ctx, message, now) {
  if (
    !belongsToContext(ctx, message) ||
    message.author?.bot ||
    !message.author?.id ||
    !operationSettings(ctx).logs.enabled
  )
    return false;
  const after = snapshot(message, ctx.config);
  if (!after.available) return false;
  const db = ctx.store.db;
  db.prepare(
    'INSERT INTO recent_messages(message_id,channel_id,snapshot,updated_at) VALUES(?,?,?,?) ON CONFLICT(message_id) DO UPDATE SET channel_id=excluded.channel_id,snapshot=excluded.snapshot,updated_at=excluded.updated_at',
  ).run(
    message.id,
    message.channelId,
    JSON.stringify({ ...authorDetails(message, ctx.config), after }),
    now,
  );
  db.prepare('DELETE FROM recent_messages WHERE updated_at<=?').run(now - RECENT_MESSAGE_TTL);
  db.prepare(
    'DELETE FROM recent_messages WHERE message_id IN (SELECT message_id FROM recent_messages ORDER BY updated_at DESC,message_id DESC LIMIT -1 OFFSET ?)',
  ).run(RECENT_MESSAGE_LIMIT);
  return true;
}
export function rememberMessage(ctx, message, now = Date.now()) {
  if (
    !belongsToContext(ctx, message) ||
    message.author?.bot ||
    !message.author?.id ||
    !operationSettings(ctx).logs.enabled ||
    message.partial ||
    typeof message.content !== 'string'
  )
    return false;
  return ctx.store.transaction(() => rememberInside(ctx, message, now));
}
function rememberedMessage(ctx, message, now) {
  const saved = ctx.store.db
    .prepare(
      'SELECT snapshot FROM recent_messages WHERE message_id=? AND channel_id=? AND updated_at>? AND updated_at<=?',
    )
    .get(message.id, message.channelId, now - RECENT_MESSAGE_TTL, now);
  if (!saved) return null;
  try {
    const value = JSON.parse(saved.snapshot);
    return value?.after?.available &&
      value.authorId &&
      (!message.author?.id || message.author.id === value.authorId)
      ? value
      : null;
  } catch {
    return null;
  }
}
export function recordMessageEvent(
  ctx,
  event,
  message,
  before = null,
  { bulk = false, now = Date.now() } = {},
) {
  if (!belongsToContext(ctx, message) || !['message.delete', 'message.edit'].includes(event))
    return;
  const validBefore =
    belongsToContext(ctx, before) &&
    before.id === message.id &&
    before.channelId === message.channelId
      ? before
      : null;
  const author = message.author || validBefore?.author;
  if (author?.bot) return;
  if (
    event === 'message.edit' &&
    validBefore &&
    !validBefore.partial &&
    validBefore.content === message.content
  ) {
    rememberMessage(ctx, message, now);
    return;
  }
  return ctx.store.transaction(() => {
    const enabled = operationSettings(ctx).logs.enabled,
      cached = enabled ? rememberedMessage(ctx, message, now) : null;
    const id = ctx.store.audit(event, '', {
      message: message.id,
      channel: message.channelId,
      user: author?.id || cached?.authorId || null,
      bulk,
    });
    if (enabled) {
      const current = snapshot(message, ctx.config),
        previous = snapshot(validBefore, ctx.config);
      const identity = author
        ? authorDetails(
            {
              ...message,
              author,
              member: message.member || validBefore?.member,
              createdTimestamp: message.createdTimestamp || validBefore?.createdTimestamp,
            },
            ctx.config,
          )
        : cached || authorDetails(message, ctx.config);
      ctx.store.db.prepare('INSERT INTO message_audit(audit_id,snapshot) VALUES(?,?)').run(
        id,
        JSON.stringify({
          authorId: identity.authorId,
          authorName: identity.authorName,
          sentAt: identity.sentAt,
          before:
            event === 'message.edit'
              ? previous.available
                ? previous
                : cached?.after || previous
              : null,
          after:
            event === 'message.delete' && !current.available ? cached?.after || current : current,
        }),
      );
    }
    if (event === 'message.delete' || !enabled)
      ctx.store.db
        .prepare('DELETE FROM recent_messages WHERE message_id=? AND channel_id=?')
        .run(message.id, message.channelId);
    else rememberInside(ctx, message, now);
    return id;
  });
}
