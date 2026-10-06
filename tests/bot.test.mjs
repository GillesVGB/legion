import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PermissionsBitField, PermissionFlagsBits as P } from 'discord.js';
import { Store, DAY } from '../src/store.mjs';
import { loadConfig } from '../src/config.mjs';
import { commands } from '../src/commands.mjs';
import { handValue, makeDeck } from '../src/cards.mjs';
import { panel, blackjackMessage, ticketModal, applicationModal, caseMessage } from '../src/ui.mjs';
import { warningMessage, requireStaff, requireTickets, staffLogChannel } from '../src/service.mjs';

const base = loadConfig({}, false);
const config = { ...base, ...base.guilds[1] };
const memory = options => new Store({ ...config, ...options }, ':memory:');
const card = rank => ({ rank, suit: '♠' });
// De kaarten aan het einde van een deck worden als eerste gepakt.
const deckFor = (player1, dealer1, player2, dealer2, ...next) =>
  [...next.reverse(), dealer2, player2, dealer1, player1].map(card);

test('beide guilds hebben commands, tickets uitsluitend in de tweede guild', () => {
  assert.deepEqual(base.guilds.map(g => g.guildId), ['1555685630640652338', '1555726440933363753']);
  for (const guild of base.guilds) {
    const definitions = commands(base.maxBet, guild.ticketsEnabled);
    assert.equal(definitions.some(cmd => cmd.name === 'ticket'), guild.ticketsEnabled);
    assert.equal(new Set(definitions.map(cmd => cmd.name)).size, definitions.length);
    assert.ok(definitions.every(cmd => cmd.dm_permission === false));
    const buttons = panel({ ...base, ...guild }).components[0].toJSON().components;
    assert.equal(buttons.some(b => b.custom_id === 'ticket:new'), guild.ticketsEnabled);
    assert.ok(buttons.some(b => b.custom_id === 'application:new'));
  }
  assert.equal(base.guilds[1].panelChannelId, '1555726441759375398');
});

test('ticketblokkade werkt ook achter de knoppen en in de opslag', t => {
  const store = memory({ ticketsEnabled: false }); t.after(() => store.close());
  assert.throws(() => requireTickets({ ticketsEnabled: false }), /alleen beschikbaar/);
  assert.throws(() => store.reserveCase('ticket', 'member', {}), /uitgeschakeld/);
  assert.ok(store.reserveCase('application', 'member', {}));
});

test('warns, coins en dossiers zijn gescheiden per guild', t => {
  const folder = mkdtempSync(join(tmpdir(), 'legion-isolation-'));
  const a = new Store({ ...base, ...base.guilds[0], dataDir: folder });
  const b = new Store({ ...base, ...base.guilds[1], dataDir: folder });
  t.after(() => { a.close(); b.close(); rmSync(folder, { recursive: true, force: true }); });
  a.addWarn('member', 'staff', 'Afspraak gemist');
  b.daily('member', DAY * 10);
  b.reserveCase('ticket', 'member', { subject: 'Vraag' });
  assert.equal(a.warnCount('member'), 1); assert.equal(b.warnCount('member'), 0);
  assert.equal(a.wallet('member').balance, config.startingCoins);
  assert.equal(b.wallet('member').balance, config.startingCoins + config.dailyCoins);
  assert.equal(a.activeCases().length, 0); assert.equal(b.activeCases().length, 1);
});

test('warn intrekken is eenmalig en bewaart de historie', t => {
  const store = memory(); t.after(() => store.close());
  const warning = store.addWarn('member', 'staff', 'Afspraak gemist');
  assert.equal(warning.count, 1);
  store.removeWarn(warning.id, 'staff', 'Hersteld');
  assert.equal(store.warnCount('member'), 0);
  assert.equal(store.warnings('member')[0].removed_reason, 'Hersteld');
  assert.throws(() => store.removeWarn(warning.id, 'staff', 'Nogmaals'), /al ingetrokken/);
});

test('daily kan pas na 24 uur opnieuw geclaimd worden', t => {
  const store = memory(); t.after(() => store.close());
  const now = DAY * 10;
  assert.equal(store.daily('member', now).available, true);
  assert.equal(store.daily('member', now).available, false);
  assert.equal(store.daily('member', now + DAY - 1).available, false);
  assert.equal(store.daily('member', now + DAY).available, true);
  assert.equal(store.wallet('member').balance, config.startingCoins + config.dailyCoins * 2);
});

