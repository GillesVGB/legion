import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/index.js';
import { loadDashboardSettings, saveDashboardSettings } from '../src/dashboard/settings.js';
import { Store } from '../src/data/store.js';
import { syncBotBranding, logo, BRAND_COLOR } from '../src/ui/branding.js';
import { createTranscriptServer } from '../src/modules/transcripts/server.js';
import { Dashboard } from '../src/dashboard/server.js';
import { Locks } from '../src/common/locks.js';
import { renderTranscript } from '../src/modules/transcripts/html.js';
import { embed } from '../src/ui/messages.js';
import { dashboardFixture, ACTOR } from './dashboard-fixture.js';
import { publishAbsencePanel } from '../src/modules/absence/panel.js';

test('de rebrand opent dezelfde database en migreert opgeslagen teksten eenmalig zonder coins of warns te verliezen', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bakarov-migration-'));
  const base = loadConfig({ EMBED_COLOR: '#B91C1C' }, false),
    config = { ...base, ...base.guilds[0], dataDir: dir };
  let store = new Store(config),
    ctx = { config, store };
  store.wallet(ACTOR);
  store.addWarn(ACTOR, 'lead', 'Historisch bericht over Legion');
  store.setSetting(
    'dashboard-config',
    JSON.stringify({
      color: '#B91C1C',
      dailyCoins: 333,
      content: {
        gangName: 'Legion',
        coinName: 'Legion-coins',
        information: 'Welkom bij Legion. Betaal op tijd.',
      },
      operations: { gangpot: { weeklyAmount: 31000 } },
    }),
  );
  const before = store.wallet(ACTOR).balance;
  store.close();
  store = new Store(config);
  ctx = { config, store };
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  loadDashboardSettings(ctx);
  assert.equal(config.content.gangName, 'Bakarov');
  assert.equal(config.content.coinName, 'Bakarov-coins');
  assert.match(config.content.information, /Welkom bij Bakarov/);
  assert.equal(config.color, BRAND_COLOR);
  assert.equal(config.dailyCoins, 333);
  assert.equal(config.gangpot.weeklyAmount, 31000);
  assert.equal(store.wallet(ACTOR).balance, before);
  assert.equal(store.warnCount(ACTOR), 1);
  assert.equal(
    store.db.prepare('SELECT reason FROM warnings').get().reason,
    'Historisch bericht over Legion',
  );
  assert.ok(readdirSync(dir).includes(`legion-${config.guildId}.sqlite`));
  assert.ok(!readdirSync(dir).some((name) => name.startsWith('bakarov-')));
  saveDashboardSettings(
    ctx,
    { content: { tagline: 'Samen verder met Bakarov.' }, color: '#123456' },
    ACTOR,
  );
  loadDashboardSettings(ctx);
  assert.equal(config.color, 0x123456);
  assert.equal(config.content.tagline, 'Samen verder met Bakarov.');
  assert.equal(loadConfig({ EMBED_COLOR: '#123456' }, false).color, 0x123456);
});

test('profiel gebruikt de aangeleverde afbeelding als PNG, uploadt eenmaal en probeert een mislukte wijziging opnieuw', async (t) => {
  const f = dashboardFixture();
  t.after(f.close);
  let edits = 0,
    fail = true;
  const user = {
    id: '123',
    username: 'Legion',
    avatar: 'old',
    displayAvatarURL: () => `https://cdn.discordapp.com/avatars/123/${user.avatar}.png`,
    edit: async (update) => {
      edits++;
      if (fail) throw Object.assign(new Error('Tijdelijk'), { code: 503 });
      assert.equal(update.username, 'Bakarov');
      const bytes = Buffer.from(update.avatar.split(',')[1], 'base64');
      assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
      Object.assign(user, { username: update.username, avatar: 'new' });
      return user;
    },
  };
  await assert.rejects(syncBotBranding({ user }, f.contexts));
  fail = false;
  await syncBotBranding({ user }, f.contexts);
  await syncBotBranding({ user }, f.contexts);
  assert.equal(edits, 2);
  for (const ctx of f.contexts.values())
    assert.match(embed(ctx.config, 'Test', 'Welkom').toJSON().thumbnail.url, /avatars\/123\/new/);
});

test('dashboard en transcriptviewer serveren het originele logo zonder login; nieuwe transcriptbestanden werken met een ingesloten logo', async (t) => {
  const f = dashboardFixture();
  t.after(f.close);
  const dashboard = new Dashboard({ client: f.client, contexts: f.contexts, locks: new Locks() });
  const server = await createTranscriptServer(f.contexts, 0, dashboard);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(origin + '/dashboard/logo.webp');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/webp');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), logo);
  for (const path of ['/dashboard', '/t/' + 'a'.repeat(32)]) {
    const page = await fetch(origin + path),
      html = await page.text();
    assert.match(html, /Bakarov/);
    assert.match(html, /src="\/dashboard\/logo.webp"/);
    assert.doesNotMatch(html, /Legion|LEGION/);
    assert.match(page.headers.get('content-security-policy'), /img-src 'self' data:/);
  }
  const html = renderTranscript(
    { id: '1', name: 'Bakarov' },
    { id: '2', name: 'vraag-lid' },
    { id: 'abc', kind: 'ticket', status: 'closed', owner_id: '3', closed_by: '4', closed_at: 1 },
    [
      {
        id: '5',
        authorId: '3',
        author: 'Lid',
        created: 1,
        content: 'Ik schreef vroeger Legion.',
        attachments: [],
        embeds: [],
      },
    ],
  );
  assert.match(html, /src="data:image\/webp;base64,/);
  assert.match(html, /img-src data:/);
  assert.match(html, /Ik schreef vroeger Legion\./);
  assert.match(html, /<title>Bakarov/);
});

test('een oud afmeldpaneel wordt na verlies van het opgeslagen bericht-ID herkend en in hetzelfde bericht vernieuwd', async (t) => {
  const f = dashboardFixture();
  t.after(f.close);
  const ctx = f.contexts.values().next().value,
    guild = f.guilds.get(ctx.config.guildId),
    channel = guild.channels.cache.get(ctx.config.absencePanelChannelId);
  const old = await channel.send({
    embeds: [
      embed(ctx.config, 'Legion — Afmelden & afwezigheid', 'Oud paneel').setFooter({
        text: 'Legion • Afmeldingen',
      }),
    ],
  });
  old.embeds = old.embeds.map((card) => card.toJSON());
  let edits = 0,
    sends = 0;
  old.edit = async (payload) => {
    edits++;
    old.embeds = payload.embeds.map((card) => card.toJSON());
    return old;
  };
  channel.send = async () => {
    sends++;
    throw new Error('Mag geen tweede paneel plaatsen');
  };
  await publishAbsencePanel(ctx, guild);
  assert.equal(sends, 0);
  assert.equal(edits, 1);
  assert.match(old.embeds[0].title, /Bakarov/);
  assert.equal(ctx.store.setting(`absence:panel:${channel.id}`), old.id);
});
