import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {dashboardFixture,ACTOR,OTHER} from './dashboard-fixture.mjs';
import {removeGangpotExemptions,exemptionRemovalTime} from '../src/gangpot-policy.mjs';
import {createAbsence,decideAbsence,syncAbsenceExemptions,setExemption,exemptionFor,approvedAway} from '../src/absence.mjs';
import {gangpotWindow,gangpotRequired,gangpotMembers,gangpotTotalMessage,reconcileGangpotDebt,GANGPOT_LEAD_ROLE_ID} from '../src/gangpot.mjs';
import {gangpotIntroduction} from '../src/gangpot-membership.mjs';
import {commands} from '../src/commands.mjs';
import {Dashboard} from '../src/dashboard.mjs';
import {Locks} from '../src/locks.mjs';
function fixture(t){const f=dashboardFixture();t.after(f.close);const ctx=f.contexts.values().next().value,guild=f.guilds.get(ctx.config.guildId);ctx.guild=guild;guild.members.cache.get(OTHER).roles.cache.set(ctx.config.gangpot.memberRoleId,guild.roles.cache.get(ctx.config.gangpot.memberRoleId));return{...f,ctx,guild,db:ctx.store.db};}

test('bestaande vrijstellingen worden ingetrokken en blijven weg na herhaalde migratie en afmeldsynchronisatie',t=>{
 const f=fixture(t),now=Date.now(),period=gangpotWindow(f.ctx.config.gangpot,now);
 f.db.prepare('INSERT INTO gangpot_exemptions(id,user_id,period_id,actor_id,reason,created_at) VALUES(?,?,?,?,?,?)').run('old',OTHER,period.id,ACTOR,'Oude vrijstelling',now-1000);
 const cutoff=exemptionRemovalTime(f.ctx);removeGangpotExemptions(f.ctx.store,now);removeGangpotExemptions(f.ctx.store,now+1000);syncAbsenceExemptions(f.ctx,ACTOR,now+2000);
 const entry=f.db.prepare("SELECT * FROM gangpot_exemptions WHERE id='old'").get();assert.ok(entry.revoked_at);assert.match(entry.revoke_reason,/afgeschaft/);assert.equal(exemptionRemovalTime(f.ctx),cutoff);assert.equal(exemptionFor(f.ctx,OTHER,period.id),null);
 f.guild.members.cache.get(ACTOR).roles.cache.set(f.ctx.config.gangpot.memberRoleId,f.guild.roles.cache.get(f.ctx.config.gangpot.memberRoleId));
 assert.equal(gangpotRequired(f.ctx,f.guild.members.cache.get(ACTOR)),true);assert.ok(f.guild.members.cache.get(ACTOR).roles.cache.has(GANGPOT_LEAD_ROLE_ID));
 assert.equal(gangpotIntroduction(f.ctx,OTHER,period),null);
});

test('alleen een goedgekeurde langere afmelding geeft gangpotvrijstelling en blijft bruikbaar voor activiteiten',async t=>{
 const f=fixture(t),now=Date.now(),today=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Brussels'}).format(new Date(now));
 const request=await createAbsence(f.ctx,f.guild,OTHER,{start:today,end:today,reason:'Training'},now);
  const week=JSON.parse(request.weeks)[0];assert.equal(exemptionFor(f.ctx,OTHER,week),null);
 const approved=await decideAbsence(f.ctx,f.guild,f.guild.members.cache.get(ACTOR),request.id,'approve',now+1);
 assert.equal(approved.status,'approved');assert.ok(approvedAway(f.ctx,{id:'planning',starts_at:now},OTHER));
  assert.equal(exemptionFor(f.ctx,OTHER,week).id,request.id);
  removeGangpotExemptions(f.ctx.store,now+2);syncAbsenceExemptions(f.ctx,f.ctx.config.clientId,now+3);
  assert.equal(exemptionFor(f.ctx,OTHER,week).id,request.id);
  assert.equal(exemptionFor(f.ctx,OTHER,'2099-10-31'),null);
  const period=gangpotWindow(f.ctx.config.gangpot,now);
  f.db.prepare('INSERT INTO gangpot_periods(id,starts_at,ends_at,weekly_amount) VALUES(?,?,?,?)').run(period.id,period.starts_at,period.ends_at,period.weekly_amount);
  f.db.prepare('INSERT INTO gangpot_dues(period_id,user_id,enrolled_at,active) VALUES(?,?,?,1)').run(period.id,OTHER,now);
  assert.equal(gangpotMembers(f.ctx,period,now).find(item=>item.user_id===OTHER).status,'exempt');
  assert.match(gangpotTotalMessage(f.ctx,f.guild,now).embeds[0].toJSON().description,/Goedgekeurd afgemeld:\*\* 1/);
  const warnings=f.ctx.store.warnCount(OTHER);reconcileGangpotDebt(f.ctx,period.id,OTHER,f.ctx.config.clientId,period.ends_at+1);assert.equal(f.ctx.store.warnCount(OTHER),warnings);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM gangpot_exemptions WHERE revoked_at IS NULL').get().n,0);
 await assert.rejects(setExemption(f.ctx,f.guild,null,OTHER,'31-10-2026','Reden'),/afgeschaft/);
  f.db.prepare("UPDATE absence_requests SET kind='planning' WHERE id=?").run(request.id);assert.equal(exemptionFor(f.ctx,OTHER,week),null);
  f.db.prepare("UPDATE absence_requests SET kind='range',status='rejected' WHERE id=?").run(request.id);assert.equal(exemptionFor(f.ctx,OTHER,week),null);
});