test('ongeldige of te hoge inzetten veranderen het saldo niet', t => {
  const store = memory(); t.after(() => store.close());
  for (const bet of [-1, 0, 1, 1.5, config.maxBet + 1, NaN, Infinity]) {
    assert.throws(() => store.coinflip('member', bet, 'kop', 'kop'));
  }
  assert.throws(() => store.startGame('member', 101), /even inzet/);
  store.coinflip('member', 500, 'kop', 'munt');
  store.coinflip('member', 500, 'kop', 'munt');
  assert.throws(() => store.coinflip('member', 2, 'kop', 'kop'), /te weinig/);
  assert.equal(store.wallet('member').balance, 0);
});

test('coinflip betaalt netto exact een inzet bij winst en verlies', t => {
  const store = memory(); t.after(() => store.close());
  assert.equal(store.coinflip('member', 100, 'kop', 'kop').balance, 1100);
  assert.equal(store.coinflip('member', 100, 'kop', 'munt').balance, 1000);
});

test('kaartspel heeft 52 unieke kaarten en azen worden correct geteld', () => {
  const deck = makeDeck();
  assert.equal(deck.length, 52);
  assert.equal(new Set(deck.map(c => c.rank + c.suit)).size, 52);
  assert.equal(handValue(['A', 'A', '9'].map(card)), 21);
  assert.equal(handValue(['A', 'K', '6'].map(card)), 17);
});

test('blackjack 3:2 wordt direct en eenmalig uitbetaald', t => {
  const store = memory(); t.after(() => store.close());
  const game = store.startGame('member', 100, 1000, deckFor('A', '9', 'K', '7'));
  assert.equal(game.status, 'done');
  assert.equal(game.result.credit, 250);
  assert.equal(store.wallet('member').balance, 1150);
  assert.throws(() => store.playGame(game.id, 'member', game.revision, 'stand'), /al afgelopen/);
  assert.equal(store.wallet('member').balance, 1150);
});

test('dealer blackjack wint, dubbele blackjack geeft de inzet terug', t => {
  const store = memory(); t.after(() => store.close());
  const lost = store.startGame('member', 100, 1000, deckFor('9', 'A', '7', 'K'));
  assert.equal(lost.result.credit, 0);
  const push = store.startGame('member', 100, 1000, deckFor('A', 'A', 'K', 'K'));
  assert.equal(push.result.credit, 100);
  assert.equal(store.wallet('member').balance, 900);
});

test('ander lid, dubbele spelstart en oude blackjackknop worden geweigerd', t => {
  const store = memory(); t.after(() => store.close());
  const game = store.startGame('member', 100, 1000, deckFor('5', '9', '6', '8', '2', 'K'));
  assert.throws(() => store.startGame('member', 100), /al een blackjackspel/);
  assert.throws(() => store.playGame(game.id, 'other', 0, 'hit', 1001), /andere speler/);
  const hit = store.playGame(game.id, 'member', 0, 'hit', 1001);
  assert.equal(hit.revision, 1);
  assert.throws(() => store.playGame(game.id, 'member', 0, 'hit', 1001), /verouderd/);
  const done = store.playGame(game.id, 'member', 1, 'stand', 1001);
  assert.equal(done.result.credit, 0);
  assert.equal(store.wallet('member').balance, 900);
});

test('bust verliest direct en timeout past automatisch, ook na herstart', t => {
  const folder = mkdtempSync(join(tmpdir(), 'legion-restart-'));
  const path = join(folder, 'bot.sqlite');
  const store = new Store(config, path);
  const bust = store.startGame('bust', 100, 1000, deckFor('K', '9', '6', '8', 'K'));
  assert.equal(store.playGame(bust.id, 'bust', 0, 'hit', 1001).result.credit, 0);
  const game = store.startGame('idle', 100, 1000, deckFor('K', '9', '9', '8'));
  store.close();
  const resumed = new Store(config, path);
  t.after(() => { resumed.close(); rmSync(folder, { recursive: true, force: true }); });
  assert.equal(resumed.activeGame('idle').id, game.id);
  const expired = resumed.expiredGames(game.expires);
  assert.equal(expired.length, 1);
  assert.equal(expired[0].result.credit, 200);
  assert.equal(resumed.wallet('idle').balance, 1100);
  assert.equal(resumed.expiredGames(game.expires).length, 0);
});

