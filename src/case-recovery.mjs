import { ChannelType, PermissionFlagsBits as P } from 'discord.js';
import { assertUser } from './errors.mjs';

const topicPattern = /^Legion dossier:([a-f0-9]{12}) \| (application|ticket) \| eigenaar:(\d{17,20})$/;
const closedTitles = new Set(['Sollicitatie geaccepteerd', 'Sollicitatie afgewezen', 'Sollicitatie gesloten', 'Ticket gesloten']);

// Alleen oorspronkelijke, nog open botkanalen mogen ontbrekende lokale dossiers herstellen.
export async function recoverCase(ctx, guild, channel, requestedId, suppliedMessage) {
  const existing = requestedId && ctx.store.caseById(requestedId);
  if (existing) return existing; // Een genomen beslissing wordt nooit ongedaan gemaakt.
  const match = topicPattern.exec(channel?.topic || '');
  if (!match || (requestedId && match[1] !== requestedId)) return null;
  const [, id, kind, owner] = match;
  if (ctx.store.caseById(id)) return ctx.store.caseById(id);
  if (channel.guildId !== ctx.config.guildId || guild.id !== ctx.config.guildId || channel.type !== ChannelType.GuildText) return null;
  if (kind === 'ticket' && !ctx.config.ticketsEnabled) return null;
  if (channel.parentId !== (kind === 'application' ? ctx.config.applicationCategoryId : ctx.config.ticketCategoryId)) return null;
  const overwrites = channel.permissionOverwrites.cache;
  if (!overwrites.get(guild.id)?.deny.has(P.ViewChannel) || !overwrites.get(owner)?.allow.has([P.ViewChannel, P.SendMessages]) ||
      !overwrites.get(guild.members.me.id)?.allow.has(P.ViewChannel)) return null;
  const expected = kind === 'application' ? `application:askaccept:${id}` : `ticket:askclose:${id}`;
  const original = message => message?.author.id === guild.members.me.id && (message.components || []).some(row =>
    (row.components || []).some(button => (button.customId ?? button.custom_id) === expected && !button.disabled));
  let intro = original(suppliedMessage) ? suppliedMessage : null;
  if (!intro) {
    let before;
    for (let page = 0; page < 10; page++) {
      const messages = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
      if ([...messages.values()].some(message => message.author.id === guild.members.me.id && message.embeds?.some(card => closedTitles.has(card.title)))) return null;
      intro = [...messages.values()].find(original);
      if (intro || messages.size < 100) break;
      before = messages.last().id;
    }
  }
  if (!intro) return null;
  return ctx.store.restoreCase({ id, kind, owner_id: owner, channel_id: channel.id, message_id: intro.id,
    created_at: intro.createdTimestamp ?? Date.now(), payload: kind === 'application' ? { template: true } : {} }, guild.members.me.id);
}

export async function recoverGuildCases(ctx, guild, channels) {
  for (const channel of channels.values()) {
    const match = topicPattern.exec(channel?.topic || '');
    if (!match || ctx.store.caseById(match[1])) continue;
    try { await recoverCase(ctx, guild, channel, match[1]); }
    catch (error) { console.error(`Guild ${guild.id}: dossierherstel wacht op herhaling (${error.code ?? error.name}).`); }
  }
}

export async function requireOpenCase(ctx, interaction, id) {
  let dossier = ctx.store.caseById(id);
  if (!dossier) {
    const channel = await interaction.guild.channels.fetch(interaction.channelId);
    dossier = await recoverCase(ctx, interaction.guild, channel, id, interaction.message);
  }
  assertUser(dossier, 'De dossiergegevens ontbreken. Controleer of de hele data-map is overgezet; dit kanaal kon niet veilig worden hersteld.');
  assertUser(dossier.channel_id === interaction.channelId, 'Deze knop hoort bij een ander dossierkanaal.');
  assertUser(dossier.status === 'open', 'Dit dossier is al afgehandeld.');
  return dossier;
}
