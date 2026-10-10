import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, GatewayIntentBits, IntentsBitField, PermissionsBitField, PermissionFlagsBits as P } from 'discord.js';
import { Store } from '../src/store.mjs';
import { loadConfig } from '../src/config.mjs';
import { applicationFields, applicationSteps, applicationText, validateApplicationStep } from '../src/application.mjs';
import { applicationModal, caseMessages, safeText } from '../src/ui.mjs';
import { transcriptDocuments, splitUTF8, fetchTranscriptMessages, archiveTranscript } from '../src/transcripts.mjs';
import { warnLogChannel } from '../src/service.mjs';
import { recruitmentState, requireApplicationsOpen, requireRecruitmentSpace, countRecruitment } from '../src/recruitment.mjs';

const base = loadConfig({}, false);
const config = { ...base, ...base.guilds[1] };
const memory = options => new Store({ ...config, ...options }, ':memory:');
const stepAnswers = step => Object.fromEntries(applicationSteps[step].map(field => [field.id, field.id === 'age' ? '18' : `${field.label} antwoord`]));

test('de sollicitatie bevat exact de twaalf opgegeven vragen in drie Discord-formulieren', () => {
  assert.deepEqual(applicationFields.map(field => field.label), ['Naam', 'Leeftijd', 'Playtime', 'Voertuigen', 'Geld', 'Wapens', 'OW-ervaring', 'Motivatie', '3 goede eigenschappen', '3 minder goede eigenschappen', 'Waarom kies je voor Legion?', 'Wat kunnen wij van jou verwachten?']);
  assert.deepEqual(applicationSteps.map(step => step.length), [5, 5, 2]);
  for (let step = 0; step < 3; step++) {
    const modal = applicationModal({ id: 'test', step, revision: step, answers: {} }).toJSON();
    assert.equal(modal.components.length, applicationSteps[step].length);
    assert.ok(modal.components.every(row => row.components[0].label.length <= 45));
  }
  const text = applicationText({});
  assert.ok(text.startsWith('## Legion — Sollicitatie'));
  assert.ok(text.includes('Bedankt voor je tijd en moeite. We nemen je sollicitatie zo snel mogelijk door.'));
});

test('formulieren bewaren voortgang en blokkeren andere gebruikers, verlopen en dubbele stappen', t => {
  const store = memory(); t.after(() => store.close());
  const start = store.beginApplication('applicant', 1000);
  assert.equal(store.beginApplication('applicant', 1001).id, start.id);
  assert.throws(() => store.advanceApplication(start.id, 'other', 0, 0, stepAnswers(0), 1001), /ander lid/);
  assert.throws(() => store.advanceApplication(start.id, 'applicant', 0, 0, {}, 1001), /Naam/);
  const next = store.advanceApplication(start.id, 'applicant', 0, 0, stepAnswers(0), 1002);
  assert.equal(next.step, 1);
  assert.equal(next.answers.name, 'Naam antwoord');
  assert.throws(() => store.advanceApplication(start.id, 'applicant', 0, 0, stepAnswers(0), 1003), /al opgeslagen/);
  const second = store.advanceApplication(start.id, 'applicant', 1, 1, stepAnswers(1), 1003);
  const ready = store.advanceApplication(start.id, 'applicant', 2, 2, stepAnswers(2), 1004);
  assert.equal(second.step, 2); assert.equal(ready.step, 3);
  assert.equal(Object.keys(ready.answers).length, 12);
  assert.equal(store.applicationDraft(start.id, 'applicant', ready.expires), null);
});

test('volledige antwoorden blijven zichtbaar en passen ook bij markdown binnen embedlimieten', () => {
  const payload = Object.fromEntries(applicationFields.map(field => [field.id, '*'.repeat(field.max)]));
  const messages = caseMessages(config, { kind: 'application', id: 'abc', owner_id: 'member', payload });
  assert.equal(messages.length, 3);
  const allFields = messages.flatMap(message => message.embeds[0].toJSON().fields);
  for (const field of applicationFields) {
    const combined = allFields.filter(item => item.name === field.label || item.name === `${field.label} (vervolg)`).map(item => item.value).join('');
    assert.equal(combined, safeText(payload[field.id]));
  }
  for (const message of messages) {
    const card = message.embeds[0].toJSON();
    assert.ok(card.fields.every(field => field.value.length <= 1024));
    const length = card.title.length + card.description.length + card.footer.text.length + card.fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0);
    assert.ok(length <= 6000);
  }
  assert.equal(messages[0].components.length, 0);
  assert.equal(messages[2].components[0].toJSON().components.length, 5);
});

