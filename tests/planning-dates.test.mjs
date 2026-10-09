import test from 'node:test';
import assert from 'node:assert/strict';
import {planningTime,planningDateSuggestions,handlePlanningAutocomplete,createActivity,activityById} from '../src/activities.mjs';
import {commands} from '../src/commands.mjs';
import {dashboardFixture,ACTOR} from './dashboard-fixture.mjs';

test('planning accepteert een vaste datum, deze avond en morgenavond met dezelfde opgegeven tijd',()=>{
  const now=Date.parse('2026-10-09T12:00:00Z');
  assert.equal(planningTime('09-10-2026','20:30',now),Date.parse('2026-10-09T18:30:00Z'));
  assert.equal(planningTime('deze avond','20:30',now),Date.parse('2026-10-09T18:30:00Z'));
  assert.equal(planningTime('  DEZE   AVOND  ','20:30',now),Date.parse('2026-10-09T18:30:00Z'));
  assert.equal(planningTime('morgenavond','20:30',now),Date.parse('2026-10-10T18:30:00Z'));
  assert.equal(planningTime('Morgen avond','20:30',now),Date.parse('2026-10-10T18:30:00Z'));
});
test('relatieve dagen volgen Belgische middernacht, zomer- en wintertijd en de jaarwisseling',()=>{
  const midnight=Date.parse('2026-10-09T23:30:00Z');
  assert.equal(planningTime('deze avond','20:30',midnight),Date.parse('2026-10-10T18:30:00Z'));
  assert.equal(planningTime('morgenavond','20:30',midnight),Date.parse('2026-10-11T18:30:00Z'));
  assert.equal(planningTime('morgenavond','20:30',Date.parse('2026-03-28T22:30:00Z')),Date.parse('2026-03-29T18:30:00Z'));
  assert.equal(planningTime('morgenavond','20:30',Date.parse('2026-10-24T21:30:00Z')),Date.parse('2026-10-25T19:30:00Z'));
  assert.equal(planningTime('morgenavond','20:30',Date.parse('2026-12-31T22:30:00Z')),Date.parse('2027-01-01T19:30:00Z'));
});
test('autocomplete stelt beide avonden voor en laat een zelf ingevoerde datum toe',async()=>{
  const now=Date.parse('2026-10-09T12:00:00Z');
  assert.deepEqual(planningDateSuggestions('',now).map(item=>item.value),['deze avond','morgenavond']);
  assert.deepEqual(planningDateSuggestions('morgen',now).map(item=>item.value),['morgenavond']);
  assert.equal(planningDateSuggestions('12-10-2026',now)[0].value,'12-10-2026');
  assert.deepEqual(planningDateSuggestions('31-02-2026',now),[]);
  let response;const interaction={options:{getFocused:()=>({name:'datum',value:'morgen'})},respond:async choices=>response=choices};
  await handlePlanningAutocomplete({config:{guildId:'1555685630640652338',planningChannelId:'1555685633266163793'}},interaction,now);
  assert.equal(response[0].value,'morgenavond');
  await handlePlanningAutocomplete({config:{guildId:'1555726440933363753',planningChannelId:''}},interaction,now);assert.deepEqual(response,[]);
  const field=commands(500,false).find(command=>command.name==='planning').options.find(option=>option.name==='datum');
  assert.equal(field.autocomplete,true);assert.ok(field.max_length>='morgenavond'.length);
});
test('morgenavond wordt als concrete datum opgeslagen en een voorbij tijdstip schuift niet stilzwijgend door',async t=>{
  const f=dashboardFixture();t.after(f.close);
  const ctx=f.contexts.values().next().value,guild=f.guilds.get(ctx.config.guildId),member=guild.members.cache.get(ACTOR);
  const interaction={guild,guildId:guild.id,channelId:ctx.config.logChannelId,user:member.user,member,memberPermissions:member.permissions};
  const now=Date.parse('2026-10-09T20:00:00Z');
  await assert.rejects(createActivity(ctx,interaction,{date:'deze avond',time:'20:30',location:'Legion HQ'},now),/toekomst/);
  const result=await createActivity(ctx,interaction,{date:'morgenavond',time:'20:30',location:'Legion HQ'},now);
  assert.equal(activityById(ctx,result.id).starts_at,Date.parse('2026-10-10T18:30:00Z'));
  assert.ok(result.posted.content.includes('10/10/2026'));assert.equal(result.posted.embeds.length,0);
});
