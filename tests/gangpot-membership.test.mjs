import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {dashboardFixture,ACTOR,OTHER} from './dashboard-fixture.mjs';
import {Store} from '../src/store.mjs';
import {gangpotWindow,syncGangpot,gangpotMembers,gangpotStatusMessage,trackGangpotMembership,reportGangpotPayment,reviewGangpotPayment,removeGangpotPayment,gangpotPaid,gangpotBalance} from '../src/gangpot.mjs';

const START=Date.parse('2026-10-10T10:00:00Z'),MID=START+3*86400000,END=Date.parse('2026-10-17T22:00:00Z'),NEW='100000000000000078';
function fixture(t){
  const f=dashboardFixture();t.after(f.close);const ctx=f.contexts.values().next().value,guild=f.guilds.get(ctx.config.guildId);
  return{...f,ctx,guild,role:ctx.config.gangpot.memberRoleId};
}
const period=(f,date='2026-10-17')=>f.ctx.store.db.prepare('SELECT * FROM gangpot_periods WHERE id=?').get(date);
const member=(f,id=NEW)=>gangpotMembers(f.ctx,period(f),MID).find(item=>item.user_id===id);
const activeWarns=(f,id=NEW)=>f.ctx.store.db.prepare('SELECT * FROM warnings WHERE user_id=? AND removed_at IS NULL').all(id);

test('nieuwe Discord-toetreding is bij eerste start vrijgesteld; bestaande leden behouden hun betaalplicht',async t=>{
  const f=fixture(t),newcomer=f.guild.addMember(NEW,'Nieuw lid',[f.role]);newcomer.joinedTimestamp=MID-1000;
  await syncGangpot(f.ctx,f.client,MID);
  assert.equal(member(f).status,'exempt');assert.equal(member(f).newMember,true);assert.equal(member(f).requiredFrom,END);assert.equal(member(f).remaining,0);
  const oldId=[...f.guild.members.cache.values()].find(person=>!person.user.bot&&person.id!==NEW&&person.roles.cache.has(f.role)).id;
  assert.equal(member(f,oldId).exempt,false);
  await syncGangpot(f.ctx,f.client,END);
  assert.equal(activeWarns(f).length,0);assert.equal(activeWarns(f,oldId).length,1);
  const status=gangpotStatusMessage(f.ctx,NEW,END).embeds[0].toJSON().description;
  assert.ok(!status.includes('Dit is je instapweek')); // The first full term is now due.
  await syncGangpot(f.ctx,f.client,END+7*86400000);assert.equal(activeWarns(f).length,1);
});

test('een bestaande Discord-bezoeker die de ledenrol krijgt heeft een instapweek, ook bij gemiste rolevents',async t=>{
  const f=fixture(t),newcomer=f.guild.addMember(NEW,'Lang in Discord, nieuw in de gang',[]);newcomer.joinedTimestamp=START-180*86400000;
  await syncGangpot(f.ctx,f.client,START);newcomer.roles.cache.set(f.role,{});
  await syncGangpot(f.ctx,f.client,MID);
  assert.equal(member(f).newMember,true);assert.equal(member(f).requiredFrom,END);
  assert.match(gangpotStatusMessage(f.ctx,NEW,MID).embeds[0].toJSON().description,/instapweek/);
  await syncGangpot(f.ctx,f.client,END);assert.equal(activeWarns(f).length,0);
});

test('roltoekenning blijft bij SQLite-herstart bewaard en rol weghalen/teruggeven herstart de vrijstelling niet',async t=>{
  const f=fixture(t),dir=mkdtempSync(join(tmpdir(),'bakarov-membership-')),path=join(dir,'guild.sqlite');
  t.after(()=>{assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep+'bakarov-membership-'));rmSync(dir,{recursive:true,force:true});});
  f.ctx.store.close();f.ctx.store=new Store(f.ctx.config,path);
  const newcomer=f.guild.addMember(NEW,'Nieuw lid',[]),before={user:newcomer.user,roles:{cache:new Map()}};
  newcomer.roles.cache.set(f.role,{});trackGangpotMembership(f.ctx,before,newcomer,MID);
  await syncGangpot(f.ctx,f.client,MID);assert.equal(member(f).requiredFrom,END);
  f.ctx.store.close();f.ctx.store=new Store(f.ctx.config,path);await syncGangpot(f.ctx,f.client,END);
  newcomer.roles.cache.delete(f.role);await syncGangpot(f.ctx,f.client,END+1000);
  newcomer.roles.cache.set(f.role,{});trackGangpotMembership(f.ctx,before,newcomer,END+2000);
  await syncGangpot(f.ctx,f.client,END+2000);
  const membership=f.ctx.store.db.prepare('SELECT * FROM gangpot_memberships WHERE user_id=?').get(NEW);
  assert.equal(membership.required_from,END);assert.equal(membership.started_at,MID);
  await syncGangpot(f.ctx,f.client,END+7*86400000);assert.equal(activeWarns(f).length,1);
});