test('transcripts worden alleen in de community-guild naar de juiste kanalen ingepland', t => {
  const a = memory(base.guilds[0]); const b = memory();
  t.after(() => { a.close(); b.close(); });
  assert.throws(()=>a.reserveCase('application','member',{}),/communityserver/);
  // Historische dossiers blijven afhandelbaar, ook al mag deze guild geen nieuwe meer aanmaken.
  a.db.prepare("INSERT INTO cases(id,kind,owner_id,status,payload,created_at) VALUES('legacy-main','application','member','open','{}',?)").run(Date.now());
  const first = a.caseById('legacy-main');
  a.closeCase(first.id, 'accepted', 'staff');
  assert.equal(a.pendingTranscripts().length, 0);
  for (const [kind, target, status] of [['application', '1555746237582409789', 'rejected'], ['ticket', '1555747964461260861', 'closed']]) {
    const dossier = b.reserveCase(kind, kind, {});
    b.closeCase(dossier.id, status, 'staff');
    assert.equal(b.transcript(dossier.id).channel_id, target);
    assert.throws(() => b.closeCase(dossier.id, status, 'staff'), /al afgehandeld/);
  }
  assert.equal(b.pendingTranscripts().length, 2);
});

test('berichten worden over meerdere paginas volledig en chronologisch opgehaald', async () => {
  const records = Array.from({ length: 230 }, (_, index) => ({ id: String(index + 1), createdTimestamp: index + 1, content: `bericht ${index + 1}`, author: { id: 'member', tag: 'Lid' }, embeds: [], attachments: new Collection() }));
  let requests = 0;
  const channel = { messages: { fetch: async options => {
    requests++;
    const last = options.before ? Number(options.before) - 1 : records.length;
    return new Collection(records.slice(Math.max(0, last - 100), last).reverse().map(message => [message.id, message]));
  } } };
  const fetched = await fetchTranscriptMessages(channel, 229);
  assert.equal(requests, 3); assert.equal(fetched.length, 229);
  assert.equal(fetched[0].content, 'bericht 1'); assert.equal(fetched.at(-1).content, 'bericht 229');
});

test('transcripts bevatten antwoorden, bijlagen en veilige HTML zonder uitvoerbare gebruikerscode', () => {
  const dossier = { kind: 'application', id: 'abc', owner_id: 'member', closed_by: 'staff', closed_at: 1000, status: 'accepted', payload: Object.fromEntries(applicationFields.map(field => [field.id, 'Voorbeeld'])) };
  const documents = transcriptDocuments({ id: 'guild', name: 'Legion' }, { id: 'channel', name: 'sollicitatie' }, dossier, [{ id: '1', created: 999, author: '<script>alert(1)</script>', authorId: 'member', content: '<img src=x onerror=alert(1)>', embeds: [], attachments: [{ name: 'bewijs.png', url: 'https://cdn.discordapp.com/test' }] }]);
  assert.ok(documents.text.includes('OW-ervaring')); assert.ok(documents.text.includes('bewijs.png'));
  assert.ok(documents.html.includes('&lt;script&gt;')); assert.ok(!documents.html.includes('<script>'));
  assert.ok(!documents.html.includes('<img src=x')); assert.ok(documents.html.includes('Content-Security-Policy'));
  const original = '🙂hé漢字'.repeat(300);
  const parts = splitUTF8(original, 101);
  assert.equal(parts.join(''), original);
  assert.ok(parts.every(part => Buffer.byteLength(part) <= 101));
});

