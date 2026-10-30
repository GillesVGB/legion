import { createHash } from 'node:crypto';
import { ChannelType } from 'discord.js';
import { operationSettings } from '../../config/features.js';
import { assertUser } from '../../common/errors.js';
import { embed } from '../../ui/messages.js';
import {
  levelProfile,
  levelProgress,
  levelRank,
  levelRanking,
  recordMessageXp,
} from './profiles.js';

export const ignoredLevelChannels = (settings) =>
  new Set(settings.ignoredChannelIds.split(/[\s,]+/).filter(Boolean));

export function awardMessageXp(ctx, message, now = Date.now()) {
  const settings = operationSettings(ctx).leveling;
  if (
    !settings.enabled ||
    !settings.messageEnabled ||
    message.guild?.id !== ctx.config.guildId ||
    !message.author?.id ||
    message.author.bot ||
    message.webhookId ||
    message.system ||
    message.partial ||
    message.channel?.type === ChannelType.PrivateThread
  )
    return null;
  const excluded = ignoredLevelChannels(settings);
  const channelIds = [
    message.channelId,
    message.channel?.parentId,
    message.guild.channels?.cache.get(message.channel?.parentId)?.parentId,
  ];
  const privateChannels = [
    ctx.config.logChannelId,
    ctx.config.botLogChannelId,
    ctx.config.warnLogChannelId,
    ctx.config.updateChannelId,
    ctx.config.applicationTranscriptChannelId,
    ctx.config.ticketTranscriptChannelId,
  ];
  if (
    channelIds.some((id) => id && (excluded.has(id) || privateChannels.includes(id))) ||
    ctx.store.caseByChannel(message.channelId) ||
    (message.channel?.parentId && ctx.store.caseByChannel(message.channel.parentId))
  )
    return null;
  const normalized = String(message.content || '')
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('nl-BE')
    .replace(/\s+/g, ' ');
  const words = normalized.replace(/https?:\/\/\S+|www\.\S+/gu, '').trim();
  if (words.length < settings.minMessageLength || !/[\p{L}\p{N}]/u.test(words)) return null;
  const hash = createHash('sha256').update(normalized).digest('hex');
  return recordMessageXp(ctx, message.author.id, hash, settings, now);
}

export const voiceDuration = (seconds) =>
  `${Math.floor(seconds / 3600)}u ${Math.floor((seconds % 3600) / 60)}m`;

export async function handleLevelCommand(ctx, interaction) {
  await interaction.deferReply();
  const settings = operationSettings(ctx).leveling;
  if (interaction.commandName === 'levels') {
    const entries = levelRanking(ctx, interaction.guild);
    return interaction.editReply({
      embeds: [
        embed(
          ctx.config,
          'Bakarov — Levelranglijst',
          (settings.enabled ? '' : 'XP verdienen staat momenteel uit.\n\n') +
            (entries
              .map(
                (item) =>
                  `**${item.rank}.** <@${item.user_id}> — level **${item.level}** · ${item.xp.toLocaleString('nl-BE')} XP`,
              )
              .join('\n') || 'Er is nog geen XP verdiend in deze server.'),
        ),
      ],
      allowedMentions: { parse: [] },
    });
  }
  const user = interaction.options.getUser('lid') || interaction.user;
  const member = await interaction.guild.members.fetch(user.id).catch(() => null);
  assertUser(member && !user.bot, 'Kies een echt lid van deze server.');
  const profile = levelProfile(ctx, user.id),
    progress = levelProgress(profile.total_xp),
    rank = levelRank(ctx, interaction.guild, user.id);
  const filled = Math.floor((progress.current / progress.required) * 10);
  return interaction.editReply({
    embeds: [
      embed(
        ctx.config,
        `Bakarov — Level ${progress.level}`,
        `**Lid:** <@${user.id}>\n**XP:** ${progress.xp.toLocaleString('nl-BE')}\n**Positie:** ${rank ? `#${rank}` : 'Nog niet gerangschikt'}\n\n` +
          `${'▰'.repeat(filled)}${'▱'.repeat(10 - filled)}\n**Volgend level:** ${progress.current}/${progress.required} XP · nog ${progress.remaining} XP\n\n` +
          `**Berichten:** ${profile.message_xp.toLocaleString('nl-BE')} XP uit ${profile.message_count} geldige berichten\n**Spraak:** ${profile.voice_xp.toLocaleString('nl-BE')} XP · ${voiceDuration(profile.voice_seconds)} actief\n\n` +
          (settings.enabled
            ? 'XP is per server gescheiden. Levels veranderen je gangrang en coins niet.'
            : 'XP verdienen staat momenteel uit; je voortgang blijft bewaard.'),
      ),
    ],
    allowedMentions: { parse: [] },
  });
}
