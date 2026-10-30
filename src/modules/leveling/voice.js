import { performance } from 'node:perf_hooks';
import { ChannelType } from 'discord.js';
import { operationSettings } from '../../config/features.js';
import { ignoredLevelChannels } from './index.js';
import { recordVoiceTime } from './profiles.js';

export function eligibleVoiceMembers(guild, settings) {
  const channels = new Map(),
    ignored = ignoredLevelChannels(settings);
  for (const state of guild.voiceStates.cache.values()) {
    const channel = state.channel || guild.channels.cache.get(state.channelId),
      member = state.member || guild.members.cache.get(state.id);
    if (
      !channel ||
      channel.type !== ChannelType.GuildVoice ||
      channel.id === guild.afkChannelId ||
      ignored.has(channel.id) ||
      ignored.has(channel.parentId) ||
      !member ||
      member.user.bot ||
      state.selfDeaf ||
      state.serverDeaf ||
      state.suppress ||
      (settings.voiceRequireUnmuted && (state.selfMute || state.serverMute))
    )
      continue;
    if (!channels.has(channel.id)) channels.set(channel.id, []);
    channels.get(channel.id).push(member.id);
  }
  return new Set(
    [...channels.values()].filter((members) => members.length >= settings.voiceMinMembers).flat(),
  );
}

export function syncVoiceXp(ctx, guild, now = performance.now()) {
  const settings = operationSettings(ctx).leveling;
  if (!settings.enabled || !settings.voiceEnabled || guild.id !== ctx.config.guildId) {
    ctx.levelingVoice = null;
    return;
  }
  const signature = JSON.stringify([
    settings.voiceXpPerMinute,
    settings.voiceMinMembers,
    settings.voiceRequireUnmuted,
    settings.ignoredChannelIds,
  ]);
  const previous = ctx.levelingVoice;
  const active = eligibleVoiceMembers(guild, settings);
  if (!previous || previous.signature !== signature || now < previous.at) {
    ctx.levelingVoice = { at: now, active, signature };
    return;
  }
  const elapsed = Math.max(0, Math.min(60, Math.floor((now - previous.at) / 1000)));
  if (elapsed && previous.active.size)
    ctx.store.transaction(() => {
      for (const user of previous.active)
        recordVoiceTime(ctx, user, elapsed, settings.voiceXpPerMinute);
    });
  const unchanged =
    active.size === previous.active.size && [...active].every((user) => previous.active.has(user));
  const at = unchanged && now - previous.at <= 60_000 ? previous.at + elapsed * 1000 : now;
  ctx.levelingVoice = { at, active, signature };
}

export function clearVoiceXpTracking(contexts) {
  for (const ctx of contexts.values()) ctx.levelingVoice = null;
}