test('de beleidswijziging geeft geen nieuwe warns voor verlopen weken en heractiveert geen ingetrokken warn',t=>{
 const f=fixture(t),now=Date.now(),period='2026-10-24';
 f.db.prepare('INSERT INTO gangpot_periods(id,starts_at,ends_at,weekly_amount,status) VALUES(?,?,?,?,?)').run(period,now-100000,now-10000,25000,'closed');
 f.db.prepare('INSERT INTO gangpot_dues(period_id,user_id,enrolled_at,active) VALUES(?,?,?,1)').run(period,OTHER,now-100000);
 const count=f.ctx.store.warnCount(OTHER);reconcileGangpotDebt(f.ctx,period,OTHER,ACTOR,now);assert.equal(f.ctx.store.warnCount(OTHER),count);
 f.db.prepare('INSERT INTO warnings(id,user_id,reason,actor_id,created_at,removed_at,removed_by,removed_reason) VALUES(?,?,?,?,?,?,?,?)').run('revoked',OTHER,'Gangpot t/m '+period,ACTOR,now-9000,now-8000,ACTOR,'Ingetrokken');
 f.db.prepare("UPDATE gangpot_dues SET warn_id='revoked',warn_cleared_by_payment=1 WHERE period_id=? AND user_id=?").run(period,OTHER);
 reconcileGangpotDebt(f.ctx,period,OTHER,ACTOR,now);assert.ok(f.db.prepare("SELECT removed_at FROM warnings WHERE id='revoked'").get().removed_at);
});

test('vrijstellingscommando’s en dashboardknoppen zijn verwijderd; afmelden blijft beschikbaar',t=>{
 const f=fixture(t),absence=commands(10000,false).find(item=>item.name==='afwezig');assert.deepEqual(absence.options.map(item=>item.name),['aanvragen','status']);
 const data=new Dashboard({...f,locks:new Locks()}).summary(f.ctx,f.guild),source=readFileSync(new URL('../src/dashboard-assets/app.js',import.meta.url),'utf8'),context=vm.createContext({data,Intl,Date,Number,String,Math,URL,console});
 vm.runInContext(source.slice(0,source.indexOf("document.addEventListener('click'"))+'\nstate.data=data;',context);
 const html=vm.runInContext('absencesPage()',context);assert.match(html,/Afwezigheid aanvragen/);assert.match(html,/goedgekeurde langere afmelding geeft gangpotvrijstelling/);assert.doesNotMatch(html,/Weekvrijstelling geven|Gangpotvrijstellingen|absence\.exempt-new|absence\.revoke-form/);
});

test('na een nieuwe deadline krijgen ook Lead en een nieuw lid zonder goedgekeurde afmelding één gangpotwarn',t=>{
 const f=fixture(t),now=Date.now(),period=gangpotWindow(f.ctx.config.gangpot,now);
 f.db.prepare('INSERT INTO gangpot_periods(id,starts_at,ends_at,weekly_amount) VALUES(?,?,?,?)').run(period.id,period.starts_at,period.ends_at,period.weekly_amount);
 f.guild.members.cache.get(ACTOR).roles.cache.set(f.ctx.config.gangpot.memberRoleId,f.guild.roles.cache.get(f.ctx.config.gangpot.memberRoleId));
 f.db.prepare('INSERT INTO gangpot_memberships(user_id,started_at,required_from,source) VALUES(?,?,?,?)').run(OTHER,now,period.ends_at,'role');
 f.db.prepare('INSERT INTO gangpot_exemptions(id,user_id,period_id,actor_id,reason,created_at) VALUES(?,?,?,?,?,?)').run('stale',OTHER,period.id,ACTOR,'Verouderde vrijstelling',now);
 for(const user of [ACTOR,OTHER]){
  f.db.prepare('INSERT INTO gangpot_dues(period_id,user_id,enrolled_at,active) VALUES(?,?,?,1)').run(period.id,user,now);
  const count=f.ctx.store.warnCount(user);reconcileGangpotDebt(f.ctx,period.id,user,f.ctx.config.clientId,period.ends_at+1);reconcileGangpotDebt(f.ctx,period.id,user,f.ctx.config.clientId,period.ends_at+2);
  assert.equal(f.ctx.store.warnCount(user),count+1);
 }
});
