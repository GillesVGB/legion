import { Client, Events, GatewayIntentBits, Partials, MessageFlags, ButtonBuilder, ButtonStyle } from 'discord.js';
import { randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { loadConfig } from './config.mjs';
import { Store } from './store.mjs';
import { Locks } from './locks.mjs';
import { assertUser, UserError } from './errors.mjs';
import { embed, safeText, applicationModal, applicationProgress, ticketModal, blackjackMessage, row } from './ui.mjs';
import { applicationSteps } from './application.mjs';
import { archiveTranscript } from './transcripts.mjs';
import { startTranscriptViewer } from './viewer-server.mjs';
import { Dashboard } from './dashboard.mjs';
import { loadDashboardSettings } from './dashboard-settings.mjs';
import { deliverAcceptance, expireAcceptanceInvites, admissionJoined, revokeAcceptances } from './admissions.mjs';
import { countRecruitment, refreshRecruitment, requireApplicationsOpen } from './recruitment.mjs';
import { publishRoster } from './roster.mjs';
import { fishCatch } from './fishing.mjs';
import { missionMessage, handleMissionButton } from './missions.mjs';
import { showApplicationStatus } from './application-status.mjs';
import { handlePlanningCommand,handlePlanningReaction,clearPlanningReactions,syncActivities } from './activities.mjs';
import { handlePromotionCommand,handlePromotionButton,syncPromotions } from './promotions.mjs';
import { syncCommands } from './command-sync.mjs';
import { quiet, isStaff, requireStaff, requireAdmin, requireTickets, configureGuild, publishPanel,
  createCase, requestCaseDecision, decideCase, startInterview, cleanupInterviews, cleanupClosedCases, warningMessage, staffLogChannel, warnLogChannel, writeWarnLog, reconcileCases } from './service.mjs';

const base = loadConfig();
console.log(`Legion versie ${JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version}: dashboard ${base.dashboardPublicURL ? 'via hostingadres' : 'via tunnel'}.`);
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMessageReactions], partials:[Partials.Message,Partials.Channel,Partials.Reaction,Partials.User], allowedMentions: quiet });
const locks = new Locks();
const contexts = new Map();
const cooldowns = new Map();
const gameCommands = new Set(['saldo', 'daily', 'leaderboard', 'blackjack', 'coinflip', 'dobbel', '8ball', 'steenpapier', 'fish', 'missies']);
const privateReply = { flags: MessageFlags.Ephemeral, allowedMentions: quiet };
let shuttingDown = false;
let stopViewer;

for (const guildConfig of base.guilds) {
  const config = { ...base, ...guildConfig };
  const store = new Store(config);
  const saved = store.setting('guild-config');
  if (saved) {
    const settings = JSON.parse(saved);
    for (const key of ['staffRoleIds', 'memberRoleId', 'ticketCategoryId', 'applicationCategoryId', 'logChannelId']) {
      // Niet-lege waarden in guilds.json zijn expliciete configuratie en hebben voorrang.
      if (Array.isArray(config[key]) ? !config[key].length : !config[key]) config[key] = settings[key] ?? config[key];
    }
  }
  const ctx = { config, store, ready: false };
  loadDashboardSettings(ctx);
  contexts.set(config.guildId, ctx);
}
const dashboard = new Dashboard({ client, contexts, locks });

function requireGames(ctx, interaction) {
  const { config } = ctx;
  assertUser(!config.gameChannelId || interaction.channelId === config.gameChannelId, `Gebruik deze functie in <#${config.gameChannelId}>.`);
  assertUser(!config.gamesMembersOnly || interaction.member?.roles?.cache?.has(config.memberRoleId) || isStaff(interaction, config), 'Deze games zijn alleen voor Legion-leden.');
}
function cooldown(interaction) {
  const now = Date.now();
  const key = `${interaction.guildId}:${interaction.user.id}`;
  assertUser(now >= (cooldowns.get(key) ?? 0), 'Wacht even: je kunt elke 3 seconden een nieuwe gameactie starten.');
  cooldowns.set(key, now + 3000);
}

