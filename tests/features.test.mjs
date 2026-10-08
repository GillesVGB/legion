import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { Collection } from 'discord.js';
import { Store } from '../src/store.mjs';
import { loadConfig } from '../src/config.mjs';
import { fishCatch, catches } from '../src/fishing.mjs';
import { applicationTemplate } from '../src/application.mjs';
import { caseMessages, blackjackMessage } from '../src/ui.mjs';
import { commands } from '../src/commands.mjs';
import { rosterGroups, rosterCards } from '../src/roster.mjs';
import { encryptTranscript, publishTranscriptView, transcriptViewURL } from '../src/viewer.mjs';
import { requestCaseDecision, removeClosedCase } from '../src/service.mjs';
const base = loadConfig({}, false);
const config = { ...base, ...base.guilds[1] };

test('een sollicitatie sluiten is alleen voor leiding en bevestigt transcript plus verwijderen', async t => {
  const store = new Store(config, ':memory:'); t.after(() => store.close());
  const dossier = store.reserveCase('application', 'member', { template: true });
  store.bindCase(dossier.id, 'source'); store.openCase(dossier.id, 'intro');
  const interaction = { channelId: 'source', user: { id: 'member' }, member: { roles: { cache: new Map() } }, deferReply: async () => {}, editReply: async () => {} };
  await assert.rejects(requestCaseDecision({ config, store }, interaction, dossier.id, 'close'), /leiding/);
  interaction.member.roles.cache.set(config.staffRoleIds[0], {});
  let message;
  interaction.editReply = async payload => { message = payload; };
  await requestCaseDecision({ config, store }, interaction, dossier.id, 'close');
  assert.match(message.content, /transcript.*verwijdert/); assert.ok(!message.content.includes('archief'));
});

test('een kanaal verdwijnt pas na een volledig opgeslagen transcript en herstel blijft mogelijk', async t => {
  const store = new Store(config, ':memory:'); t.after(() => store.close());
  const dossier = store.reserveCase('ticket', 'member', {});
  store.bindCase(dossier.id, 'source'); store.openCase(dossier.id, 'intro');
  const closed = store.closeCase(dossier.id, 'closed', 'staff');
  let deleted = 0;
  const channel = { guildId: config.guildId, type: 0, topic: `Legion dossier:${dossier.id} | ticket`, delete: async () => { deleted++; } };
  const guild = { channels: { fetch: async () => channel } };
  const client = { guilds: { cache: new Map([[config.guildId, guild]]) } };
  const ctx = { config, store };
  assert.equal(await removeClosedCase(ctx, client, closed), false); assert.equal(deleted, 0);
  store.prepareTranscript(dossier.id, [{ name: 'transcript.txt', content: 'Gesprek' }]);
  assert.equal(await removeClosedCase(ctx, client, closed), false); assert.equal(deleted, 0);
  store.finishTranscript(dossier.id);
  assert.equal(await removeClosedCase(ctx, client, closed), true); assert.equal(deleted, 1);
  assert.equal(store.pendingCaseCleanup(Date.now() + 120000).length, 0);
  await assert.rejects(removeClosedCase(ctx, client, { ...closed, status: 'open' }), /gesloten dossier/);
});

test('directe sollicitatie heeft de volledige template, statusknop en tickets vragen geen invoer', () => {
  const payload = caseMessages(config, { kind: 'application', id: 'abc', owner_id: 'member', payload: { template: true } });
  assert.equal(payload.length, 1);
  assert.equal(payload[0].embeds[0].toJSON().description, applicationTemplate);
  assert.equal(payload[0].components[0].toJSON().components.length, 5);
  const ticket = commands(500).find(cmd => cmd.name === 'ticket');
  assert.equal(ticket.options.find(option => option.name === 'openen').options?.length ?? 0, 0);
});