test('instapweek krijgt geen betaalherinnering of warn bij afkeuren of verwijderen van een vrijwillige betaling',async t=>{
  const f=fixture(t),newcomer=f.guild.addMember(NEW,'Nieuw lid',[f.role]);newcomer.joinedTimestamp=MID;
  await syncGangpot(f.ctx,f.client,MID);
  const claim=reportGangpotPayment(f.ctx,{userId:NEW,periodId:period(f).id,amount:25000,requestId:'intro-voluntary-payment'},MID);
  await reviewGangpotPayment(f.ctx,f.guild,f.guild.members.cache.get(ACTOR),claim.id,'reject',()=>MID+1000);
  const voluntary=reportGangpotPayment(f.ctx,{userId:NEW,periodId:period(f).id,amount:25000,requestId:'intro-voluntary-approved'},MID+2000);
  await reviewGangpotPayment(f.ctx,f.guild,f.guild.members.cache.get(ACTOR),voluntary.id,'approve',()=>MID+3000);
  assert.equal(gangpotBalance(f.ctx),25000);
  removeGangpotPayment(f.ctx,{userId:NEW,periodId:period(f).id,actor:ACTOR,requestId:'intro-voluntary-removal',reason:'Verkeerde registratie'},MID+4000);
  await syncGangpot(f.ctx,f.client,Date.parse('2026-10-17T18:30:00Z'));
  assert.equal(f.ctx.store.db.prepare("SELECT COUNT(*) AS n FROM feature_notices WHERE user_id=? AND kind='gangpot.member'").get(NEW).n,0);
  await syncGangpot(f.ctx,f.client,END);assert.equal(activeWarns(f).length,0);assert.equal(gangpotBalance(f.ctx),0);
  assert.equal(gangpotPaid(f.ctx,period(f),NEW).total,0);
});

test('aantoonbare instapweek corrigeert alleen de automatische gangpotwarn en annuleert wachtende rode meldingen',async t=>{
  const f=fixture(t),newcomer=f.guild.addMember(NEW,'Lid sinds woensdag',[f.role]);newcomer.joinedTimestamp=MID;
  const window=gangpotWindow(f.ctx.config.gangpot,START);
  f.ctx.store.db.prepare('INSERT INTO gangpot_periods(id,starts_at,ends_at,weekly_amount) VALUES(?,?,?,?)').run(window.id,window.starts_at,window.ends_at,25000);
  const automatic=f.ctx.store.addWarnInside(NEW,f.ctx.config.clientId,'Gangpot t/m 2026-10-17: geen betaling.',END);
  const manual=f.ctx.store.addWarnInside(NEW,ACTOR,'Andere gangafspraak niet nagekomen.',END);
  f.ctx.store.db.prepare('INSERT INTO gangpot_dues(period_id,user_id,enrolled_at,warn_id) VALUES(?,?,?,?)').run(window.id,NEW,MID+1000,automatic.id);
  f.ctx.store.db.prepare('INSERT INTO gangpot_notifications(id,user_id,period_id,warn_id,kind,message) VALUES(?,?,?,?,?,?)').run('old-red',NEW,window.id,automatic.id,'issue','Oude rode melding');
  await syncGangpot(f.ctx,f.client,END+1000);
  const warning=f.ctx.store.db.prepare('SELECT * FROM warnings WHERE id=?').get(automatic.id);
  assert.ok(warning.removed_at);assert.match(warning.removed_reason,/instapweek/);assert.equal(activeWarns(f)[0].id,manual.id);
  assert.equal(f.ctx.store.db.prepare("SELECT log_id FROM gangpot_notifications WHERE id='old-red'").get().log_id,'skipped');
  assert.equal(f.ctx.store.db.prepare("SELECT COUNT(*) AS n FROM gangpot_notifications WHERE warn_id=? AND kind='revoke'").get(automatic.id).n,1);
  await syncGangpot(f.ctx,f.client,END+2000);assert.equal(f.ctx.store.db.prepare("SELECT COUNT(*) AS n FROM gangpot_notifications WHERE warn_id=? AND kind='revoke'").get(automatic.id).n,1);
});

