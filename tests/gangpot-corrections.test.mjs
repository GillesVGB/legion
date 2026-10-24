import test from 'node:test';
import assert from 'node:assert/strict';
import {dashboardFixture,APPLICANT,OTHER} from './dashboard-fixture.mjs';
import {correctFronzyGangpotWarnings} from '../src/gangpot-corrections.mjs';

const NOW=Date.parse('2026-10-24T12:00:00Z'),FRONZY='100000000000000777',OTHER_ACTOR='100000000000000778';

test('trekt exact twee actieve gangpotwarns van Fronzy op 24 oktober in en bewaart de groene meldingen',async t=>{
  const f=dashboardFixture();t.after(f.close);t.mock.method(Date,'now',()=>NOW);
  const main=f.contexts.values().next().value,guild=f.guilds.get(main.config.guildId),fronzy=guild.addMember(FRONZY,'Fronzy',[]),other=guild.addMember(OTHER_ACTOR,'Ander lid',[]);
  const first=main.store.addWarn(OTHER,fronzy.id,'Gangpot niet betaald');
  const second=main.store.addWarn(APPLICANT,fronzy.id,'Geen gangpotbetaling ontvangen');
  const unrelated=main.store.addWarn('100000000000000020',other.id,'Gangpotcontrole, aparte zaak');
  const result=await correctFronzyGangpotWarnings(main,guild,f.client,NOW);
  assert.deepEqual(new Set(result),new Set([first.id,second.id]));
  assert.equal(main.store.warnCount(OTHER),0);assert.equal(main.store.warnCount(APPLICANT),0);
  assert.equal(main.store.db.prepare('SELECT removed_at FROM warnings WHERE id=?').get(unrelated.id).removed_at,null);
  assert.equal(main.store.db.prepare("SELECT COUNT(*) AS n FROM gangpot_notifications WHERE kind='revoke'").get().n,2);
  assert.deepEqual(await correctFronzyGangpotWarnings(main,guild,f.client,NOW),[]);
});

test('bij een ander aantal warns trekt de correctie niets in',async t=>{
  const f=dashboardFixture();t.after(f.close);t.mock.method(Date,'now',()=>NOW);
  const main=f.contexts.values().next().value,guild=f.guilds.get(main.config.guildId),fronzy=guild.addMember(FRONZY,'Fronzy',[]);
  const warning=main.store.addWarn(OTHER,fronzy.id,'Gangpot');
  assert.deepEqual(await correctFronzyGangpotWarnings(main,guild,f.client,NOW),[]);
  assert.equal(main.store.warnCount(OTHER),1);
  assert.equal(main.store.db.prepare('SELECT removed_at FROM warnings WHERE id=?').get(warning.id).removed_at,null);
});

test('een tijdelijke Discord-storing verbruikt de correctie niet en een volgende synchronisatie kan haar uitvoeren',async t=>{
  const f=dashboardFixture();t.after(f.close);t.mock.method(Date,'now',()=>NOW);
  const main=f.contexts.values().next().value,guild=f.guilds.get(main.config.guildId);
  main.store.addWarn(OTHER,FRONZY,'Gangpot niet betaald');main.store.addWarn(APPLICANT,FRONZY,'Gangpot ontbreekt');
  guild.members.fetch=async()=>{throw new Error('tijdelijke Discord-storing');};
  f.client.users={fetch:async()=>{throw new Error('tijdelijke Discord-storing');}};
  await correctFronzyGangpotWarnings(main,guild,f.client,NOW);
  assert.equal(main.store.setting('gangpot:fronzy-correction:2026-10-24'),undefined);
  guild.addMember(FRONZY,'Fronzy',[]);
  assert.equal((await correctFronzyGangpotWarnings(main,guild,f.client,NOW)).length,2);
});
