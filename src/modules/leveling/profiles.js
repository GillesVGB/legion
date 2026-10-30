import { createHash } from 'node:crypto';

export const MAX_XP = 1_000_000_000_000;

function queueLevelUp(ctx, user, previousXp, xp, settings, channel, now) {
  const previousLevel = levelProgress(previousXp).level,
    level = levelProgress(xp).level;
  if (!settings?.levelUpMessages || level <= previousLevel) return;
  const id = createHash('sha256')
    .update(`${ctx.config.guildId}:${user}:${level}`)
    .digest('hex')
    .slice(0, 20);
  ctx.store.db
    .prepare(
      `INSERT OR IGNORE INTO level_up_notices
    (id,user_id,level,previous_level,xp,channel_id,created_at) VALUES(?,?,?,?,?,?,?)`,
    )
    .run(id, user, level, previousLevel, xp, channel || null, now);
}

export function levelProgress(xp = 0) {
  const total = Math.max(0, Math.min(MAX_XP, Math.floor(Number(xp) || 0)));
  const level = Math.floor(Math.sqrt(total / 100));
  const start = 100 * level * level;
  const next = 100 * (level + 1) * (level + 1);
  return {
    level,
    xp: total,
    current: total - start,
    required: next - start,
    remaining: next - total,
  };
}

export function levelProfile(ctx, user) {
  return (
    ctx.store.db.prepare('SELECT * FROM member_levels WHERE user_id=?').get(user) || {
      user_id: user,
      total_xp: 0,
      message_xp: 0,
      voice_xp: 0,
      message_count: 0,
      voice_seconds: 0,
      voice_remainder: 0,
      last_message_at: 0,
      last_message_hash: '',
    }
  );
}

export function recordMessageXp(ctx, user, hash, settings, now, channel) {
  return ctx.store.transaction(() => {
    const previous = levelProfile(ctx, user);
    if (
      previous.message_count > 0 &&
      now - previous.last_message_at < settings.messageCooldownSeconds * 1000
    )
      return null;
    if (previous.last_message_hash === hash && now - previous.last_message_at < 600_000)
      return null;
    const gain = Math.min(settings.messageXp, MAX_XP - previous.total_xp);
    if (gain <= 0) return null;
    ctx.store.db
      .prepare(
        `INSERT INTO member_levels(user_id,total_xp,message_xp,message_count,last_message_at,last_message_hash)
      VALUES(?,?,?,1,?,?) ON CONFLICT(user_id) DO UPDATE SET
      total_xp=total_xp+excluded.total_xp,message_xp=message_xp+excluded.message_xp,
      message_count=message_count+1,last_message_at=excluded.last_message_at,last_message_hash=excluded.last_message_hash`,
      )
      .run(user, gain, gain, now, hash);
    queueLevelUp(ctx, user, previous.total_xp, previous.total_xp + gain, settings, channel, now);
    return levelProfile(ctx, user);
  });
}

// Voice ticks call this inside one transaction for the whole guild.
export function recordVoiceTime(ctx, user, seconds, rate, settings, channel, now = Date.now()) {
  const profile = levelProfile(ctx, user);
  const units = profile.voice_remainder + seconds * rate;
  const gain = Math.min(Math.floor(units / 60), MAX_XP - profile.total_xp);
  ctx.store.db
    .prepare(
      `INSERT INTO member_levels(user_id,total_xp,voice_xp,voice_seconds,voice_remainder)
    VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET
    total_xp=total_xp+excluded.total_xp,voice_xp=voice_xp+excluded.voice_xp,
    voice_seconds=voice_seconds+excluded.voice_seconds,voice_remainder=excluded.voice_remainder`,
    )
    .run(user, gain, gain, seconds, units % 60);
  queueLevelUp(ctx, user, profile.total_xp, profile.total_xp + gain, settings, channel, now);
}

export function levelRanking(ctx, guild, limit = 10) {
  const entries = [];
  for (const row of ctx.store.db
    .prepare(
      'SELECT user_id,total_xp,message_xp,voice_xp,message_count,voice_seconds FROM member_levels WHERE total_xp>0 ORDER BY total_xp DESC,user_id',
    )
    .iterate()) {
    const member = guild.members.cache.get(row.user_id);
    if (!member || member.user.bot) continue;
    entries.push({
      ...row,
      ...levelProgress(row.total_xp),
      name: member.displayName,
      rank: entries.length + 1,
    });
    if (entries.length >= limit) break;
  }
  return entries;
}

export function levelRank(ctx, guild, user) {
  let rank = 0;
  for (const row of ctx.store.db
    .prepare('SELECT user_id FROM member_levels WHERE total_xp>0 ORDER BY total_xp DESC,user_id')
    .iterate()) {
    const member = guild.members.cache.get(row.user_id);
    if (!member || member.user.bot) continue;
    rank++;
    if (row.user_id === user) return rank;
  }
  return null;
}