test('oude roltoekenning levert bewijs voor instapweek; bestaande verplichtingen krijgen geen algemene vrijstelling',async t=>{
  const f=fixture(t),newcomer=f.guild.addMember(NEW,'Oude Discord-bezoeker',[f.role]);newcomer.joinedTimestamp=START-300*86400000;
  f.ctx.store.db.prepare('INSERT INTO audit(event,actor_id,details,created_at) VALUES(?,?,?,?)').run('member.update','',JSON.stringify({user:NEW,added:[f.role],removed:[]}),MID);
  await syncGangpot(f.ctx,f.client,MID+1000);assert.equal(member(f).newMember,true);assert.equal(member(f).requiredFrom,END);
  const established=f.guild.addMember(OTHER,'Bestaand ganglid',[f.role]);established.joinedTimestamp=START-300*86400000;
  f.ctx.store.db.prepare('INSERT INTO gangpot_dues(period_id,user_id,enrolled_at) VALUES(?,?,?)').run(period(f).id,OTHER,START);
  f.ctx.store.db.prepare('INSERT INTO audit(event,actor_id,details,created_at) VALUES(?,?,?,?)').run('member.update','',JSON.stringify({user:OTHER,added:[f.role],removed:[]}),MID);
  await syncGangpot(f.ctx,f.client,MID+2000);assert.equal(member(f,OTHER).newMember,false);
  await syncGangpot(f.ctx,f.client,END);assert.equal(activeWarns(f).length,0);assert.equal(activeWarns(f,OTHER).length,1);
});

test('een lid precies op de startgrens heeft een volledige termijn; wintertijd verandert de instapvrijstelling niet',async t=>{
  const f=fixture(t),start=Date.parse('2026-10-24T22:00:00Z'),newcomer=f.guild.addMember(NEW,'Nieuw rond wintertijd',[f.role]);
  newcomer.joinedTimestamp=start+1000;await syncGangpot(f.ctx,f.client,start+2000);
  const window=gangpotWindow(f.ctx.config.gangpot,start+2000),row=gangpotMembers(f.ctx,window,start+2000).find(person=>person.user_id===NEW);
  assert.equal(row.requiredFrom,window.ends_at);assert.equal(window.ends_at-start,169*3600000);
  const boundary=f.guild.addMember(OTHER,'Precies bij nieuwe termijn',[f.role]);boundary.joinedTimestamp=start;
  trackGangpotMembership(f.ctx,{user:boundary.user,roles:{cache:new Map()}},boundary,start);
  await syncGangpot(f.ctx,f.client,start+3000);
  assert.equal(gangpotMembers(f.ctx,window,start+3000).find(person=>person.user_id===OTHER).newMember,false);
});

test('rol opnieuw geven vóór de eerste migratiesynchronisatie wist een bestaande betaalplicht niet',async t=>{
  const f=fixture(t),window=gangpotWindow(f.ctx.config.gangpot,START),established=f.guild.addMember(NEW,'Bestaand lid',[f.role]);
  f.ctx.store.db.prepare('INSERT INTO gangpot_periods(id,starts_at,ends_at,weekly_amount) VALUES(?,?,?,?)').run(window.id,window.starts_at,window.ends_at,25000);
  f.ctx.store.db.prepare('INSERT INTO gangpot_dues(period_id,user_id,enrolled_at) VALUES(?,?,?)').run(window.id,NEW,START);
  trackGangpotMembership(f.ctx,{user:established.user,roles:{cache:new Map()}},established,MID);
  await syncGangpot(f.ctx,f.client,MID);assert.equal(member(f).newMember,false);
  await syncGangpot(f.ctx,f.client,END);assert.equal(activeWarns(f).length,1);
});

