import { ChannelType, PermissionFlagsBits as P, MessageFlags, ButtonStyle, ButtonBuilder, EmbedBuilder } from 'discord.js';
import { assertUser, UserError } from './errors.mjs';
import { embed, panel, caseMessages, applicationControls, row, button, safeText } from './ui.mjs';
import { archiveTranscript, saveLocalTranscript } from './transcripts.mjs';
import { caseChannelName } from './channel-names.mjs';
import { parseAge } from './application.mjs';
import { refreshRecruitment, requireApplicationsOpen } from './recruitment.mjs';
import { deliverAcceptance } from './admissions.mjs';

export const quiet = { parse: [], repliedUser: false };
export const isAdmin = interaction => interaction.memberPermissions?.has(P.Administrator) ?? false;
export const isStaff = (interaction, config) => isAdmin(interaction) || config.staffRoleIds.some(id =>
  interaction.member?.roles?.cache?.has(id) ?? interaction.member?.roles?.includes?.(id));
export function requireStaff(interaction, config) { assertUser(isStaff(interaction, config), 'Alleen de Legion-leiding mag deze actie uitvoeren.'); }
export function requireAdmin(interaction) { assertUser(isAdmin(interaction), 'Alleen een Discord-administrator mag de bot inrichten.'); }
export function requireTickets(config) { assertUser(config.ticketsEnabled, 'Tickets zijn alleen beschikbaar in de ticketguild van Legion.'); }

export function privateOverwrites(guild, config, owner) {
  const allow = [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.EmbedLinks, P.AttachFiles];
  const result = [{ id: guild.id, deny: [P.ViewChannel] },
    { id: guild.members.me.id, allow: [...allow, P.ManageChannels, P.ManageRoles] },
    ...config.staffRoleIds.map(id => ({ id, allow }))];
  if (owner) result.push({ id: owner, allow });
  return result;
}

async function guildChannel(guild, id, type, label) {
  assertUser(id, `${label} is nog niet ingesteld. Een administrator kan /inrichten gebruiken.`);
  const channel = await guild.channels.fetch(id).catch(() => null);
  assertUser(channel && channel.guildId === guild.id && channel.type === type, `${label} ontbreekt of hoort bij een andere guild. Controleer de configuratie.`);
  return channel;
}

export async function staffLogChannel(guild, config) {
  const channel = await guildChannel(guild, config.logChannelId, ChannelType.GuildText, 'Het privé logkanaal');
  assertUser(channel.permissionsFor(guild.members.me)?.has([P.ViewChannel, P.SendMessages, P.EmbedLinks]), 'De bot kan geen berichten met embeds in het logkanaal plaatsen.');
  for (const role of guild.roles.cache.values()) {
    if (config.staffRoleIds.includes(role.id) || role.permissions.has(P.Administrator) || role.tags?.botId === guild.members.me.id) continue;
    assertUser(!channel.permissionsFor(role)?.has(P.ViewChannel), 'Het logkanaal is zichtbaar voor een rol buiten de leiding. Maak het privé voordat je verdergaat.');
  }
  // Ook individuele overwrites mogen geen extra niet-staff leden toegang geven.
  for (const overwrite of channel.permissionOverwrites.cache.values()) {
    if (overwrite.type !== 1 || !overwrite.allow.has(P.ViewChannel) || overwrite.id === guild.members.me.id) continue;
    const member = await guild.members.fetch(overwrite.id).catch(() => null);
    assertUser(member && (member.permissions.has(P.Administrator) || config.staffRoleIds.some(id => member.roles.cache.has(id))), 'Een individuele kanaaloverride geeft een niet-staff lid toegang tot het logkanaal.');
  }
  return channel;
}

export async function warnLogChannel(guild, config) {
  if (!config.warnLogChannelId) return staffLogChannel(guild, config);
  const channel = await guildChannel(guild, config.warnLogChannelId, ChannelType.GuildText, 'Het gangwarnkanaal');
  assertUser(channel.permissionsFor(guild.members.me)?.has([P.ViewChannel, P.SendMessages, P.EmbedLinks]), 'De bot kan geen gangwarns in het ingestelde kanaal plaatsen.');
  return channel;
}

