import test from 'node:test';
import assert from 'node:assert/strict';
import {dashboardFixture,ACTOR,OTHER} from './dashboard-fixture.mjs';
import {createAbsence,decideAbsence,setExemption,exemptionFor,absenceMessage} from '../src/absence.mjs';
import {syncGangpot} from '../src/gangpot.mjs';
import {createActivity} from '../src/activities.mjs';
import {recognizedAbsenceReason} from '../src/absence-reasons.mjs';
const NOW=Date.parse('2026-10-10T10:00:00Z'),END=Date.parse('2026-10-16T22:00:00Z');
async function fixture(t){const f=dashboardFixture();t.after(f.close);const ctx=f.contexts.values().next().value,guild=f.guilds.get(ctx.config.guildId),lead=guild.members.cache.get(ACTOR);guild.members.cache.get(OTHER).roles.cache.set(ctx.config.gangpot.memberRoleId,guild.roles.cache.get(ctx.config.gangpot.memberRoleId));await syncGangpot(ctx,f.client,NOW);const activity=await createActivity(ctx,{guild,user:lead.user,member:lead,memberPermissions:lead.permissions},{date:'12-10-2026',time:'20:00',location:'HQ'},NOW);return{...f,ctx,guild,lead,activity};}
const active=f=>f.ctx.store.db.prepare("SELECT * FROM warnings WHERE user_id=? AND reason LIKE 'Gangpot t/m %' AND removed_at IS NULL").all(OTHER);
test('herkent duidelijke redenen, laat onbekende en ontkende redenen bij Lead',()=>{
  for(const reason of ['PC kapot','training','hobby','gym','school','Kan niet vanwege werk'])assert.equal(recognizedAbsenceReason(reason),true,reason);
  for(const reason of ['geen zin','geen school','pc is niet kapot','misschien','Afmelding via de rode reactie. Het lid kan toelichten met /afmelden.'])assert.equal(recognizedAbsenceReason(reason),false,reason);
});
test('reden is verplicht; botgoedkeuring planning geeft nooit gangpotvrijstelling, ook na refresh',async t=>{
  const f=await fixture(t);
  const placeholder=await createAbsence(f.ctx,f.guild,OTHER,{activityId:f.activity.id,automatic:true,reason:'Afmelding via de rode reactie. Het lid kan toelichten met /afmelden.'},NOW);
  await assert.rejects(decideAbsence(f.ctx,f.guild,f.lead,placeholder.id,'approve',NOW),/eerst een reden/);
  assert.equal(absenceMessage(f.ctx,placeholder).components[0].components[0].data.disabled,true);
  const approved=await createAbsence(f.ctx,f.guild,OTHER,{activityId:f.activity.id,reason:'PC kapot'},NOW+1);
  assert.equal(approved.status,'approved');assert.equal(approved.reviewer_id,f.guild.members.me.id);assert.equal(approved.id,placeholder.id);
  await syncGangpot(f.ctx,f.client,END);assert.equal(exemptionFor(f.ctx,OTHER,'2026-10-16'),undefined);assert.equal(active(f).length,1);
  assert.doesNotMatch(absenceMessage(f.ctx,approved).embeds[0].data.description,/gangpotvrijstelling/);
});
test('Lead kan botgoedkeuring intrekken en herhaalde aanvraag passeert Lead daarna niet meer',async t=>{
  const f=await fixture(t);const approved=await createAbsence(f.ctx,f.guild,OTHER,{activityId:f.activity.id,reason:'training'},NOW);
  assert.equal((await decideAbsence(f.ctx,f.guild,f.lead,approved.id,'reject',NOW+1)).status,'rejected');
  const retry=await createAbsence(f.ctx,f.guild,OTHER,{activityId:f.activity.id,reason:'school'},NOW+2);assert.equal(retry.status,'pending');
  await assert.rejects(decideAbsence(f.ctx,f.guild,f.guild.members.cache.get(OTHER),retry.id,'approve',NOW+3),/Alleen Lead/);
});
test('automatische goedkeuring kan uit; onbekende redenen blijven in behandeling',async t=>{
  const f=await fixture(t);f.ctx.config.operations={planning:{autoApproveAbsences:false}};
  assert.equal((await createAbsence(f.ctx,f.guild,OTHER,{activityId:f.activity.id,reason:'school'},NOW)).status,'pending');
  f.ctx.config.operations.planning.autoApproveAbsences=true;
  assert.equal((await createAbsence(f.ctx,f.guild,OTHER,{activityId:f.activity.id,reason:'iets anders'},NOW+1)).status,'pending');
});
test('ontbrekende vrijstelling bij goedgekeurde afwezigheid trekt uitsluitend betaalwarn in, met groene log; handmatige intrekking blijft bewaard',async t=>{
  const f=await fixture(t);const absence=await createAbsence(f.ctx,f.guild,OTHER,{start:'12-10-2026',end:'14-10-2026',reason:'Vakantie'},NOW);
  await decideAbsence(f.ctx,f.guild,f.lead,absence.id,'approve',NOW+1);
  // Simulate a legacy approval whose exemption row was never stored.
  f.ctx.store.db.prepare('DELETE FROM gangpot_exemptions WHERE request_id=?').run(absence.id);
  const manual=f.ctx.store.addWarn(OTHER,ACTOR,'Handmatige overtreding');
  const warning=f.ctx.store.addWarnInside(OTHER,f.guild.members.me.id,'Gangpot t/m 2026-10-16: ontbreekt',END);
  f.ctx.store.db.prepare('UPDATE gangpot_dues SET warn_id=? WHERE user_id=? AND period_id=?').run(warning.id,OTHER,'2026-10-16');
  await syncGangpot(f.ctx,f.client,END+1);await syncGangpot(f.ctx,f.client,END+2);
  assert.equal(active(f).length,0);assert.ok(exemptionFor(f.ctx,OTHER,'2026-10-16'));
  assert.equal(f.ctx.store.db.prepare('SELECT removed_at FROM warnings WHERE id=?').get(manual.id).removed_at,null);
  const logs=[...f.guild.channels.cache.get(f.ctx.config.warnLogChannelId).posted.values()];assert.ok(logs.some(post=>post.embeds.some(card=>card.color===0x22C55E)));
  await setExemption(f.ctx,f.guild,f.lead,OTHER,'16-10-2026','Lead heeft vrijstelling ingetrokken',true,END+3);await syncGangpot(f.ctx,f.client,END+4);
  assert.equal(exemptionFor(f.ctx,OTHER,'2026-10-17'),undefined);assert.equal(active(f)[0].id,warning.id);
});