async function info(ctx, interaction, name = 'info') {
  const { config } = ctx;
  const c = config.content;
  const text = name === 'regels' ? c.rules.map((value, i) => `**${i + 1}.** ${value}`).join('\n\n') : name === 'rangen' ? c.ranks.map((value, i) => `${i + 1}. ${value}`).join('\n') :
    `${c.tagline}\n\n${config.ticketsEnabled ? c.information : c.information.replace('en /ticket openen om contact op te nemen met de leiding', 'en neem contact op met de leiding voor hulp')}`;
  await interaction.reply({ ...privateReply, embeds: [embed(config, `${c.gangName} | ${name === 'regels' ? 'Regels' : name === 'rangen' ? 'Rangen' : 'Informatie'}`, text)] });
}

async function handleWarn(ctx, interaction) {
  const { config, store } = ctx;
  if (interaction.commandName === 'mijnwarns') {
    await interaction.reply({ ...privateReply, embeds: [warningMessage(config, store, interaction.user.id)] });
    return;
  }
  requireStaff(interaction, config);
  const subcommand = interaction.options.getSubcommand();
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (subcommand === 'bekijken') {
    const user = interaction.options.getUser('lid', true);
    await interaction.editReply({ embeds: [warningMessage(config, store, user.id)], allowedMentions: quiet });
    return;
  }
  await warnLogChannel(interaction.guild, config);
  const reason = interaction.options.getString('reden', true).trim();
  assertUser(reason.length > 0, 'Vul een reden in.');
  if (subcommand === 'geven') {
    const user = interaction.options.getUser('lid', true);
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    assertUser(member && !user.bot, 'Kies een echt lid dat in deze guild zit.');
    assertUser(user.id !== interaction.user.id, 'Je kunt jezelf geen gangwarn geven.');
    assertUser(!config.memberRoleId || member.roles.cache.has(config.memberRoleId), 'Dit lid heeft geen Legion-ledenrol.');
    // Een gewone leidingrol kan geen administrator of hoger/even hoog stafflid waarschuwen.
    if (!interaction.memberPermissions.has('Administrator')) {
      const actor = await interaction.guild.members.fetch(interaction.user.id);
      assertUser(!member.permissions.has('Administrator') && actor.roles.highest.comparePositionTo(member.roles.highest) > 0, 'Je kunt geen administrator of lid met een gelijke/hogere rang waarschuwen.');
    }
    const { id, count } = store.addWarn(user.id, interaction.user.id, reason);
    const threshold = count >= config.warnThreshold ? `\n⚠️ **Drempel bereikt: ${count}/${config.warnThreshold} actieve warns. De leiding moet dit beoordelen.**` : '';
    const logged = await writeWarnLog(ctx, interaction.guild, 'Legion | Gangwarn gegeven', `Lid: <@${user.id}>\nDoor: <@${interaction.user.id}>\nID: \`${id}\`\nReden: ${safeText(reason)}\nActieve warns: **${count}**${threshold}`);
    const dm = await user.send({ embeds: [embed(config, 'Legion | Gangwarn', `Guild: **${safeText(interaction.guild.name)}**\nReden: ${safeText(reason)}\nActieve warns: **${count}**\nID: \`${id}\`\nNeem contact op met de leiding als je hierover vragen hebt.`)], allowedMentions: quiet }).then(() => true).catch(() => false);
    await interaction.editReply({ content: `Gangwarn \`${id}\` opgeslagen voor <@${user.id}>. Actieve warns: **${count}**.${threshold}${dm ? '' : '\nDM niet afgeleverd; het lid kan /mijnwarns gebruiken.'}${logged ? '' : '\nDiscord-log mislukt; de gebeurtenis is lokaal opgeslagen.'}`, allowedMentions: quiet });
  } else {
    const id = interaction.options.getString('id', true).trim().toLowerCase();
    const removed = store.removeWarn(id, interaction.user.id, reason);
    const logged = await writeWarnLog(ctx, interaction.guild, 'Gangwarn ingetrokken', `ID: \`${id}\` • <@${removed.user_id}>\nDoor: <@${interaction.user.id}>\nReden: ${safeText(reason)}`);
    await interaction.editReply({ content: `Gangwarn \`${id}\` ingetrokken. De historie blijft bewaard.${logged ? '' : '\nDiscord-log mislukt; de gebeurtenis is lokaal opgeslagen.'}`, allowedMentions: quiet });
  }
}

