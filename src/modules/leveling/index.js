import { createHash } from 'node:crypto';
import { AttachmentBuilder } from 'discord.js';
import { renderLevelCard } from './cards.js';
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
    message.partial
  )
    return null;
  const excluded = ignoredLevelChannels(settings);
  const channelIds = [
    message.channelId,
    message.channel?.parentId,
    message.guild.channels?.cache.get(message.channel?.parentId)?.parentId,
  ];
  if (channelIds.some((id) => id && excluded.has(id))) return null;
  const normalized = String(message.content || '')
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('nl-BE')
    .replace(/\s+/g, ' ');
  const words = normalized.replace(/https?:\/\/\S+|www\.\S+/gu, '').trim();
  if (words.length < settings.minMessageLength || !/[\p{L}\p{N}]/u.test(words)) return null;
  const hash = createHash('sha256').update(normalized).digest('hex');
  return recordMessageXp(ctx, message.author.id, hash, settings, now, message.channelId);
}

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
  const image = await renderLevelCard(member, { xp: profile.total_xp, rank });
  const filename = `level-${user.id}.png`;
  return interaction.editReply({
    files: [
      new AttachmentBuilder(image, { name: filename }).setDescription(
        `${member.displayName}: level ${progress.level}, ${progress.xp} XP. Nog ${progress.remaining} XP tot level ${progress.level + 1}.`,
      ),
    ],
    allowedMentions: { parse: [] },
  });
}