test('mislukte transcriptuploads hervatten zonder reeds verstuurde bestanden te dupliceren', async t => {
  const config = { ...base, ...base.guilds[1], transcriptViewerMode: 'files' };
  const store = memory(); t.after(() => store.close());
  const dossier = store.reserveCase('ticket', 'member', { subject: 'Vraag' });
  store.bindCase(dossier.id, 'source'); store.openCase(dossier.id, 'intro'); store.closeCase(dossier.id, 'closed', 'staff');
  const guild = { id: config.guildId, name: 'Legion', members: { me: { id: 'bot' } } };
  let uploads = 0; let sourceReads = 0; const posted = [];
  const source = { id: 'source', name: 'ticket', isTextBased: () => true, messages: { fetch: async () => { sourceReads++; return new Collection(); } } };
  const target = { id: config.ticketTranscriptChannelId, guildId: config.guildId, guild,
    isTextBased: () => true, permissionsFor: () => new PermissionsBitField(P.AttachFiles),
    messages: { fetch: async () => new Collection(posted.map(message => [message.id, message])) },
    send: async payload => {
      uploads++;
      if (uploads === 2) throw Object.assign(new Error('test'), { code: 'TEST_UPLOAD' });
      const message = { id: String(uploads), author: { id: 'bot' }, embeds: payload.embeds.map(card => card.toJSON()) };
      posted.push(message); return message;
    }
  };
  guild.channels = { fetch: async () => source };
  const client = { user: { id: 'bot' }, options: { intents: new IntentsBitField(GatewayIntentBits.MessageContent) }, channels: { fetch: async () => target }, guilds: { cache: new Map([[config.guildId, guild]]) } };
  assert.equal(await archiveTranscript({ store, config }, client, dossier.id, async () => {}), false);
  assert.equal(store.transcript(dossier.id).message_ids.length, 1);
  assert.equal(store.transcript(dossier.id).state, 'ready');
  assert.equal(await archiveTranscript({ store, config }, client, dossier.id, async () => {}), true);
  assert.equal(store.transcript(dossier.id).state, 'done');
  assert.equal(sourceReads, 1); assert.equal(posted.length, 2); assert.equal(uploads, 3);
  assert.equal(await archiveTranscript({ store, config }, client, dossier.id, async () => {}), true);
  assert.equal(uploads, 3);
});

test('gangwarnkanaal moet in de juiste guild staan en botrechten hebben', async () => {
  const target = { guildId: base.guilds[0].guildId, type: 0, permissionsFor: () => new PermissionsBitField([P.ViewChannel, P.SendMessages, P.EmbedLinks]) };
  const guild = { id: base.guilds[0].guildId, channels: { fetch: async () => target }, members: { me: {} } };
  assert.equal(await warnLogChannel(guild, base.guilds[0]), target);
  target.guildId = base.guilds[1].guildId;
  await assert.rejects(warnLogChannel(guild, base.guilds[0]), /andere guild/);
});

test('statusgrenzen zijn groen tot 19, oranje vanaf 20 en rood vanaf 25', () => {
  for (const [count, icon, closed] of [[0, '🟢', false], [19, '🟢', false], [20, '🟠', false], [24, '🟠', false], [25, '🔴', false], [30, '🔴', false]]) {
    assert.equal(recruitmentState(count).icon, icon);
    assert.equal(recruitmentState(count).closed, closed);
  }
  assert.equal(recruitmentState(null).closed, true);
  requireApplicationsOpen({ config, recruitment: recruitmentState(25) });
  assert.throws(() => requireRecruitmentSpace({ config, recruitment: recruitmentState(25) }), /zit vol/);
  requireRecruitmentSpace({ config, recruitment: recruitmentState(24) });
  assert.throws(() => requireApplicationsOpen({ config, recruitment: recruitmentState(null) }), /gecontroleerd/);
  requireApplicationsOpen({ config, recruitment: recruitmentState(24) });
});

test('ledenstand telt alleen mensen met de community-ledenrol', () => {
  const cache = new Collection([
    ['a', { user: { bot: false }, roles: { cache: new Map([[config.memberRoleId, {}]]) } }],
    ['b', { user: { bot: false }, roles: { cache: new Map() } }],
    ['c', { user: { bot: true }, roles: { cache: new Map([[config.memberRoleId, {}]]) } }]
  ]);
  const ctx = { config };
  assert.equal(countRecruitment(ctx, { members: { cache } }).count, 1);
});

test('leeftijd blijft gecontroleerd en het rode paneel laat solliciteren bij 25 leden toe met een wachttijdmelding', async () => {
  assert.match(validateApplicationStep(0, { ...stepAnswers(0), age: '15' }), /minimale leeftijd/);
  assert.equal(validateApplicationStep(0, { ...stepAnswers(0), age: '16 jaar' }), null);
  assert.match(validateApplicationStep(0, { ...stepAnswers(0), age: 'onbekend' }), /hele jaren/);
  const { panel } = await import('../src/ui.mjs');
  const open = panel(config, 'alles', recruitmentState(20));
  const full = panel(config, 'alles', recruitmentState(25));
  assert.equal(open.components[0].toJSON().components.find(button => button.custom_id === 'application:new').disabled, false);
  assert.equal(full.components[0].toJSON().components.find(button => button.custom_id === 'application:new').disabled, false);
  assert.equal(full.components[0].toJSON().components.find(button => button.custom_id === 'ticket:new').disabled ?? false, false);
  assert.ok(full.embeds[0].toJSON().description.includes('We kijken niet alleen naar je huidige niveau'));
  assert.ok(full.embeds[0].toJSON().fields[0].name.includes('🔴 Vol'));
  assert.match(full.embeds[0].toJSON().fields[0].value, /bekijken.*langer duren/);
});