async function games(ctx, interaction) {
  const { config, store } = ctx;
  requireGames(ctx, interaction);
  const user = interaction.user.id;
  const name = interaction.commandName;
  const coins = config.content.coinName;
  if (name === 'missies') return interaction.reply(missionMessage(ctx,user));
  if (name === 'saldo') return interaction.reply({ allowedMentions: quiet, content: `<@${user}> heeft **${store.wallet(user).balance} ${coins}**. Dit zijn alleen fictieve Discord-punten.` });
  if (name === 'daily') {
    const result = store.daily(user);
    return interaction.reply({ allowedMentions: quiet, content: result.available ? `<@${user}> ontvangt **${config.dailyCoins} ${coins}**. Saldo: **${result.balance}**.` : `<@${user}> kan weer claimen <t:${Math.floor(result.next / 1000)}:R>.` });
  }
  if (name === 'leaderboard') {
    const top = store.leaderboard();
    return interaction.reply({ allowedMentions: quiet, embeds: [embed(config, '🏆 Legion | Leaderboard', top.length ? top.map((entry, i) => `**${i + 1}.** <@${entry.user_id}> — **${entry.balance}** ${coins}`).join('\n') : 'Nog geen spelers. Begin met /daily.')] });
  }
  cooldown(interaction);
  if (name === 'fish') {
    await interaction.deferReply();
    const { caught, change, balance } = store.fish(user, randomInt(100));
    const earnings = change > 0 ? `Je verdient **${change} ${coins}**!` : caught.coins < 0 ? `Je verliest **${-change} ${coins}**.${change !== caught.coins ? ' Je saldo kan niet onder nul komen.' : ''}` : 'Je verdient deze keer geen coins.';
    return interaction.editReply({ embeds: [embed(config, `${caught.icon} Legion | ${caught.title}`, `<@${user}> gaat vissen...\n\n${caught.text}\n\n**Zeldzaamheid:** ${caught.rarity}\n${earnings}\n**Nieuw saldo:** ${balance} ${coins}`).setColor({ good: 0x22C55E, bad: 0xEF4444, neutral: 0x5865F2 }[caught.kind])], allowedMentions: quiet });
  }
  if (name === 'blackjack') {
    await interaction.deferReply();
    const bet = interaction.options.getInteger('inzet');
    const game = bet === null ? store.activeGame(user) : store.startGame(user, bet);
    assertUser(game, 'Start een nieuw spel met /blackjack inzet:100.');
    const current = game.status === 'active' && Date.now() >= game.expires ? store.playGame(game.id, user, game.revision, 'timeout') : game;
    const message = await interaction.editReply({ ...blackjackMessage(config, store, current), allowedMentions: quiet });
    store.bindGame(current.id, interaction.channelId, message.id);
    return;
  }
  if (name === 'coinflip') {
    const bet = interaction.options.getInteger('inzet', true);
    const guess = interaction.options.getString('keuze', true);
    // Geen mutatie voordat Discord het antwoord heeft bevestigd.
    await interaction.deferReply();
    const result = store.coinflip(user, bet, guess, randomInt(2) === 0 ? 'kop' : 'munt');
    return interaction.editReply({ embeds: [embed(config, '🪙 Legion | Coinflip', `<@${user}> koos **${guess}**. De munt landt op **${result.coin}**.\n${result.won ? `Je wint **${bet}** coins!` : `Je verliest **${bet}** coins.`}\nSaldo: **${result.balance} ${coins}**.`)], allowedMentions: quiet });
  }
  if (name === 'dobbel') {
    const amount = interaction.options.getInteger('aantal') ?? 1;
    const dice = Array.from({ length: amount }, () => randomInt(1, 7));
    return interaction.reply({ embeds: [embed(config, '🎲 Legion | Dobbelstenen', `<@${user}> gooit: **${dice.join(' · ')}**\nTotaal: **${dice.reduce((a, b) => a + b, 0)}**`)], allowedMentions: quiet });
  }
  if (name === '8ball') {
    const answers = config.content.eightBallAnswers;
    return interaction.reply({ embeds: [embed(config, '🔮 Legion | 8-ball', `**${safeText(interaction.options.getString('vraag', true))}**\n\n${answers[randomInt(answers.length)]}`)], allowedMentions: quiet });
  }
  const guess = interaction.options.getString('keuze', true);
  const chosen = ['steen', 'papier', 'schaar'][randomInt(3)];
  const beats = { steen: 'schaar', papier: 'steen', schaar: 'papier' };
  return interaction.reply({ embeds: [embed(config, '✂️ Legion | Steen, papier, schaar', `<@${user}>: **${guess}**\nBot: **${chosen}**\n\n${guess === chosen ? 'Gelijkspel!' : beats[guess] === chosen ? 'Je wint!' : 'De bot wint!'}`)], allowedMentions: quiet });
}