test('visvangsten geven geld naar zeldzaamheid, verliezen worden begrensd op het saldo', t => {
  assert.equal(catches.reduce((sum, item) => sum + item.weight, 0), 100);
  const store = new Store({ ...config, startingCoins: 10 }, ':memory:'); t.after(() => store.close());
  const common = store.fish('member', 0); assert.equal(common.change, 25); assert.equal(common.balance, 35);
  const legendary = store.fish('member', 50); assert.equal(legendary.change, 500); assert.equal(legendary.balance, 535);
  const unlucky = store.fish('poor', 60); assert.equal(unlucky.change, -10); assert.equal(unlucky.balance, 0); assert.match(unlucky.caught.text, /kreeft beet/i);
  assert.equal(store.fish('poor', 60).change, 0);
  assert.throws(() => store.fish('member', 100), RangeError); assert.equal(store.wallet('member').balance, 535);
  assert.equal(fishCatch(99).coins, 0);
});

test('blackjack-uitkomsten hebben verschillende kleuren zonder uitbetaling te veranderen', () => {
  for (const [credit, color] of [[250, 0x22C55E], [0, 0xEF4444], [100, 0xF59E0B]]) {
    const game = { status: 'done', player: ['AH', 'KS'], dealer: ['TH', '9S'], bet: 100, result: { credit, text: 'Uitslag' }, userId: 'member' };
    const card = blackjackMessage(config, { wallet: () => ({ balance: 1000 }) }, game);
    assert.equal(card.embeds[0].toJSON().color, color); assert.equal(card.components.length, 0);
  }
});

test('ledenlijst gebruikt hoogste rang, negeert bots en kan wijzigingen opnieuw indelen', () => {
  const roster = { ...base, ...base.guilds[0], roster: { channelId: 'channel', roleIds: ['chef', 'member', 'recruit'] } };
  const member = (id, ids, bot = false) => ({ id, displayName: id, user: { bot }, roles: { cache: new Map(ids.map(id => [id, {}])) } });
  const members = new Collection([['a', member('a', ['chef', 'member'])], ['b', member('b', ['recruit'])], ['c', member('c', ['member'], true)], ['d', member('d', [])]]);
  let groups = rosterGroups(roster, members);
  assert.equal(groups.get('chef').length, 1); assert.equal(groups.get('member').length, 0); assert.equal(groups.get('recruit').length, 1);
  members.get('b').roles.cache = new Map([['member', {}]]);
  groups = rosterGroups(roster, members); assert.equal(groups.get('recruit').length, 0); assert.equal(groups.get('member').length, 1);
  const guild = { members: { cache: members }, roles: { cache: new Map(roster.roster.roleIds.map(id => [id, { name: id }])) } };
  const cards = rosterCards(roster, guild); assert.ok(cards[0].embeds[0].toJSON().description.includes('2 leden'));
  assert.deepEqual(cards[0].allowedMentions.parse, []);
});

test('transcripts ontsleutelen in Web Crypto, verkeerde sleutel en gewijzigd dossier worden geweigerd', async () => {
  const source = '<!doctype html><p>Privé gesprek 🙂</p>';
  const encrypted = encryptTranscript(source);
  assert.ok(!JSON.stringify(encrypted.envelope).includes('Privé'));
  const key = await webcrypto.subtle.importKey('raw', Buffer.from(encrypted.key, 'base64url'), 'AES-GCM', false, ['decrypt']);
  const decrypt = id => webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(encrypted.envelope.iv, 'base64url'), additionalData: Buffer.from(id) }, key, Buffer.from(encrypted.envelope.data, 'base64url'));
  assert.equal(Buffer.from(await decrypt(encrypted.id)).toString(), source);
  await assert.rejects(decrypt('ander-dossier'));
  const view = { view_id: encrypted.id, secret_key: encrypted.key, envelope: encrypted.envelope };
  const viewerConfig = { transcriptSiteURL: 'https://example.com', transcriptSiteToken: 'private-access', transcriptUploadSecret: 'upload-key' };
  let called = false;
  const url = await publishTranscriptView(viewerConfig, view, async (url, options) => {
    called = true; assert.equal(url.hash, ''); assert.equal(url.origin, 'https://example.com');
    assert.equal(options.headers['OAI-Sites-Authorization'], 'Bearer private-access');
    assert.ok(!options.body.includes(encrypted.key)); assert.ok(!options.body.includes('Privé'));
    return Response.json({ id: encrypted.id });
  });
  assert.ok(called); assert.equal(new URL(url).hash, `#k=${encrypted.key}`); assert.ok(url.length < 512);
  assert.throws(() => transcriptViewURL({ transcriptSiteURL: 'http://example.com' }, view), /HTTPS/);
});