export async function writeWarnLog(ctx, guild, title, description) {
  try {
    const channel = await warnLogChannel(guild, ctx.config);
    await channel.send({ embeds: [embed(ctx.config, title, description)], allowedMentions: quiet });
    return true;
  } catch (error) {
    console.error(`Guild ${guild.id}: gangwarnbericht niet verstuurd (${error.code ?? error.name}).`);
    return false;
  }
}

async function postCaseMessages(channel, config, dossier, recruitment) {
  let last;
  for (const payload of caseMessages(config, dossier, recruitment)) last = await channel.send({ ...payload, allowedMentions: quiet });
  return last;
}

export async function writeLog(ctx, guild, title, description) {
  try {
    const channel = await staffLogChannel(guild, ctx.config);
    await channel.send({ embeds: [embed(ctx.config, title, description)], allowedMentions: quiet });
    return true;
  } catch (error) {
    // De volledige gebeurtenissen blijven ook lokaal in de SQLite-audit opgeslagen.
    console.error(`Guild ${guild.id}: logbericht niet verstuurd (${error.code ?? error.name}).`);
    return false;
  }
}

export async function publishPanel(ctx, guild, channelId, type = 'alles') {
  assertUser(type !== 'tickets' || ctx.config.ticketsEnabled, 'Tickets zijn uitgeschakeld in deze guild.');
  const channel = await guildChannel(guild, channelId, ChannelType.GuildText, 'Het paneelkanaal');
  assertUser(channel.permissionsFor(guild.members.me)?.has([P.ViewChannel, P.SendMessages, P.EmbedLinks, P.ReadMessageHistory]), 'De bot mist rechten om dit paneel te plaatsen.');
  const key = `panel:${type}:${channelId}`;
  const previous = ctx.store.setting(key);
  const message = previous ? await channel.messages.fetch(previous).catch(() => null) : null;
  const payload = { ...panel(ctx.config, type, ctx.recruitment), allowedMentions: quiet };
  const posted = message?.author.id === guild.members.me.id ? await message.edit(payload) : await channel.send(payload);
  ctx.store.setSetting(key, posted.id);
  return channel;
}