async function handleCommand(ctx, interaction) {
  const { config } = ctx;
  const name = interaction.commandName;
  if (name === 'help') {
    return interaction.reply({ ...privateReply, embeds: [embed(config, 'Legion | Commands', [
      '**Algemeen:** /info, /regels, /rangen, /solliciteren, /sollicitatiestatus, /mijnwarns',
      ...(!config.ticketsEnabled ? ['**Gang:** /planning, /planning-overzicht, /planning-annuleren, /promotie'] : []),
      ...(config.ticketsEnabled ? ['**Tickets:** /ticket openen, /ticket sluiten'] : []),
      '**Games:** /blackjack, /coinflip, /dobbel, /8ball, /steenpapier, /fish',
      '**Coins:** /saldo, /daily, /leaderboard, /missies',
      '**Leiding:** /dashboard, /gangwarn geven, /gangwarn bekijken, /gangwarn intrekken',
      '**Aangenomen:** /uitnodiging voor je persoonlijke ganginvite',
      '**Administrators:** /inrichten, /setup',
      '\nCoins zijn fictief, per guild gescheiden en hebben geen geldwaarde of FiveM-koppeling.'
    ].join('\n'))] });
  }
  if (['info', 'regels', 'rangen'].includes(name)) return info(ctx, interaction, name);
  if (name === 'sollicitatiestatus') return showApplicationStatus(ctx,interaction);
  if (['planning','planning-overzicht','planning-annuleren'].includes(name)) return handlePlanningCommand(ctx,interaction);
  if (name === 'promotie') return handlePromotionCommand(ctx,interaction);
  if (name === 'dashboard') {
    requireStaff(interaction, config);
    await interaction.deferReply(privateReply);
    const url = dashboard.issueLogin(interaction.user.id, interaction.guildId);
    return interaction.editReply({ allowedMentions: quiet, content: 'Open je privé Legion-dashboard. De inloglink is twee minuten geldig en werkt één keer.',
      components: [row(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Dashboard openen').setURL(url))] });
  }
  if (name === 'uitnodiging') {
    const entry = ctx.store.db.prepare("SELECT a.case_id FROM acceptance_notifications a JOIN cases c ON c.id=a.case_id WHERE a.owner_id=? AND c.status='accepted' AND a.status!='revoked' ORDER BY c.closed_at DESC LIMIT 1").get(interaction.user.id);
    assertUser(entry, 'Je hebt nog geen aangenomen sollicitatie met een persoonlijke uitnodiging.');
    assertUser(!config.memberRoleId || interaction.member.roles.cache.has(config.memberRoleId), 'Je hebt de aangenomen ledenrol niet meer. Vraag de leiding om hulp.');
    await interaction.deferReply(privateReply);
    let notice = ctx.store.acceptance(entry.case_id);
    if (['expired','dm_blocked','pending'].includes(notice.status)) { ctx.store.requeueAcceptance(entry.case_id); notice = await deliverAcceptance(ctx, client, entry.case_id); }
    const link = notice.invite_code && notice.expires_at > Date.now() ? `https://discord.gg/${notice.invite_code}` : notice.status === 'joined' ? `https://discord.com/channels/${notice.target_guild_id}/${config.admission.inviteChannelId}` : null;
    assertUser(link, 'Je uitnodiging wordt nog voorbereid. Probeer over een minuut opnieuw of vraag de leiding.');
    return interaction.editReply({ content: notice.status === 'joined' ? 'Je bent al lid van de gangserver.' : 'Deze uitnodiging werkt uitsluitend met jouw Discord-account en vervalt na één gebruik.',
      components: [row(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(notice.status === 'joined' ? 'Gangserver openen' : 'Legion joinen').setURL(link))], allowedMentions: quiet });
  }
  if (['gangwarn', 'mijnwarns'].includes(name)) return handleWarn(ctx, interaction);
  if (gameCommands.has(name)) return games(ctx, interaction);
  if (name === 'solliciteren') return startApplication(ctx, interaction);
  if (name === 'inrichten') {
    requireAdmin(interaction);
    return locks.run(`${interaction.guildId}:configure`, async () => {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      return configureGuild(ctx, interaction);
    });
  }
  if (name === 'setup') {
    requireAdmin(interaction);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const channel = interaction.options.getChannel('kanaal')?.id || config.panelChannelId || interaction.channelId;
    return locks.run(`${interaction.guildId}:panel:${channel}`, async () => {
      await publishPanel(ctx, interaction.guild, channel, interaction.options.getString('paneel', true));
      await interaction.editReply({ content: `Paneel geplaatst of ververst in <#${channel}>.`, allowedMentions: quiet });
    });
  }
  if (name === 'ticket') {
    requireTickets(config);
    if (interaction.options.getSubcommand() === 'openen') {
      return locks.run(`${interaction.guildId}:case:${interaction.user.id}`, async () => {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        return createCase(ctx, interaction, 'ticket', {});
      });
    }
    const dossier = ctx.store.caseByChannel(interaction.channelId);
    assertUser(dossier?.kind === 'ticket', 'Gebruik dit command in je ticketkanaal.');
    return requestCaseDecision(ctx, interaction, dossier.id, 'close');
  }
  throw new UserError('Onbekend command. Probeer /help.');
}

async function handleButton(ctx, interaction) {
  const [type, action, id, extra, confirmer] = interaction.customId.split(':');
  if (type === 'mission') { requireGames(ctx,interaction); return handleMissionButton(ctx,interaction); }
  if (type === 'promotion') return handlePromotionButton(ctx,interaction);
  if (type === 'info') return info(ctx, interaction);
  if (type === 'ticket') {
    requireTickets(ctx.config);
    if (action === 'new') return openDirectCase(ctx, interaction, 'ticket');
    if (action === 'askclose') return requestCaseDecision(ctx, interaction, id, 'close');
  }
  if (type === 'application') {
    if (action === 'status') return showApplicationStatus(ctx,interaction,id);
    if (action === 'new') return startApplication(ctx, interaction);
    if (action === 'continue') return startApplication(ctx, interaction);
    if (action === 'interview') return locks.run(`${interaction.guildId}:case-decision:${id}`, async () => {
      requireStaff(interaction, ctx.config);
      await interaction.deferReply(privateReply);
      return startInterview(ctx, interaction, id);
    });
    if (['askaccept', 'askreject', 'askclose'].includes(action)) return requestCaseDecision(ctx, interaction, id, { askaccept: 'accept', askreject: 'reject', askclose: 'close' }[action]);
  }
  if (type === 'case') {
    if (action === 'cancel') {
      assertUser(extra === interaction.user.id, 'Deze bevestiging is van een ander lid.');
      return interaction.update({ content: 'Geannuleerd.', components: [] });
    }
    assertUser(action === 'confirm' && confirmer === interaction.user.id, 'Deze bevestiging is van een ander lid.');
    const lockId = extra === 'accept' ? `${interaction.guildId}:accept-member` : `${interaction.guildId}:decision:${id}`;
    return locks.run(lockId, () => locks.run(`${interaction.guildId}:case-decision:${id}`, async () => {
      await interaction.deferUpdate();
      return decideCase(ctx, interaction, id, extra);
    }));
  }
  if (type === 'bj') {
    requireGames(ctx, interaction);
    await interaction.deferUpdate();
    const game = ctx.store.playGame(id, interaction.user.id, Number(extra), action);
    const message = await interaction.editReply({ ...blackjackMessage(ctx.config, ctx.store, game), allowedMentions: quiet });
    ctx.store.bindGame(id, interaction.channelId, message.id);
    return;
  }
  throw new UserError('Deze knop is niet beschikbaar. Probeer /help.');
}

async function handleModal(ctx, interaction) {
  const [type, action, draftId, stepValue, revisionValue] = interaction.customId.split(':');
  if (type === 'application' && action === 'submit' && draftId) {
    const step = Number(stepValue);
    assertUser(applicationSteps[step], 'Deze formulierstap wordt niet herkend.');
    const answers = Object.fromEntries(applicationSteps[step].map(field => [field.id, interaction.fields.getTextInputValue(field.id).trim()]));
    const draft = ctx.store.advanceApplication(draftId, interaction.user.id, step, Number(revisionValue), answers);
    if (draft.step < applicationSteps.length) return interaction.reply({ ...applicationProgress(ctx.config, draft), ...privateReply });
    return finishApplication(ctx, interaction, draft);
  }
  // Formulieren die al voor deze update geopend waren blijven bruikbaar.
  const kind = interaction.customId === 'ticket:submit' ? 'ticket' : interaction.customId === 'application:submit' ? 'application' : null;
  assertUser(kind, 'Dit formulier wordt niet herkend.');
  if (kind === 'ticket') requireTickets(ctx.config);
  const fields = kind === 'ticket' ? ['subject', 'details'] : ['name', 'experience', 'motivation', 'availability', 'rules'];
  const payload = Object.fromEntries(fields.map(name => [name, interaction.fields.getTextInputValue(name).trim()]));
  assertUser(Object.values(payload).every(value => value.length > 0), 'Vul alle vragen in.');
  return locks.run(`${interaction.guildId}:case:${interaction.user.id}`, async () => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    return createCase(ctx, interaction, kind, payload);
  });
}

async function finishApplication(ctx, interaction, draft) {
  return locks.run(`${interaction.guildId}:case:${interaction.user.id}`, async () => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await createCase(ctx, interaction, 'application', draft.answers);
    ctx.store.deleteApplicationDraft(draft.id, interaction.user.id);
  });
}

async function startApplication(ctx, interaction) {
  requireApplicationsOpen(ctx);
  return openDirectCase(ctx, interaction, 'application');
}

async function openDirectCase(ctx, interaction, kind) {
  return locks.run(`${interaction.guildId}:case:${interaction.user.id}`, async () => {
    await interaction.deferReply(privateReply);
    return createCase(ctx, interaction, kind, kind === 'application' ? { template: true } : {});
  });
}

client.on(Events.InteractionCreate, async interaction => {
  try {
    assertUser(interaction.inGuild(), 'Gebruik deze bot in een Legion-guild.');
    const ctx = contexts.get(interaction.guildId);
    assertUser(ctx, 'Deze guild is niet ingesteld voor Legion.');
    assertUser(ctx.ready, 'De bot start nog op. Probeer over een paar seconden opnieuw.');
    if (interaction.isChatInputCommand()) await handleCommand(ctx, interaction);
    else if (interaction.isButton()) await handleButton(ctx, interaction);
    else if (interaction.isModalSubmit()) await handleModal(ctx, interaction);
  } catch (error) {
    const content = error instanceof UserError ? error.message : 'De actie kon niet worden afgerond. Controleer de botrechten of vraag de leiding. Een bestaand blackjackspel kun je hervatten met /blackjack zonder inzet.';
    if (!(error instanceof UserError)) console.error(`Guild ${interaction.guildId}: interactie mislukt (${error.code ?? error.name}).`);
    const payload = { content, flags: MessageFlags.Ephemeral, allowedMentions: quiet };
    if (interaction.deferred && !interaction.replied) await interaction.editReply({ content, allowedMentions: quiet }).catch(() => {});
    else if (interaction.replied || interaction.deferred) await interaction.followUp(payload).catch(() => {});
    else await interaction.reply(payload).catch(() => {});
  }
});

client.once(Events.ClientReady, async ready => {
  console.log(`Legion is online als ${ready.user.tag}.`);
  for (const [guildId, ctx] of contexts) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) { console.error(`Guild ${guildId}: nodig de bot eerst uit in deze guild.`); continue; }
    try {
      await syncCommands(ctx,guild).catch(error=>console.error(`Guild ${guildId}: commands bijwerken wacht op herstart (${error.code??error.name}).`));
      await guild.members.fetchMe();
      await guild.roles.fetch();
      await refreshRecruitment(ctx, guild);
      await reconcileCases(ctx, guild);
      if (ctx.config.roster) await publishRoster(ctx, guild, true);
      if (ctx.config.transcriptSiteURL) ctx.store.queueTranscriptUpgrade();
      ctx.store.queueClosedCases();
      ctx.ready = true;
      if (ctx.config.logChannelId) await staffLogChannel(guild, ctx.config);
      if (ctx.config.warnLogChannelId) await warnLogChannel(guild, ctx.config);
      if (ctx.config.panelChannelId) await publishPanel(ctx, guild, ctx.config.panelChannelId);
      console.log(`Guild ${guildId}: gereed. Tickets ${ctx.config.ticketsEnabled ? 'aan' : 'uit'}.`);
      if (ctx.recruitment) console.log(`Guild ${guildId}: sollicitaties ${ctx.recruitment.icon} ${ctx.recruitment.label} (${ctx.recruitment.count}/${ctx.config.recruitment.capacity}).`);
    } catch (error) {
      // /inrichten blijft bereikbaar als alleen een ingestelde categorie/paneel/log fout is.
      ctx.ready = true;
      console.error(`Guild ${guildId}: controleer inrichting (${error instanceof UserError ? error.message : error.code ?? error.name}).`);
    }
  }
  await drainTranscripts();
});