test('dossiers beperken dubbele aanvragen en oude beslisknoppen', t => {
  const store = memory(); t.after(() => store.close());
  const dossier = store.reserveCase('ticket', 'member', { subject: 'Hulp' });
  assert.throws(() => store.reserveCase('ticket', 'member', {}), /nog aangemaakt/);
  store.bindCase(dossier.id, 'channel'); store.openCase(dossier.id, 'message');
  assert.throws(() => store.reserveCase('ticket', 'member', {}), /open dossier/);
  store.closeCase(dossier.id, 'closed', 'staff');
  assert.throws(() => store.closeCase(dossier.id, 'closed', 'staff'), /al afgehandeld/);
  assert.throws(() => store.reserveCase('ticket', 'member', {}), /per minuut/);
  assert.ok(store.reserveCase('ticket', 'member', {}, dossier.created_at + 60000));
});

test('leidingcontrole gebruikt de rollen van de huidige guild', () => {
  const perms = new PermissionsBitField();
  const interaction = { memberPermissions: perms, member: { roles: { cache: new Map([['staff-a', {}]]) } } };
  requireStaff(interaction, { staffRoleIds: ['staff-a'] });
  assert.throws(() => requireStaff(interaction, { staffRoleIds: ['staff-b'] }), /Alleen de Legion-leiding/);
  requireStaff({ memberPermissions: new PermissionsBitField(P.Administrator) }, { staffRoleIds: [] });
});

test('een publiek logkanaal wordt geblokkeerd voordat privegegevens worden verstuurd', async () => {
  const channel = { guildId: 'guild', type: 0, permissionsFor: () => new PermissionsBitField([P.ViewChannel, P.SendMessages, P.EmbedLinks]), permissionOverwrites: { cache: new Map() } };
  const guild = { id: 'guild', channels: { fetch: async () => channel }, members: { me: { id: 'bot' } },
    roles: { cache: new Map([['everyone', { id: 'guild', permissions: new PermissionsBitField() }]]) } };
  await assert.rejects(staffLogChannel(guild, { logChannelId: 'log', staffRoleIds: [] }), /zichtbaar voor een rol buiten/);
});

test('embeds en formulieren passen binnen Discord-limieten', t => {
  const store = memory(); t.after(() => store.close());
  for (let i = 0; i < 25; i++) {
    const warning = store.addWarn('1555685630640652338', '1555726440933363753', '*'.repeat(500));
    store.removeWarn(warning.id, '1555726440933363753', '*'.repeat(500));
  }
  const card = warningMessage(config, store, '1555685630640652338').toJSON();
  const length = (card.title?.length ?? 0) + (card.description?.length ?? 0) + (card.footer?.text.length ?? 0) + card.fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0);
  assert.ok(length <= 6000);
  const game = store.startGame('member', 100, 1000, deckFor('K', '9', '9', '8'));
  assert.ok(blackjackMessage(config, store, game).components[0].toJSON());
  assert.ok(ticketModal().toJSON()); assert.ok(applicationModal().toJSON());
  const dossier = store.reserveCase('application', 'member', { name: '*'.repeat(100), experience: '*'.repeat(700), motivation: '*'.repeat(700), availability: '*'.repeat(150), rules: '*'.repeat(100) });
  assert.ok(caseMessage(config, dossier).embeds[0].toJSON().fields.every(field => field.value.length <= 1024));
});

test('config weigert onveilige getallen, ongeldige kleur en ontbrekende credentials', () => {
  assert.throws(() => loadConfig({ MAX_BET: '-10' }, false), /MAX_BET/);
  assert.throws(() => loadConfig({ EMBED_COLOR: 'red' }, false), /EMBED_COLOR/);
  assert.throws(() => loadConfig({}, true), /DISCORD_TOKEN/);
});