export async function configureGuild(ctx, interaction) {
  requireAdmin(interaction);
  const guild = interaction.guild;
  const staffRole = interaction.options.getRole('leiding', true);
  const memberRole = interaction.options.getRole('leden');
  assertUser(staffRole.id !== guild.id && !staffRole.managed, 'Kies een gewone leidingrol; @everyone en botrollen zijn niet toegestaan.');
  assertUser(!memberRole || (memberRole.id !== guild.id && !memberRole.managed && memberRole.id !== staffRole.id), 'Kies een aparte, gewone ledenrol.');
  if (memberRole) {
    assertUser(!memberRole.permissions.has(P.Administrator), 'Gebruik geen administratorrol als ledenrol voor sollicitanten.');
    assertUser(guild.members.me.permissions.has(P.ManageRoles) && guild.members.me.roles.highest.comparePositionTo(memberRole) > 0, 'Geef de bot Rollen beheren en plaats zijn rol boven de ledenrol.');
  }
  assertUser(guild.members.me.permissions.has([P.ManageChannels, P.ManageRoles]), 'De bot heeft Kanalen beheren en Rollen beheren nodig voor het inrichten.');
  const config = ctx.config;
  assertUser(!ctx.store.activeCases().length || (config.staffRoleIds.length === 1 && config.staffRoleIds[0] === staffRole.id), 'Er zijn open dossiers. Handel die eerst af voordat je de leidingrol verandert.');
  // Instellingen worden na elke succesvolle stap bewaard; opnieuw uitvoeren is veilig.
  const save = () => ctx.store.setSetting('guild-config', JSON.stringify({
    staffRoleIds: config.staffRoleIds, memberRoleId: config.memberRoleId,
    ticketCategoryId: config.ticketCategoryId, applicationCategoryId: config.applicationCategoryId, logChannelId: config.logChannelId
  }));
  config.staffRoleIds = [staffRole.id];
  if (memberRole) config.memberRoleId = memberRole.id;
  save();
  for (const [key, name] of [
    ...(config.ticketsEnabled ? [['ticketCategoryId', 'LEGION | TICKETS']] : []),
    ['applicationCategoryId', 'LEGION | SOLLICITATIES']
  ]) {
    const existing = config[key] ? await guild.channels.fetch(config[key]).catch(() => null) : null;
    assertUser(!existing || existing.type === ChannelType.GuildCategory, `${key} moet een categorie zijn.`);
    if (!existing) {
      const created = await guild.channels.create({ name, type: ChannelType.GuildCategory,
        permissionOverwrites: privateOverwrites(guild, config), reason: 'Legion-bot inrichten' });
      config[key] = created.id;
      save();
    }
  }
  if (!config.logChannelId || !await guild.channels.fetch(config.logChannelId).catch(() => null)) {
    const channel = await guild.channels.create({ name: 'legion-logs', type: ChannelType.GuildText,
      permissionOverwrites: privateOverwrites(guild, config), reason: 'Privé Legion-logkanaal' });
    config.logChannelId = channel.id;
    save();
  }
  await staffLogChannel(guild, config);
  if (config.panelChannelId) await publishPanel(ctx, guild, config.panelChannelId);
  ctx.store.audit('guild.configure', interaction.user.id, { staffRole: staffRole.id, memberRole: config.memberRoleId });
  await interaction.editReply({ content: `Legion is ingericht in deze guild.\nLeiding: <@&${staffRole.id}>\nSollicitaties: <#${config.applicationCategoryId}>${config.ticketsEnabled ? `\nTickets: <#${config.ticketCategoryId}>` : ''}\nLogs: <#${config.logChannelId}>\n${config.panelChannelId ? `Paneel: <#${config.panelChannelId}>` : 'Plaats het paneel met /setup paneel:alles in het gewenste kanaal.'}`, allowedMentions: quiet });
}

export async function createCase(ctx, interaction, kind, payload) {
  const { config, store } = ctx;
  if (kind === 'ticket') requireTickets(config);
  if (kind === 'application') {
    requireApplicationsOpen(ctx);
    if (!payload.template) assertUser(parseAge(payload.age) !== null && parseAge(payload.age) >= (config.recruitment?.minimumAge ?? 16), 'Solliciteren kan vanaf 16 jaar. Gebruik de huidige sollicitatietemplate via /solliciteren.');
  }
  await staffLogChannel(interaction.guild, config);
  const parent = await guildChannel(interaction.guild, kind === 'ticket' ? config.ticketCategoryId : config.applicationCategoryId, ChannelType.GuildCategory, 'De privécategorie');
  assertUser(parent.permissionsFor(interaction.guild.members.me)?.has([P.ViewChannel, P.ManageChannels, P.ManageRoles, P.SendMessages, P.EmbedLinks]), 'De bot mist rechten in de privécategorie.');
  const previous = store.activeCases().find(item => item.kind === kind && item.owner_id === interaction.user.id);
  if (previous?.status === 'open' && previous.channel_id) {
    const previousChannel = await interaction.guild.channels.fetch(previous.channel_id).catch(error => {
      if (error.code === 10003) return null; // Alleen "Unknown Channel" telt als verwijderd.
      throw error;
    });
    if (!previousChannel) store.closeCase(previous.id, 'failed', interaction.guild.members.me.id);
  }
  const dossier = store.reserveCase(kind, interaction.user.id, payload);
  let channel;
  try {
    channel = await interaction.guild.channels.create({ name: caseChannelName(kind, interaction.user),
      type: ChannelType.GuildText, parent: parent.id,
      topic: `Legion dossier:${dossier.id} | ${kind} | eigenaar:${interaction.user.id}`,
      permissionOverwrites: privateOverwrites(interaction.guild, config, interaction.user.id), reason: 'Legion privé dossier' });
    store.bindCase(dossier.id, channel.id);
    const message = await postCaseMessages(channel, config, dossier, ctx.recruitment);
    store.openCase(dossier.id, message.id);
    await writeLog(ctx, interaction.guild, kind === 'ticket' ? 'Ticket geopend' : 'Sollicitatie ontvangen', `<@${interaction.user.id}> • <#${channel.id}> • dossier \`${dossier.id}\``);
    await interaction.editReply({ content: `Je ${kind === 'ticket' ? 'ticket' : 'sollicitatie'} is aangemaakt: <#${channel.id}>.`, allowedMentions: quiet });
  } catch (error) {
    // Na een geslaagde creatie blijft het dossier geldig als alleen de reactie mislukt.
    if (store.caseById(dossier.id)?.status === 'open') throw error;
    if (channel) {
      const deleted = await channel.delete('Onvolledig Legion-dossier opruimen').then(() => true).catch(() => false);
      if (!deleted) throw new UserError(`Het dossier is deels aangemaakt: <#${channel.id}>. Vraag de leiding om dit te controleren; na herstart probeert de bot het te herstellen.`);
    }
    store.closeCase(dossier.id, 'failed', interaction.user.id);
    throw error;
  }
}

export async function requestCaseDecision(ctx, interaction, id, decision) {
  const dossier = ctx.store.caseById(id);
  assertUser(dossier && dossier.channel_id === interaction.channelId && dossier.status === 'open', 'Dit dossier is niet meer open of deze knop staat in het verkeerde kanaal.');
  const ticket = dossier.kind === 'ticket';
  if (ticket) {
    requireTickets(ctx.config);
    assertUser(decision === 'close', 'Ongeldige ticketactie.');
    assertUser(dossier.owner_id === interaction.user.id || isStaff(interaction, ctx.config), 'Alleen de aanvrager of leiding mag dit ticket sluiten.');
  } else {
    requireStaff(interaction, ctx.config);
    assertUser(['accept', 'reject', 'close'].includes(decision), 'Ongeldige sollicitatieactie.');
  }
  const label = decision === 'close' ? ticket ? 'Ticket sluiten' : 'Sollicitatie sluiten' : decision === 'accept' ? 'Sollicitant aannemen' : 'Sollicitant afwijzen';
  await interaction.reply({ content: `${label}? De bot maakt het transcript en verwijdert daarna dit kanaal.${decision === 'accept' && dossier.payload.template ? '\nControleer de antwoorden en de minimumleeftijd van 16 jaar voordat je bevestigt.' : ''}${decision === 'accept' && ctx.config.memberRoleId ? '\nDe ingestelde ledenrol wordt toegekend.' : ''}`,
    flags: MessageFlags.Ephemeral, components: [row(
      button(`case:confirm:${id}:${decision}:${interaction.user.id}`, 'Bevestigen', decision === 'accept' ? ButtonStyle.Success : ButtonStyle.Danger),
      button(`case:cancel:${id}:${interaction.user.id}`, 'Annuleren')
    )], allowedMentions: quiet });
}

export async function startInterview(ctx, interaction, id) {
  requireStaff(interaction, ctx.config);
  const dossier = ctx.store.caseById(id);
  assertUser(dossier?.kind === 'application' && dossier.status === 'open' && dossier.channel_id === interaction.channelId, 'Dit is geen open sollicitatie in dit kanaal.');
  const guild = interaction.guild;
  const member = await guild.members.fetch(dossier.owner_id).catch(() => null);
  assertUser(member, 'De sollicitant is niet meer in deze guild.');
  let voice = ctx.store.interview(id);
  let channel = voice ? await guild.channels.fetch(voice.channel_id).catch(error => { if (error.code === 10003) return null; throw error; }) : null;
  if (!channel) {
    const channels = await guild.channels.fetch();
    channel = channels.find(item => item?.type === ChannelType.GuildVoice &&
      (item.name === `gesprek-${id}` || (item.name === caseChannelName('interview', member.user) && item.permissionOverwrites.cache.has(member.id))));
    if (!channel) {
      const allow = [P.ViewChannel, P.Connect, P.Speak, P.Stream, P.UseVAD];
      channel = await guild.channels.create({ name: caseChannelName('interview', member.user), type: ChannelType.GuildVoice,
        parent: ctx.config.applicationCategoryId,
        permissionOverwrites: [{ id: guild.id, deny: [P.ViewChannel, P.Connect] },
          { id: guild.members.me.id, allow: [...allow, P.ManageChannels, P.ManageRoles] },
          ...ctx.config.staffRoleIds.map(role => ({ id: role, allow })), { id: dossier.owner_id, allow }],
        reason: `Legion sollicitatiegesprek ${id}` });
    }
    assertUser(channel.guildId === guild.id && channel.type === ChannelType.GuildVoice, 'Het gesprekskanaal hoort niet bij deze guild.');
    ctx.store.bindInterview(id, channel.id, interaction.user.id);
    await interaction.channel.send({ content: `<@${dossier.owner_id}>`,
      embeds: [embed(ctx.config, 'Legion — Sollicitatiegesprek', `De leiding wil een gesprek met je starten.\n\n**Spraakkanaal:** <#${channel.id}>\n**Gestart door:** <@${interaction.user.id}>\n\nAlleen jij en de leiding hebben toegang. Jullie kunnen ook hier verder praten.`).setColor(0xF59E0B)],
      components: [row(new ButtonBuilder().setLabel('Gesprek openen').setStyle(ButtonStyle.Link).setURL(`https://discord.com/channels/${guild.id}/${channel.id}`))],
      allowedMentions: { parse: [], users: [dossier.owner_id] } });
  }
  await interaction.editReply({ content: `Het privé gesprekskanaal staat klaar: <#${channel.id}>.`, allowedMentions: quiet });
}

export async function cleanupInterviews(ctx, guild) {
  for (const interview of ctx.store.staleInterviews()) {
    try {
      const channel = await guild.channels.fetch(interview.channel_id).catch(error => { if (error.code === 10003) return null; throw error; });
      if (channel) {
        const dossier = ctx.store.caseById(interview.case_id);
        const owned = channel.name === `gesprek-${interview.case_id}` ||
          (channel.name.startsWith('gesprek-') && channel.parentId === ctx.config.applicationCategoryId &&
            channel.permissionOverwrites.cache.has(dossier.owner_id) && channel.permissionOverwrites.cache.has(guild.members.me.id));
        assertUser(channel.guildId === guild.id && channel.type === ChannelType.GuildVoice && owned, 'Onverwacht gesprekskanaal; opruimen gestopt.');
        await channel.delete('Legion sollicitatie afgehandeld');
      }
      ctx.store.endInterview(interview.case_id);
    } catch (error) { console.error(`Guild ${guild.id}: gesprek opruimen wacht op herhaling (${error.code ?? error.name}).`); }
  }
}

export async function decideCase(ctx, interaction, id, decision) {
  const { config, store } = ctx;
  const dossier = store.caseById(id);
  assertUser(dossier && dossier.channel_id === interaction.channelId && dossier.status === 'open', 'Dit dossier is al afgehandeld of hoort bij een ander kanaal.');
  if (dossier.kind === 'ticket') {
    requireTickets(config);
    assertUser(decision === 'close' && (dossier.owner_id === interaction.user.id || isStaff(interaction, config)), 'Je mag dit ticket niet sluiten.');
  } else {
    requireStaff(interaction, config);
    assertUser(['accept', 'reject', 'close'].includes(decision), 'Ongeldige sollicitatieactie.');
  }
  await staffLogChannel(interaction.guild, config);
  if (decision === 'accept' && config.memberRoleId) {
    const role = await interaction.guild.roles.fetch(config.memberRoleId);
    const member = await interaction.guild.members.fetch(dossier.owner_id).catch(() => null);
    assertUser(member, 'Deze sollicitant is niet meer in de guild. Je kunt de sollicitatie afwijzen.');
    assertUser(role && role.id !== interaction.guildId && !role.managed && !role.permissions.has(P.Administrator), 'De ingestelde ledenrol is niet geschikt voor automatische toekenning.');
    assertUser(interaction.guild.members.me.permissions.has(P.ManageRoles) && interaction.guild.members.me.roles.highest.comparePositionTo(role) > 0, 'De bot kan de ledenrol niet geven. Plaats zijn rol boven de ledenrol en geef Rollen beheren.');
    if (config.recruitment && !member.roles.cache.has(config.memberRoleId)) {
      await refreshRecruitment(ctx, interaction.guild);
      requireApplicationsOpen(ctx);
    }
    if (Object.hasOwn(dossier.payload, 'age')) assertUser(parseAge(dossier.payload.age) !== null && parseAge(dossier.payload.age) >= (config.recruitment?.minimumAge ?? 16), 'Deze sollicitant voldoet niet aan de minimale leeftijd.');
    await member.roles.add(role, `Legion sollicitatie ${dossier.id} geaccepteerd`);
  }
  const status = decision === 'close' ? 'closed' : decision === 'accept' ? 'accepted' : 'rejected';
  // Sluiten faalt als de bot geen kanaalrechten heeft; het dossier blijft dan open.
  await interaction.channel.permissionOverwrites.edit(dossier.owner_id, { SendMessages: false, AddReactions: false,
    SendMessagesInThreads: false, CreatePublicThreads: false, CreatePrivateThreads: false });
  const finished = store.closeCase(id, status, interaction.user.id);
  const notice = decision === 'accept' ? await deliverAcceptance(ctx, interaction.client, id) : null;
  const dmStatus = notice ? ['sent','joined'].includes(notice.status) ? '\nDe sollicitant heeft het aannamebericht in DM ontvangen.' : '\nDe DM is nog niet bezorgd. Controleer de uitnodigingsstatus in het dashboard.' : '';
  await cleanupInterviews(ctx, interaction.guild);
  const summary = decision === 'close' ? dossier.kind === 'ticket' ? 'Ticket gesloten' : 'Sollicitatie gesloten' : decision === 'accept' ? 'Sollicitatie geaccepteerd' : 'Sollicitatie afgewezen';
  const original = await interaction.channel.messages.fetch(dossier.message_id).catch(() => null);
  const finalColor = decision === 'accept' ? 0x22C55E : 0xEF4444;
  if (original) await original.edit({ embeds: original.embeds.map(card => EmbedBuilder.from(card).setColor(finalColor)), components: [] }).catch(() => {});
  await interaction.channel.send({ embeds: [embed(config, summary, `Afgehandeld door <@${interaction.user.id}>. Het transcript wordt opgeslagen. Daarna wordt dit kanaal automatisch verwijderd.`).setColor(finalColor)], allowedMentions: quiet }).catch(() => {});
  const logged = await writeLog(ctx, interaction.guild, summary, `Dossier \`${id}\` • <@${finished.owner_id}> • door <@${interaction.user.id}> • <#${interaction.channelId}>`);
  const hasTranscript = Boolean(store.transcript(id));
  if (hasTranscript) await archiveTranscript(ctx, interaction.client, id, staffLogChannel);
  const removed = await removeClosedCase(ctx, interaction.client, finished, async () => {
    await interaction.editReply({ content: `${summary}. Het transcript is opgeslagen en het kanaal wordt verwijderd.${logged ? '' : ' De gebeurtenis is lokaal opgeslagen.'}${dmStatus}`, components: [], allowedMentions: quiet }).catch(() => {});
  });
  if (!removed) await interaction.editReply({ content: `${summary}. Het transcript en verwijderen worden automatisch opnieuw geprobeerd.`, components: [], allowedMentions: quiet });
}

export async function removeClosedCase(ctx, client, dossier, beforeDelete) {
  assertUser(dossier && ['closed', 'accepted', 'rejected'].includes(dossier.status), 'Alleen een gesloten dossier mag worden verwijderd.');
  try {
    const delivery = ctx.store.transcript(dossier.id);
    if (delivery && !['done', 'unavailable'].includes(delivery.state)) { ctx.store.retryCaseCleanup(dossier.id); return false; }
    const guild = client.guilds.cache.get(ctx.config.guildId);
    const channel = await guild.channels.fetch(dossier.channel_id).catch(error => { if (error.code === 10003) return null; throw error; });
    if (channel) {
      if (delivery?.state === 'unavailable') { ctx.store.retryCaseCleanup(dossier.id); return false; }
      assertUser(channel.guildId === ctx.config.guildId && channel.type === ChannelType.GuildText && channel.topic?.includes(`dossier:${dossier.id} |`), 'Het kanaal hoort niet bij dit Legion-dossier.');
      if (!delivery) await saveLocalTranscript(ctx, client, dossier, channel);
      if (beforeDelete) await beforeDelete();
      await channel.delete(`Legion dossier ${dossier.id}: transcript opgeslagen`);
    }
    ctx.store.finishCaseCleanup(dossier.id);
    return true;
  } catch (error) {
    ctx.store.retryCaseCleanup(dossier.id);
    console.error(`Guild ${ctx.config.guildId}: gesloten dossier ${dossier.id} verwijderen wacht op herhaling (${error.code ?? error.name}).`);
    return false;
  }
}

export async function cleanupClosedCases(ctx, client) {
  for (const dossier of ctx.store.pendingCaseCleanup()) await removeClosedCase(ctx, client, dossier);
}

export async function reconcileCases(ctx, guild) {
  const channels = await guild.channels.fetch();
  for (const dossier of ctx.store.activeCases()) {
    const channel = dossier.channel_id ? channels.get(dossier.channel_id) : channels.find(x => x?.topic?.includes(`dossier:${dossier.id} |`));
    if (!channel) {
      ctx.store.closeCase(dossier.id, 'failed', guild.members.me.id);
      continue;
    }
    if (channel.guildId !== guild.id || channel.type !== ChannelType.GuildText || !channel.topic?.includes(`dossier:${dossier.id} |`)) continue;
    const owner = await guild.members.fetch(dossier.owner_id).catch(() => null);
    if (owner) {
      const name = caseChannelName(dossier.kind, owner.user);
      if (channel.name !== name) await channel.setName(name, 'Legion ticketnaam met gebruikersnaam');
      const interview = ctx.store.interview(dossier.id);
      const voice = interview ? channels.get(interview.channel_id) : null;
      if (voice?.type === ChannelType.GuildVoice && voice.guildId === guild.id && voice.name !== caseChannelName('interview', owner.user)) {
        await voice.setName(caseChannelName('interview', owner.user), 'Legion gespreksnaam met gebruikersnaam');
      }
    }
    if (dossier.status === 'creating') {
      try {
        ctx.store.bindCase(dossier.id, channel.id);
        const message = await postCaseMessages(channel, ctx.config, dossier, ctx.recruitment);
        ctx.store.openCase(dossier.id, message.id);
      } catch (error) { console.error(`Guild ${guild.id}: dossier ${dossier.id} wacht op herstel (${error.code ?? error.name}).`); }
    } else {
      const original = await channel.messages.fetch(dossier.message_id).catch(() => null);
      if (original?.author.id === guild.members.me.id) {
        await original.edit({ embeds: original.embeds.map(card => EmbedBuilder.from(card).setColor(ctx.recruitment?.color ?? 0x22C55E)),
          ...(dossier.kind === 'application' ? { components: [applicationControls(dossier)] } : {}) });
      }
    }
  }
  await cleanupInterviews(ctx, guild);
}

export function warningMessage(config, store, user) {
  const warnings = store.warnings(user).slice(0, 15);
  const card = embed(config, 'Legion | Gangwarns', `Lid: <@${user}>\nActieve warns: **${store.warnCount(user)}**\n\n${warnings.length ? 'Hieronder de meest recente 15 warns. Ingetrokken warns blijven in de historie.' : 'Dit lid heeft geen gangwarns.'}`);
  // Embed-maximaal 6000 tekens: toon compacte redenen, volledige tekst staat in audit/log.
  for (const warning of warnings) card.addFields({ name: `${warning.removed_at ? 'Ingetrokken' : 'Actief'} • ${warning.id}`,
    value: `${safeText(warning.reason).slice(0, 100)}\nDoor <@${warning.actor_id}> • <t:${Math.floor(warning.created_at / 1000)}:d>${warning.removed_at ? `\nIngetrokken door <@${warning.removed_by}>: ${safeText(warning.removed_reason).slice(0, 40)}` : ''}` });
  return card;
}