const recruitmentDebounce = new Map();
const rosterDebounce = new Map();
function rosterChanged(guild) {
  const ctx = contexts.get(guild.id);
  if (!ctx?.ready || !ctx.config.roster) return;
  clearTimeout(rosterDebounce.get(guild.id));
  const task = setTimeout(async () => {
    rosterDebounce.delete(guild.id);
    if (shuttingDown) return;
    await locks.run(`${guild.id}:roster`, () => publishRoster(ctx, guild)).catch(error => console.error(`Guild ${guild.id}: ledenlijst bijwerken mislukt (${error.code ?? error.name}).`));
  }, 2000);
  task.unref(); rosterDebounce.set(guild.id, task);
}
function membershipChanged(guild) {
  const ctx = contexts.get(guild.id);
  if (!ctx?.ready || !ctx.config.recruitment) return;
  const previous = ctx.recruitment?.count;
  const current = countRecruitment(ctx, guild);
  if (current.count === previous) return;
  clearTimeout(recruitmentDebounce.get(guild.id));
  const task = setTimeout(async () => {
    recruitmentDebounce.delete(guild.id);
    if (shuttingDown) return;
    try {
      const panels = ctx.store.db.prepare("SELECT key FROM settings WHERE key LIKE 'panel:%'").all();
      for (const entry of panels) {
        const [, type, channelId] = entry.key.split(':');
        if (['alles', 'sollicitaties', 'tickets'].includes(type)) await publishPanel(ctx, guild, channelId, type);
      }
      await reconcileCases(ctx, guild);
    } catch (error) { console.error(`Guild ${guild.id}: sollicitatiestatus bijwerken mislukt (${error.code ?? error.name}).`); }
  }, 2000);
  task.unref();
  recruitmentDebounce.set(guild.id, task);
}
client.on(Events.GuildMemberAdd, member => { membershipChanged(member.guild); rosterChanged(member.guild); admissionJoined(member, contexts).catch(() => {}); });
client.on(Events.GuildMemberRemove, member => {
  membershipChanged(member.guild); rosterChanged(member.guild);
  const ctx = contexts.get(member.guild.id); if (ctx) revokeAcceptances(ctx, client, member.id).catch(() => {});
});
client.on(Events.GuildMemberUpdate, (before, after) => {
  const ctx = contexts.get(after.guild.id);
  if (ctx?.config.recruitment && before.roles.cache.has(ctx.config.memberRoleId) !== after.roles.cache.has(ctx.config.memberRoleId)) membershipChanged(after.guild);
  if (ctx?.config.memberRoleId && before.roles.cache.has(ctx.config.memberRoleId) && !after.roles.cache.has(ctx.config.memberRoleId)) revokeAcceptances(ctx, client, after.id).catch(() => {});
  if (ctx?.config.roster && (before.displayName !== after.displayName || ctx.config.roster.roleIds.some(id => before.roles.cache.has(id) !== after.roles.cache.has(id)))) rosterChanged(after.guild);
});
client.on(Events.GuildRoleUpdate, (before, after) => { if (before.name !== after.name) rosterChanged(after.guild); });

