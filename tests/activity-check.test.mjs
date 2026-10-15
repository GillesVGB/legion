import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {dashboardFixture,ACTOR,OTHER} from './dashboard-fixture.mjs';
import {Store} from '../src/store.mjs';
import {createActivity,handlePlanningAutocomplete,handlePlanningCommand,syncActivities} from '../src/activities.mjs';
import {checkActivity,syncActivityWarnings} from '../src/activity-check.mjs';
import {commands} from '../src/commands.mjs';

const NOW=Date.parse('2026-10-10T10:00:00Z'),START=Date.parse('2026-10-12T18:00:00Z');
async function fixture(t,filename){
  t.mock.method(Date,'now',()=>NOW);
  const f=dashboardFixture();t.after(()=>f.close());const ctx=f.contexts.values().next().value,guild=f.guilds.get(ctx.config.guildId),lead=guild.members.cache.get(ACTOR);
  if(filename){ctx.store.close();ctx.store=new Store(ctx.config,filename);}
  for(const member of guild.members.cache.values())member.roles.cache.delete(ctx.config.memberRoleId);
  const ids=[OTHER,...Array.from({length:8},(_,i)=>String(BigInt('100000000000000020')+BigInt(i)))];
  for(const id of ids)guild.members.cache.get(id).roles.cache.set(ctx.config.memberRoleId,guild.roles.cache.get(ctx.config.memberRoleId));
  const result=await createActivity(ctx,{guild,user:lead.user,member:lead,memberPermissions:lead.permissions},{date:'12-10-2026',time:'20:00',location:'HQ'},NOW);
  const activity=ctx.store.db.prepare('SELECT * FROM activities WHERE id=?').get(result.id),message=guild.channels.cache.get(activity.channel_id).posted.get(activity.message_id);
  const react=(id,emoji='🟢')=>message.reactions.cache.get(emoji).users.cache.set(id,guild.members.cache.get(id).user);
  const absence=(user,status='approved',kind='planning')=>ctx.store.db.prepare('INSERT INTO absence_requests(id,user_id,kind,activity_id,start_date,end_date,weeks,reason,status,created_at,channel_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(`abs-${user}-${kind}`,user,kind,kind==='planning'?activity.id:null,kind==='range'?'2026-10-12':null,kind==='range'?'2026-10-13':null,'[]','Privéreden',status,NOW,ctx.config.logChannelId);
  return{...f,ctx,guild,lead,ids,activity,message,react,absence};
}

test('activiteitencheck accepteert alle vier reacties en goedgekeurde afmeldingen; alleen gangleden zonder reactie krijgen een warn',async t=>{
  const f=await fixture(t),{ids}=f;
  for(const [i,emoji] of ['🟢','🕒','🔴','🟠'].entries())f.react(ids[i],emoji);
  f.absence(ids[4]);f.absence(ids[5],'approved','range');f.absence(ids[6],'pending');f.absence(ids[7],'rejected');
  const robot=f.guild.addMember('100000000000000088','Bot',[f.ctx.config.memberRoleId],false,true);
  const newcomer=f.guild.addMember('100000000000000089','Nieuw',[f.ctx.config.memberRoleId]);newcomer.joinedTimestamp=START+1;
  const result=await checkActivity(f.ctx,f.guild,f.lead,f.activity.id,START);
  assert.equal(result.total,9);assert.equal(result.responded,4);assert.equal(result.exempt,2);assert.equal(result.newWarnings.length,3);
  for(const id of ids.slice(6))assert.equal(f.ctx.store.warnCount(id),1);
  assert.equal(f.ctx.store.warnCount(robot.id),0);assert.equal(f.ctx.store.warnCount(newcomer.id),0);assert.equal(f.ctx.store.warnCount(ACTOR),0);
  assert.equal(f.ctx.store.db.prepare("SELECT COUNT(*) AS n FROM feature_notices WHERE kind='activity.warn'").get().n,3);
});

test('gelijktijdig controleren en handmatig intrekken geven nooit een tweede warn voor dezelfde activiteit',async t=>{
  const f=await fixture(t);const results=await Promise.all([checkActivity(f.ctx,f.guild,f.lead,f.activity.id,START),checkActivity(f.ctx,f.guild,f.lead,f.activity.id,START)]);
  assert.deepEqual(results.map(item=>item.newWarnings.length).sort((a,b)=>a-b),[0,9]);
  const warning=f.ctx.store.warnings(OTHER)[0];f.ctx.store.removeWarn(warning.id,ACTOR,'Handmatige correctie');
  const again=await checkActivity(f.ctx,f.guild,f.lead,f.activity.id,START+1000);assert.equal(again.newWarnings.length,0);assert.equal(again.alreadyWarned,9);assert.equal(f.ctx.store.warnCount(OTHER),0);
});

test('voor de starttijd, bij geannuleerde planning, in de community en zonder leidingrechten worden geen warns gegeven',async t=>{
  const f=await fixture(t);
  await assert.rejects(checkActivity(f.ctx,f.guild,f.lead,f.activity.id,START-1),/starttijd/);
  await assert.rejects(checkActivity(f.ctx,f.guild,f.guild.members.cache.get(OTHER),f.activity.id,START),/leiding/);
  await assert.rejects(checkActivity(f.source,f.guild,f.lead,f.activity.id,START),/gangserver/);
  await assert.rejects(checkActivity(f.ctx,f.guild,f.lead,'unknown12345',START),/bestaat niet/);
  f.ctx.store.db.prepare("UPDATE activities SET status='cancelled' WHERE id=?").run(f.activity.id);
  await assert.rejects(checkActivity(f.ctx,f.guild,f.lead,f.activity.id,START),/geannuleerd/);
  assert.equal(f.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM activity_check_warnings').get().n,0);
});

test('Discordreacties worden opnieuw gelezen voor een afgelopen planning; een oude DB-reactie zonder echte reactie telt niet',async t=>{
  const f=await fixture(t);f.ctx.store.db.prepare("UPDATE activities SET status='ended' WHERE id=?").run(f.activity.id);
  f.react(OTHER);f.ctx.store.db.prepare("INSERT INTO activity_rsvps VALUES(?,?,'yes',?)").run(f.activity.id,f.ids[1],NOW);
  const result=await checkActivity(f.ctx,f.guild,f.lead,f.activity.id,START+86400000);
  assert.equal(result.responded,1);assert.equal(f.ctx.store.warnCount(OTHER),0);assert.equal(f.ctx.store.warnCount(f.ids[1]),1);
});

test('onbereikbare leden of ontbrekend planningbericht stoppen de volledige controle zonder warns',async t=>{
  const f=await fixture(t),list=f.guild.members.list;
  f.guild.members.list=async()=>{throw new Error('Netwerkfout');};
  await assert.rejects(checkActivity(f.ctx,f.guild,f.lead,f.activity.id,START),/Netwerkfout/);f.guild.members.list=list;
  const reaction=f.message.reactions.cache.get('🟠'),fetch=reaction.users.fetch;reaction.users.fetch=async()=>{throw new Error('Reactiefout');};
  await assert.rejects(checkActivity(f.ctx,f.guild,f.lead,f.activity.id,START),/Reactiefout/);reaction.users.fetch=fetch;
  f.guild.channels.cache.get(f.activity.channel_id).posted.delete(f.activity.message_id);
  await assert.rejects(checkActivity(f.ctx,f.guild,f.lead,f.activity.id,START),/planningbericht/);
  assert.equal(f.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM activity_check_warnings').get().n,0);
});

test('warnlog en DM worden herhaald na een storing, en verstuurde logs worden na een crash teruggevonden',async t=>{
  const f=await fixture(t);for(const id of f.ids.slice(1))f.react(id);await checkActivity(f.ctx,f.guild,f.lead,f.activity.id,START);
  const channel=f.guild.channels.cache.get(f.ctx.config.warnLogChannelId),send=channel.send,user=f.guild.members.cache.get(OTHER).user,dm=user.send;
  channel.send=async()=>{throw Object.assign(new Error('Tijdelijk'),{code:503});};user.send=async()=>{throw Object.assign(new Error('Tijdelijk'),{code:503});};
  await syncActivityWarnings(f.ctx,f.guild,START);assert.equal(channel.posted.size,0);
  channel.send=send;user.send=dm;await syncActivityWarnings(f.ctx,f.guild,START+61000);await syncActivityWarnings(f.ctx,f.guild,START+62000);
  assert.equal(channel.posted.size,1);assert.equal(f.calls.filter(item=>item.method==='dm'&&item.user===OTHER).length,1);
  f.ctx.store.db.prepare('UPDATE activity_check_warnings SET log_id=NULL').run();await syncActivityWarnings(f.ctx,f.guild,START+63000);assert.equal(channel.posted.size,1);
});

test('een geblokkeerde DM spamt niet en de botstatus bewaart de warn gewoon',async t=>{
  const f=await fixture(t);for(const id of f.ids.slice(1))f.react(id);await checkActivity(f.ctx,f.guild,f.lead,f.activity.id,START);
  let attempts=0;f.guild.members.cache.get(OTHER).user.send=async()=>{attempts++;throw Object.assign(new Error('Geblokkeerd'),{code:50007});};
  await syncActivityWarnings(f.ctx,f.guild,START);await syncActivityWarnings(f.ctx,f.guild,START+61000);
  assert.equal(attempts,1);assert.equal(f.ctx.store.warnCount(OTHER),1);assert.equal(f.ctx.store.db.prepare("SELECT status FROM feature_notices WHERE kind='activity.warn'").get().status,'blocked');
});

test('controle blijft na database-herstart eenmalig; bestaande warns en planning blijven bewaard',async t=>{
  const folder=mkdtempSync(join(tmpdir(),'legion-activity-check-'));
  const filename=join(folder,'check.sqlite'),f=await fixture(t,filename);t.after(()=>rmSync(folder,{recursive:true,force:true}));await checkActivity(f.ctx,f.guild,f.lead,f.activity.id,START);
  f.ctx.store.close();f.ctx.store=new Store(f.ctx.config,filename);
  const result=await checkActivity(f.ctx,f.guild,f.lead,f.activity.id,START+1000);assert.equal(result.newWarnings.length,0);assert.equal(result.alreadyWarned,9);assert.equal(f.ctx.store.warnCount(OTHER),1);
});

test('activiteitencheck staat alleen in de hoofdserver en werkt met autocomplete en een privé commandantwoord',async t=>{
  const f=await fixture(t);t.mock.method(Date,'now',()=>START);
  assert.ok(commands(500,false).some(item=>item.name==='activiteitencheck'));assert.ok(!commands(500,true).some(item=>item.name==='activiteitencheck'));
  let choices;await handlePlanningAutocomplete(f.ctx,{commandName:'activiteitencheck',member:f.lead,memberPermissions:f.lead.permissions,options:{getFocused:()=>({name:'planning',value:''})},respond:async value=>{choices=value;}},START);assert.equal(choices[0].value,f.activity.id);
  let reply,flags;await handlePlanningCommand(f.ctx,{guild:f.guild,commandName:'activiteitencheck',member:f.lead,memberPermissions:f.lead.permissions,options:{getString:()=>f.activity.id},deferReply:async value=>{flags=value.flags;},editReply:async value=>{reply=value;}});
  assert.equal(flags,64);assert.ok(reply.content.includes('**Nieuwe gangwarns:** 9'));assert.deepEqual(reply.allowedMentions.parse,[]);
});

test('de periodieke planningtaak verstuurt alleen wachtende meldingen en geeft zelf geen nieuwe warns',async t=>{
  const f=await fixture(t);await syncActivities(f.ctx,f.guild,START+86400000);assert.equal(f.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM activity_check_warnings').get().n,0);
});