function acceptNewcomer(f,{at=MID,status='accepted',target=f.ctx.config.guildId}={}){
  const newcomer=f.guild.addMember(NEW,'Recent aangenomen',[f.role]);newcomer.joinedTimestamp=START-180*86400000;
  const application=f.source.store.reserveCase('application',NEW,{template:true});
  f.source.store.bindCase(application.id,'100000000000000188');f.source.store.openCase(application.id,'100000000000000189');f.source.store.closeCase(application.id,'accepted',ACTOR);
  f.source.store.db.prepare('UPDATE cases SET closed_at=?,status=? WHERE id=?').run(at,status,application.id);
  f.source.store.db.prepare('UPDATE acceptance_notifications SET target_guild_id=? WHERE case_id=?').run(target,application.id);
  return application;
}

test('opgeslagen aanname corrigeert een oude instapwarn met groene kanaalmelding en DM, ook bij een inactieve oude inschrijving',async t=>{
  const f=fixture(t);acceptNewcomer(f);
  await syncGangpot(f.ctx,f.client,MID+1000);assert.equal(member(f).newMember,false);
  await syncGangpot(f.ctx,f.client,END);const automatic=activeWarns(f)[0];assert.ok(automatic);
  const manual=f.ctx.store.addWarnInside(NEW,ACTOR,'Andere gangafspraak overtreden.',END+1);
  f.ctx.store.db.prepare('UPDATE gangpot_dues SET active=0 WHERE period_id=? AND user_id=?').run('2026-10-17',NEW);
  await syncGangpot(f.ctx,f.client,END+1000,f.contexts);
  assert.deepEqual(activeWarns(f).map(warn=>warn.id),[manual.id]);
  assert.match(f.ctx.store.db.prepare('SELECT removed_reason FROM warnings WHERE id=?').get(automatic.id).removed_reason,/instapweek/);
  const channel=f.guild.channels.cache.get(f.ctx.config.warnLogChannelId),corrections=[...channel.posted.values()].filter(post=>post.embeds.some(card=>card.color===0x22C55E&&card.description.includes(automatic.id)));
  assert.equal(corrections.length,1);assert.ok(corrections[0].embeds[0].description.includes(`<@${NEW}>`));
  const dmCount=()=>f.calls.filter(call=>call.method==='dm'&&call.user===NEW&&call.payload.embeds?.some(card=>card.toJSON().color===0x22C55E)).length;
  assert.equal(dmCount(),1);await syncGangpot(f.ctx,f.client,END+2000,f.contexts);assert.equal(dmCount(),1);
  assert.equal(f.ctx.store.db.prepare('SELECT source FROM gangpot_memberships WHERE user_id=?').get(NEW).source,'admission');
  await syncGangpot(f.ctx,f.client,END+7*86400000,f.contexts);
  assert.equal(activeWarns(f).length,2); // The manual warn and the next full-term gangpotwarn.
});

test('een aanname geeft oudere leden geen nieuwe instapweek en trekt handmatige warns niet in',async t=>{
  const f=fixture(t);acceptNewcomer(f);
  f.ctx.store.db.prepare("INSERT INTO gangpot_periods(id,starts_at,ends_at,weekly_amount,status) VALUES('2026-10-10',?,?,25000,'closed')").run(START-8*86400000,START-1000);
  f.ctx.store.db.prepare("INSERT INTO gangpot_dues(period_id,user_id,enrolled_at,active) VALUES('2026-10-10',?,?,0)").run(NEW,START-7*86400000);
  await syncGangpot(f.ctx,f.client,MID+1000);await syncGangpot(f.ctx,f.client,END,f.contexts);
  assert.equal(activeWarns(f).length,1);assert.equal(member(f).newMember,false);
  const warning=activeWarns(f)[0];f.ctx.store.db.prepare('UPDATE warnings SET actor_id=? WHERE id=?').run(ACTOR,warning.id);
  f.ctx.store.db.prepare("DELETE FROM gangpot_dues WHERE period_id='2026-10-10'").run();
  await syncGangpot(f.ctx,f.client,END+1000,f.contexts);assert.equal(activeWarns(f)[0].id,warning.id);
});

test('afgewezen aanvragen en aannames voor een andere server zijn geen bewijs voor een gangpot-intrekking',async t=>{
  for(const input of [{status:'rejected'},{target:'999999999999999999'},{at:END+86400000}]){
    const f=fixture(t);acceptNewcomer(f,input);
    await syncGangpot(f.ctx,f.client,MID+1000);await syncGangpot(f.ctx,f.client,END,f.contexts);
    assert.equal(activeWarns(f).length,1);assert.equal(member(f).newMember,false);
  }
});
