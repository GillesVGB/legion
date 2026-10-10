import { SlashCommandBuilder, PermissionFlagsBits, ChannelType } from 'discord.js';

const cmd = (name, description) => new SlashCommandBuilder().setName(name).setDescription(description).setDMPermission(false);
const userOption = option => option.setName('lid').setDescription('Het Legion-lid').setRequired(true);
const reasonOption = option => option.setName('reden').setDescription('Reden, maximaal 500 tekens').setRequired(true).setMaxLength(500);
const betOption = (maxBet, required = true) => option => option.setName('inzet').setDescription('Aantal fictieve Legion-coins (blackjack: even aantal)').setMinValue(2).setMaxValue(maxBet).setRequired(required);

export function commands(maxBet, ticketsEnabled = true) {
  const result = [
    cmd('help', 'Bekijk alle Legion-commands'),
    cmd('info', 'Informatie over Legion en Future RP'),
    cmd('regels', 'Lees de door Legion ingestelde regels'),
    cmd('rangen', 'Bekijk de rangvolgorde van Legion'),
    cmd('dashboard', 'Open het privé Legion-dashboard (alleen leiding)'),
    cmd('botstatus','Bekijk verbinding, uptime en acties die op herhaling wachten (leiding)'),
    cmd('vangstenboek','Bekijk je visverzameling en wekelijkse challenges'),
    cmd('afmelden','Vraag Lead-goedkeuring voor afwezigheid op een planning')
      .addStringOption(o=>o.setName('planning').setDescription('Planning-ID onderaan het bericht').setRequired(true).setMinLength(12).setMaxLength(12))
      .addStringOption(reasonOption),
    cmd('afwezig','Afwezigheid aanvragen en gangpotvrijstellingen beheren')
      .addSubcommand(s=>s.setName('aanvragen').setDescription('Vraag goedgekeurde afwezigheid voor een periode aan')
        .addStringOption(o=>o.setName('van').setDescription('Begindatum DD-MM-JJJJ').setRequired(true).setMaxLength(10))
        .addStringOption(o=>o.setName('tot').setDescription('Einddatum DD-MM-JJJJ').setRequired(true).setMaxLength(10)).addStringOption(reasonOption))
      .addSubcommand(s=>s.setName('status').setDescription('Bekijk je eigen aanvragen en vrijgestelde weken'))
      .addSubcommand(s=>s.setName('vrijstellen').setDescription('Geef een gebruiker vrijstelling voor één gangpotweek (Lead)')
        .addUserOption(o=>o.setName('gebruiker').setDescription('Legion-lid').setRequired(true))
        .addStringOption(o=>o.setName('termijn').setDescription('Zaterdag van de week: DD-MM-JJJJ').setRequired(true).setMaxLength(10)).addStringOption(reasonOption))
      .addSubcommand(s=>s.setName('vrijstelling-intrekken').setDescription('Trek een specifieke weekvrijstelling in (Lead)')
        .addUserOption(o=>o.setName('gebruiker').setDescription('Legion-lid').setRequired(true))
        .addStringOption(o=>o.setName('termijn').setDescription('Zaterdag van de week: DD-MM-JJJJ').setRequired(true).setMaxLength(10)).addStringOption(reasonOption)),
    cmd('uitnodiging', 'Bekijk je persoonlijke uitnodiging na een aangenomen sollicitatie'),
    cmd('inrichten', 'Maak privecategorieen en een logkanaal voor deze guild')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addRoleOption(o => o.setName('leiding').setDescription('Rol die warns, tickets en sollicitaties beheert').setRequired(true))
      .addRoleOption(o => o.setName('leden').setDescription('Optionele ledenrol voor aangenomen sollicitanten')),
    cmd('setup', 'Plaats of ververs een Legion-paneel in deze guild')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addStringOption(o => o.setName('paneel').setDescription('Kies een paneel').setRequired(true).addChoices(
        { name: ticketsEnabled ? 'Tickets en solliciteren samen' : 'Solliciteren en informatie', value: 'alles' },
        ...(ticketsEnabled ? [{ name: 'Tickets', value: 'tickets' }] : []),
        { name: 'Solliciteren', value: 'sollicitaties' }, { name: 'Informatie', value: 'info' }))
      .addChannelOption(o => o.setName('kanaal').setDescription('Anders: ingesteld paneelkanaal, of huidig kanaal').addChannelTypes(ChannelType.GuildText)),
    cmd('gangwarn', 'Gangwarns beheren (alleen leiding)')
      .addSubcommand(s => s.setName('geven').setDescription('Geef een lid een gangwarn').addUserOption(userOption).addStringOption(reasonOption))
      .addSubcommand(s => s.setName('bekijken').setDescription('Bekijk de gangwarns van een lid').addUserOption(userOption))
      .addSubcommand(s => s.setName('intrekken').setDescription('Trek een gangwarn in; historie blijft bewaard')
        .addStringOption(o => o.setName('id').setDescription('Warn-ID uit /gangwarn bekijken').setRequired(true).setMaxLength(12))
        .addStringOption(reasonOption)),
    cmd('mijnwarns', 'Bekijk alleen je eigen gangwarns'),
    cmd('solliciteren', 'Open direct een prive sollicitatieticket met de Legion-template'),
    cmd('sollicitatiestatus', 'Bekijk privé je sollicitatiestatus en plek in de binnenkomstvolgorde'),
    cmd('planning', 'Plaats een planning in het vaste Legion-planningkanaal (alleen leiding)')
      .addStringOption(o=>o.setName('datum').setDescription('DD-MM-JJJJ, deze avond of morgenavond').setRequired(true).setMaxLength(32).setAutocomplete(true))
      .addStringOption(o=>o.setName('tijd').setDescription('Belgische tijd: UU:MM, bijvoorbeeld 20:30').setRequired(true).setMaxLength(5))
      .addStringOption(o=>o.setName('afspreekpunt').setDescription('Waar verzamelen we?').setRequired(true).setMaxLength(160)),
    cmd('planning-overzicht','Bekijk de komende Legion-activiteiten'),
    cmd('planning-annuleren','Annuleer een planning (alleen leiding)')
      .addStringOption(o=>o.setName('id').setDescription('Planning-ID onderaan het bericht').setRequired(true).setMinLength(12).setMaxLength(12)),
    cmd('promotie','Stel een hogere gangrang voor; de leiding beoordeelt het voorstel')
      .addUserOption(userOption)
      .addRoleOption(o=>o.setName('rang').setDescription('De voorgestelde hogere gangrang').setRequired(true))
      .addStringOption(o=>o.setName('motivatie').setDescription('Waarom past deze promotie bij het lid?').setRequired(true).setMaxLength(500)),
    cmd('gangpot','Gangpotbijdragen en bevestigde in-game betalingen beheren')
      .addSubcommand(s=>s.setName('status').setDescription('Bekijk privé je eigen weekbijdrage en deadline'))
      .addSubcommand(s=>s.setName('refresh').setDescription('Werk gangpotinformatie en betaaloverzicht direct bij (leiding)'))
      .addSubcommand(s=>s.setName('betaling').setDescription('Meld je eigen in-game betaling; Lead zet het vinkje')
        .addIntegerOption(o=>o.setName('bedrag').setDescription('Betaald bedrag; standaard 25000').setMinValue(1).setMaxValue(100000000))
        .addStringOption(o=>o.setName('termijn').setDescription('Zaterdag van de termijn: DD-MM-JJJJ; standaard huidige week').setMaxLength(10))
        .addStringOption(o=>o.setName('notitie').setDescription('Aan wie heb je betaald of welke toelichting heb je?').setMaxLength(500)))
      .addSubcommand(s=>s.setName('betaling-verwijderen').setDescription('Trek de betalingen en open meldingen van een gebruiker voor één week in (leiding)')
        .addUserOption(o=>o.setName('gebruiker').setDescription('De gebruiker van wie je de betaling wilt verwijderen').setRequired(true))
        .addStringOption(o=>o.setName('termijn').setDescription('Zaterdag: DD-MM-JJJJ; standaard huidige week').setMaxLength(10))
        .addStringOption(o=>o.setName('reden').setDescription('Waarom wordt de betaling verwijderd?').setMaxLength(500)))
      .addSubcommand(s=>s.setName('donatie').setDescription('Registreer extra in-game steun aan de gangpot (leiding)')
        .addIntegerOption(o=>o.setName('bedrag').setDescription('Ontvangen donatie').setRequired(true).setMinValue(1).setMaxValue(100000000))
        .addStringOption(o=>o.setName('notitie').setDescription('Van wie of waarvoor?').setMaxLength(500)))
      .addSubcommand(s=>s.setName('uitgave').setDescription('Registreer een uitgave uit de gangpot (leiding)')
        .addIntegerOption(o=>o.setName('bedrag').setDescription('Uitgegeven bedrag').setRequired(true).setMinValue(1).setMaxValue(100000000))
        .addStringOption(reasonOption))
      .addSubcommand(s=>s.setName('correctie').setDescription('Corrigeer een verkeerde registratie met behoud van historie (leiding)')
        .addStringOption(o=>o.setName('id').setDescription('Transactie-ID uit de bevestiging of dashboard').setRequired(true).setMinLength(12).setMaxLength(12))
        .addStringOption(reasonOption))
      .addSubcommand(s=>s.setName('overzicht').setDescription('Bekijk het betaaloverzicht van een weektermijn (leiding)')
        .addStringOption(o=>o.setName('termijn').setDescription('Zaterdag: DD-MM-JJJJ; standaard huidige week').setMaxLength(10))),
    cmd('missies','Bekijk je dagelijkse fun-missies, voortgang en coinbeloningen'),
    cmd('ticket', 'Open of sluit je prive ticket')
      .addSubcommand(s => s.setName('openen').setDescription('Open direct een prive ticket'))
      .addSubcommand(s => s.setName('sluiten').setDescription('Sluit het ticket in dit kanaal met bevestiging')),
    cmd('saldo', 'Bekijk je fictieve Legion-coins'),
    cmd('daily', 'Claim elke 24 uur gratis Legion-coins'),
    cmd('fish', 'Ga vissen: een mooie vangst of een kreeft die je bijt?'),
    cmd('leaderboard', 'De tien rijkste spelers in deze guild'),
    cmd('blackjack', 'Speel blackjack, of hervat zonder inzet').addIntegerOption(betOption(maxBet, false)),
    cmd('coinflip', 'Raad kop of munt met fictieve coins').addIntegerOption(betOption(maxBet))
      .addStringOption(o => o.setName('keuze').setDescription('Kop of munt?').setRequired(true).addChoices({ name: 'Kop', value: 'kop' }, { name: 'Munt', value: 'munt' })),
    cmd('dobbel', 'Gooi maximaal zes dobbelstenen').addIntegerOption(o => o.setName('aantal').setDescription('Aantal dobbelstenen').setMinValue(1).setMaxValue(6)),
    cmd('8ball', 'Vraag de magische Legion-bal om advies').addStringOption(o => o.setName('vraag').setDescription('Wat wil je weten?').setRequired(true).setMaxLength(200)),
    cmd('steenpapier', 'Steen, papier, schaar tegen de bot').addStringOption(o => o.setName('keuze').setDescription('Jouw keuze').setRequired(true)
      .addChoices({ name: 'Steen', value: 'steen' }, { name: 'Papier', value: 'papier' }, { name: 'Schaar', value: 'schaar' }))
  ];
  return result.filter(command => (ticketsEnabled || !['ticket','solliciteren','sollicitatiestatus'].includes(command.name)) &&
    (!ticketsEnabled || !['planning','planning-overzicht','planning-annuleren','promotie','gangpot','afwezig','afmelden'].includes(command.name))).map(command => command.toJSON());
}