const rosterTimer = setInterval(async () => {
  if (shuttingDown) return;
  for (const ctx of contexts.values()) {
    if (!ctx.ready || !ctx.config.roster) continue;
    const guild = client.guilds.cache.get(ctx.config.guildId);
    if (guild) await locks.run(`${guild.id}:roster`, () => publishRoster(ctx, guild, true)).catch(error => console.error(`Guild ${guild.id}: ledenlijst synchroniseren mislukt (${error.code ?? error.name}).`));
  }
}, 300000);
rosterTimer.unref();

const timer = setInterval(async () => {
  if (shuttingDown) return;
  for (const ctx of contexts.values()) {
    if (!ctx.ready) continue;
    try {
      for (const game of ctx.store.expiredGames()) {
        const guild = client.guilds.cache.get(ctx.config.guildId);
        const channel = guild?.channels.cache.get(game.channelId);
        if (!channel?.isTextBased() || !game.messageId) continue;
        const message = await channel.messages.fetch(game.messageId).catch(() => null);
        if (message?.author.id === client.user.id) await message.edit({ ...blackjackMessage(ctx.config, ctx.store, game), allowedMentions: quiet }).catch(() => {});
      }
    } catch (error) { console.error(`Blackjack afronden mislukt (${error.code ?? error.name}).`); }
  }
  for (const [key, expires] of cooldowns) if (expires < Date.now()) cooldowns.delete(key);
}, 15000);
timer.unref();

