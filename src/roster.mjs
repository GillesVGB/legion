import { ChannelType, PermissionFlagsBits as P } from 'discord.js';
import { assertUser } from './errors.mjs';
import { embed, safeText } from './ui.mjs';
import { refreshMembers } from './members.mjs';

export function rosterGroups(config, members) {
  const ranks = config.roster.roleIds;
  const groups = new Map(ranks.map(id => [id, []]));
  for (const member of members.values()) {
    if (member.user.bot) continue;
    const highest = ranks.find(id => member.roles.cache.has(id));
    if (highest) groups.get(highest).push(member);
  }
  for (const group of groups.values()) group.sort((a, b) => a.displayName.localeCompare(b.displayName, 'nl') || a.id.localeCompare(b.id));
  return groups;
}

export function rosterCards(config, guild) {
  const groups = rosterGroups(config, guild.members.cache);
  const total = [...groups.values()].reduce((sum, group) => sum + group.length, 0);
  const fields = [];
  for (const [id, members] of groups) {
    const role = guild.roles.cache.get(id);
    assertUser(role, 'Een ingestelde gangrang ontbreekt. Controleer de ledenlijstconfiguratie.');
    const lines = members.map(member => `• <@${member.id}>`);
    const chunks = []; let value = '';
    for (const line of lines) {
      if (value.length + line.length + 1 > 1000) { chunks.push(value); value = ''; }
      value += `${value ? '\n' : ''}${line}`;
    }
    chunks.push(value || '*Geen leden*');
    chunks.forEach((part, i) => fields.push({ name: `${safeText(role.name)} · ${members.length}${i ? ' (vervolg)' : ''}`.slice(0, 250), value: part }));
  }
  const cards = [];
  let card = embed(config, 'Legion — Ledenlijst', `**${total} leden** verdeeld over de gangrangen.\nElk lid staat bij zijn hoogste rang. De lijst werkt automatisch bij.`);
  let size = 400, count = 0;
  for (const field of fields) {
    const length = field.name.length + field.value.length;
    if (size + length > 5500 || count >= 25) {
      cards.push(card); card = embed(config, 'Legion — Ledenlijst (vervolg)', 'Automatisch bijgewerkt.'); size = 200; count = 0;
    }
    card.addFields(field); size += length; count++;
  }
  cards.push(card);
  return cards.map(card => ({ embeds: [card], allowedMentions: { parse: [], repliedUser: false } }));
}

export async function publishRoster(ctx, guild, fetchMembers = false) {
  const { config, store } = ctx;
  if (!config.roster) return;
  const channel = await guild.channels.fetch(config.roster.channelId);
  assertUser(channel?.guildId === config.guildId && channel.type === ChannelType.GuildText, 'Het ledenlijstkanaal hoort niet bij deze guild.');
  assertUser(channel.permissionsFor(guild.members.me)?.has([P.ViewChannel, P.SendMessages, P.EmbedLinks, P.ReadMessageHistory]), 'De bot mist rechten voor de ledenlijst.');
  if (fetchMembers) await refreshMembers(guild);
  const payloads = rosterCards(config, guild);
  const oldIds = JSON.parse(store.setting('roster:messages') ?? '[]');
  const ids = [];
  for (let part = 0; part < payloads.length; part++) {
    const old = oldIds[part] ? await channel.messages.fetch(oldIds[part]).catch(error => { if (error.code === 10008) return null; throw error; }) : null;
    const message = old?.author.id === guild.members.me.id ? await old.edit(payloads[part]) : await channel.send(payloads[part]);
    ids.push(message.id);
    store.setSetting('roster:messages', JSON.stringify([...ids, ...oldIds.slice(part + 1)]));
  }
  for (const id of oldIds.slice(payloads.length)) {
    const old = await channel.messages.fetch(id).catch(error => { if (error.code === 10008) return null; throw error; });
    if (old?.author.id === guild.members.me.id) await old.delete();
  }
  store.setSetting('roster:messages', JSON.stringify(ids));
}
