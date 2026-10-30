import { AttachmentBuilder, ChannelType, PermissionFlagsBits as P } from 'discord.js';
import { operationSettings } from '../../config/features.js';
import { embed } from '../../ui/messages.js';
import { renderLevelCard } from './cards.js';

const running = new WeakMap();
const supportedChannels = new Set([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildVoice,
  ChannelType.PublicThread,
  ChannelType.AnnouncementThread,
]);
const fail = (code) => Object.assign(new Error(code), { code });

function finish(ctx, notice, status, message = null, error = null) {
  ctx.store.db
    .prepare(
      `UPDATE level_up_notices SET status=?,message_id=?,last_error=?,next_attempt=0 WHERE id=?`,
    )
    .run(status, message, error, notice.id);
}

async function findSentMessage(channel, botId, notice) {
  const marker = `Bakarov • Levelmelding ${notice.id}`;
  let before;
  for (let page = 0; page < 10; page++) {
    const history = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    const found = history.find(
      (message) =>
        message.author.id === botId &&
        message.embeds?.some((card) => (card.footer || card.data?.footer)?.text === marker),
    );
    if (found) return found;
    if (history.size < 100) break;
    const last = history.last();
    if (last.createdTimestamp && last.createdTimestamp < notice.created_at) break;
    before = last.id;
  }
  return null;
}

async function deliver(ctx, guild, notice, now) {
  const settings = operationSettings(ctx).leveling;
  const id = notice.delivery_channel_id || settings.levelUpChannelId || notice.channel_id;
  if (!id) return finish(ctx, notice, 'skipped', null, 'NO_CHANNEL');
  const channel = await guild.channels.fetch(id);
  if (
    !channel ||
    channel.guildId !== guild.id ||
    !supportedChannels.has(channel.type) ||
    typeof channel.send !== 'function'
  )
    throw fail('LEVEL_CHANNEL_INVALID');
  const required = [
    P.ViewChannel,
    P.EmbedLinks,
    P.AttachFiles,
    P.ReadMessageHistory,
    channel.isThread?.() ? P.SendMessagesInThreads : P.SendMessages,
  ];
  if (!channel.permissionsFor(guild.members.me)?.has(required))
    throw fail('LEVEL_CHANNEL_PERMISSIONS');
  // Keep the attempted destination fixed if a dashboard change follows an interrupted send.
  if (!notice.delivery_channel_id)
    ctx.store.db
      .prepare('UPDATE level_up_notices SET delivery_channel_id=? WHERE id=?')
      .run(id, notice.id);
  if (notice.sending_at !== null) {
    const found = await findSentMessage(channel, guild.members.me.id, notice);
    if (found) return finish(ctx, notice, 'sent', found.id);
  }
  const member = await guild.members.fetch(notice.user_id).catch((error) => {
    if (error.code === 10007) return null;
    throw error;
  });
  if (!member || member.user.bot) return finish(ctx, notice, 'skipped', null, 'MEMBER_LEFT');
  const image = await renderLevelCard(member, { xp: notice.xp, levelUp: true });
  const current = operationSettings(ctx).leveling;
  if (!current.enabled || !current.levelUpMessages) return finish(ctx, notice, 'skipped');
  const filename = `level-up-${notice.id}.png`;
  ctx.store.db.prepare('UPDATE level_up_notices SET sending_at=? WHERE id=?').run(now, notice.id);
  const message = await channel.send({
    content: `<@${notice.user_id}>`,
    embeds: [
      embed(
        ctx.config,
        'Bakarov — Level omhoog!',
        `Je hebt **level ${notice.level}** bereikt. Goed bezig!`,
      )
        .setColor(0x28ba7b)
        .setThumbnail(null)
        .setImage(`attachment://${filename}`)
        .setFooter({ text: `Bakarov • Levelmelding ${notice.id}` }),
    ],
    files: [new AttachmentBuilder(image, { name: filename })],
    allowedMentions: { parse: [], users: [notice.user_id] },
    nonce: `lv:${notice.id}`,
    enforceNonce: true,
  });
  finish(ctx, notice, 'sent', message.id);
}

async function drain(ctx, guild, now) {
  if (guild.id !== ctx.config.guildId) return;
  const settings = operationSettings(ctx).leveling;
  if (!settings.enabled || !settings.levelUpMessages) {
    ctx.store.db
      .prepare("UPDATE level_up_notices SET status='skipped' WHERE status='pending'")
      .run();
    return;
  }
  const notices = ctx.store.db
    .prepare(
      `SELECT * FROM level_up_notices
    WHERE status='pending' AND next_attempt<=? ORDER BY created_at,id LIMIT 3`,
    )
    .all(now);
  for (const notice of notices) {
    try {
      await deliver(ctx, guild, notice, now);
    } catch (error) {
      const code = String(error.code || error.name || 'ERROR').slice(0, 80);
      const delay = Math.min(600_000, 15_000 * 2 ** Math.min(notice.attempts, 6));
      ctx.store.db
        .prepare(
          `UPDATE level_up_notices SET next_attempt=?,last_error=?,attempts=attempts+1 WHERE id=?`,
        )
        .run(now + delay, code, notice.id);
      // Report failures once per new error instead of filling the hosting console on every tick.
      if (notice.last_error !== code)
        console.error(`Guild ${guild.id}: levelmelding wacht op herhaling (${code}).`);
    }
  }
}

export function syncLevelNotifications(ctx, guild, now = Date.now()) {
  if (running.has(ctx)) return running.get(ctx);
  const task = drain(ctx, guild, now).finally(() => running.delete(ctx));
  running.set(ctx, task);
  return task;
}

export async function waitForLevelNotifications(contexts) {
  await Promise.allSettled([...contexts.values()].map((ctx) => running.get(ctx)));
}