let transcriptBusy = false;
async function drainTranscripts() {
  if (shuttingDown || transcriptBusy) return;
  transcriptBusy = true;
  try {
    for (const ctx of contexts.values()) {
      if (!ctx.ready) continue;
      const guild = client.guilds.cache.get(ctx.config.guildId);
      if (guild) await cleanupInterviews(ctx, guild);
      if (guild) { await syncActivities(ctx,guild); await syncPromotions(ctx,guild); }
      for (const notice of ctx.store.pendingAcceptances()) await locks.run(`${ctx.config.guildId}:admission:${notice.case_id}`, () => deliverAcceptance(ctx, client, notice.case_id));
      await expireAcceptanceInvites(ctx, client);
      for (const delivery of ctx.store.pendingTranscripts()) {
        await locks.run(`${ctx.config.guildId}:transcript:${delivery.case_id}`, () => archiveTranscript(ctx, client, delivery.case_id, staffLogChannel)).catch(() => {});
      }
      await cleanupClosedCases(ctx, client);
    }
  } finally { transcriptBusy = false; }
}
const transcriptTimer = setInterval(() => drainTranscripts().catch(() => {}), 60000);
transcriptTimer.unref();

client.on(Events.Error, error => console.error(`Discord-verbinding: ${error.code ?? error.name}.`));
for(const [event,added] of [[Events.MessageReactionAdd,true],[Events.MessageReactionRemove,false]])client.on(event,(reaction,user)=>{
  const ctx=contexts.get(reaction.message.guildId);if(!ctx?.ready||user.id===client.user?.id)return;
  handlePlanningReaction(ctx,reaction,user,added).catch(error=>console.error(`Planningreactie wordt opnieuw gesynchroniseerd (${error.code??error.name}).`));
});
client.on(Events.MessageReactionRemoveAll,message=>{const ctx=contexts.get(message.guildId);if(ctx?.ready)clearPlanningReactions(ctx,message).catch(()=>{});});
client.on(Events.MessageReactionRemoveEmoji,reaction=>{const ctx=contexts.get(reaction.message.guildId);if(ctx?.ready)clearPlanningReactions(ctx,reaction.message,reaction.emoji.name).catch(()=>{});});
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(timer);
  clearInterval(transcriptTimer);
  clearInterval(rosterTimer);
  for (const task of recruitmentDebounce.values()) clearTimeout(task);
  for (const task of rosterDebounce.values()) clearTimeout(task);
  await stopViewer?.();
  dashboard.close();
  await client.destroy();
  for (const ctx of contexts.values()) ctx.store.close();
}
process.once('SIGINT', () => shutdown().catch(() => {}));
process.once('SIGTERM', () => shutdown().catch(() => {}));
try {
  try { stopViewer = await startTranscriptViewer(base, contexts, drainTranscripts, dashboard); }
  catch (error) {
    dashboard.setConnection('', `Het dashboard kan niet starten (${error.code ?? error.name}). Controleer TRANSCRIPT_PORT en de hostingconsole.`);
    console.error(`Dashboard/viewer kon niet starten (${error.code ?? error.name}); exports blijven in de wachtrij.`);
  }
  await client.login(base.token);
}
catch (error) {
  console.error(`Inloggen mislukt (${error.code ?? error.name}). Controleer je lokale .env.`);
  await shutdown();
  process.exitCode = 1;
}
