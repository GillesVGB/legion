import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {dashboardFixture,ACTOR,OTHER} from './dashboard-fixture.mjs';
import {Store} from '../src/store.mjs';
import {createActivityCheck,respondActivityCheck,finishActivityCheck,cancelActivityCheck,syncActivityChecks,syncActivityWarnings,activityCheckMessage,handleActivitiesCheck,handleActivityCheckReaction,publishActivityCheck,syncCheckReminders} from '../src/activity-check.mjs';
import {commands} from '../src/commands.mjs';
import {Dashboard} from '../src/dashboard.mjs';
import {Locks} from '../src/locks.mjs';
import {PermissionFlagsBits as P,PermissionsBitField} from 'discord.js';
import {saveDashboardSettings} from '../src/dashboard-settings.mjs';
const NOW=Date.parse('2026-10-15T10:00:00Z'),DEADLINE=Date.parse('2026-10-16T18:00:00Z');
function fixture(t,filename){
  t.mock.method(Date,'now',()=>NOW);
  const f=dashboardFixture();t.after(()=>f.close());const ctx=f.contexts.values().next().value,guild=f.guilds.get(ctx.config.guildId),lead=guild.members.cache.get(ACTOR);
  if(filename){ctx.store.close();ctx.store=new Store(ctx.config,filename);}
  ctx.store.db.prepare('DELETE FROM warnings').run();
  for(const member of guild.members.cache.values())member.roles.cache.delete(ctx.config.memberRoleId);
  const ids=[OTHER,...Array.from({length:5},(_,i)=>String(BigInt('100000000000000020')+BigInt(i)))];
  for(const id of ids)guild.members.cache.get(id).roles.cache.set(ctx.config.memberRoleId,guild.roles.cache.get(ctx.config.memberRoleId));
  const channel=guild.channels.cache.get(ctx.config.planningChannelId),permissions=channel.permissionsFor;
  channel.permissionsFor=target=>target?.roles?.cache?.has(ctx.config.memberRoleId)?new PermissionsBitField([P.ViewChannel,P.ReadMessageHistory]):permissions(target);
  const start=(input={},now=NOW)=>createActivityCheck(ctx,guild,lead,{date:'morgenavond',time:'20:00',channelId:ctx.config.planningChannelId,...input},now);
  const answer=(check,user=OTHER,now=NOW+1000,binding={channelId:check.channel_id,messageId:check.message_id})=>respondActivityCheck(ctx,guild,guild.members.cache.get(user),check.id,binding,now);
  const absence=(user,status='approved',kind='range')=>ctx.store.db.prepare('INSERT INTO absence_requests(id,user_id,kind,activity_id,start_date,end_date,weeks,reason,status,created_at,channel_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(`absence-${user}-${kind}`,user,kind,kind==='planning'?'some-planning':null,'2026-10-16','2026-10-17','[]','Privéreden',status,NOW,ctx.config.logChannelId);
  const record=id=>ctx.store.db.prepare('SELECT * FROM activity_check_sessions WHERE id=?').get(id);
  return{...f,ctx,guild,lead,ids,start,answer,absence,record};
}
test('activiteitencheck is een zelfstandige check-in met deadline en vinkjesreactie, zonder planning of presencevereiste',async t=>{
  const f=fixture(t),{check,posted}=await f.start();
  assert.equal(check.deadline_at,DEADLINE);assert.equal(posted.components.length,0);assert.equal(posted.reactions.cache.get('✅').me,true);
  assert.equal(f.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM activities').get().n,0);
  assert.equal(f.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM activity_check_members').get().n,6);
  assert.ok(posted.embeds[0].description.includes('automatisch één gangwarn'));
  const command=commands(500,false).find(item=>item.name==='activiteitencheck');assert.deepEqual(command.options.map(item=>item.name),['datum','tijd','kanaal']);assert.ok(!commands(500,true).some(item=>item.name==='activiteitencheck'));
  await assert.rejects(f.start(),/al een activiteitencheck/);
});
test('tijdige bevestiging telt eenmaal; niet reageren geeft automatisch precies één gangwarn na de deadline',async t=>{
  const f=fixture(t),{check}=await f.start();assert.equal(await f.answer(check),true);assert.equal(await f.answer(check),false);
  await syncActivityChecks(f.ctx,f.guild,DEADLINE-1);assert.equal(f.ctx.store.warnCount(f.ids[1]),0);
  await syncActivityChecks(f.ctx,f.guild,DEADLINE);await syncActivityChecks(f.ctx,f.guild,DEADLINE+60000);
  assert.equal(f.ctx.store.warnCount(OTHER),0);assert.equal(f.ctx.store.warnCount(f.ids[1]),1);assert.equal(f.record(check.id).status,'closed');
  assert.equal(f.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM activity_check_warnings').get().n,5);
  assert.equal(f.calls.filter(item=>item.method==='dm'&&item.payload.embeds?.[0]?.title==='Legion — Gangwarn: activiteitencheck').length,5);
  assert.equal(f.guild.channels.cache.get(f.ctx.config.warnLogChannelId).posted.size,5);
  const post=f.guild.channels.cache.get(check.channel_id).posted.get(check.message_id);assert.equal(post.components.length,0);
});
test('goedgekeurde langere afwezigheid geeft vrijstelling; pending, afgewezen en losse planningafmelding niet',async t=>{
  const f=fixture(t),{check}=await f.start();f.absence(OTHER);f.absence(f.ids[1],'pending');f.absence(f.ids[2],'rejected');f.absence(f.ids[3],'approved','planning');
  await finishActivityCheck(f.ctx,f.guild,check.id,DEADLINE);
  assert.equal(f.ctx.store.warnCount(OTHER),0);for(const id of f.ids.slice(1))assert.equal(f.ctx.store.warnCount(id),1);
  assert.equal(f.ctx.store.db.prepare('SELECT status FROM activity_check_members WHERE check_id=? AND user_id=?').get(check.id,OTHER).status,'exempt');
});
test('nieuwe leden, bezoekers, bots, vertrokken leden en verloren ledenrol geven geen valse gangwarn',async t=>{
  const f=fixture(t);f.guild.addMember('100000000000000081','Robot',[f.ctx.config.memberRoleId],false,true);const {check}=await f.start();
  const newcomer=f.guild.addMember('100000000000000082','Nieuw',[f.ctx.config.memberRoleId]);await assert.rejects(f.answer(check,newcomer.id),/na het starten/);
  f.guild.members.cache.delete(OTHER);f.guild.members.cache.get(f.ids[1]).roles.cache.delete(f.ctx.config.memberRoleId);
  await finishActivityCheck(f.ctx,f.guild,check.id,DEADLINE);assert.equal(f.ctx.store.warnCount(OTHER),0);assert.equal(f.ctx.store.warnCount(f.ids[1]),0);assert.equal(f.ctx.store.warnCount(newcomer.id),0);assert.equal(f.ctx.store.warnCount('100000000000000081'),0);
  assert.equal(f.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM activity_check_warnings').get().n,4);
});
test('verlopen, gekopieerde en onbevoegde check-in-acties worden geweigerd',async t=>{
  const f=fixture(t),{check}=await f.start();
  await assert.rejects(f.answer(check,OTHER,DEADLINE),/deadline/);
  await assert.rejects(f.answer(check,OTHER,NOW+1000,{channelId:'wrong',messageId:check.message_id}),/reactie/);
  await assert.rejects(cancelActivityCheck(f.ctx,f.guild,f.guild.members.cache.get(OTHER),check.id),/leiding/);
  await assert.rejects(createActivityCheck(f.source,f.guild,f.lead,{date:'morgenavond',time:'20:00',channelId:check.channel_id},NOW),/gangserver/);
  await assert.rejects(f.start({date:'15-10-2026',time:'11:00'}),/deadline/);
  await assert.rejects(f.start({date:'31-02-2026'}));
});
test('annuleren stopt de automatische warns en maakt ruimte voor een nieuwe check-in',async t=>{
  const f=fixture(t),{check}=await f.start();await cancelActivityCheck(f.ctx,f.guild,f.lead,check.id);await syncActivityChecks(f.ctx,f.guild,DEADLINE);
  assert.equal(f.record(check.id).status,'cancelled');assert.equal(f.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM activity_check_warnings').get().n,0);
  const next=await f.start();assert.notEqual(next.check.id,check.id);
});
test('bij een ledenstoring worden geen warns opgeslagen en de controle wordt automatisch herhaald',async t=>{
  const f=fixture(t),{check}=await f.start(),list=f.guild.members.list;
  f.guild.members.list=async()=>{throw Object.assign(new Error('Offline'),{code:503});};await syncActivityChecks(f.ctx,f.guild,DEADLINE);
  assert.equal(f.record(check.id).status,'open');assert.equal(f.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM activity_check_warnings').get().n,0);
  f.guild.members.list=list;await syncActivityChecks(f.ctx,f.guild,DEADLINE+61000);assert.equal(f.record(check.id).status,'closed');assert.equal(f.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM activity_check_warnings').get().n,6);
});
test('een verwijderde of niet tijdig gepubliceerde check-in geeft geen gangwarns',async t=>{
  const f=fixture(t),{check}=await f.start();f.guild.channels.cache.get(check.channel_id).posted.delete(check.message_id);
  await syncActivityChecks(f.ctx,f.guild,DEADLINE);assert.equal(f.record(check.id).status,'cancelled');assert.equal(f.ctx.store.warnCount(OTHER),0);
  const channel=f.guild.channels.cache.get(check.channel_id);channel.send=async()=>{throw Object.assign(new Error('Offline'),{code:503});};const next=await f.start();assert.equal(next.posted,null);
  await syncActivityChecks(f.ctx,f.guild,DEADLINE+61000);assert.equal(f.record(next.check.id).status,'cancelled');assert.equal(f.ctx.store.warnCount(OTHER),0);
});
test('open check-in en bevestigingen blijven bij een SQLite-herstart bewaard zonder dubbele warns',async t=>{
  const folder=mkdtempSync(join(tmpdir(),'legion-checkin-')),filename=join(folder,'check.sqlite'),f=fixture(t,filename);t.after(()=>rmSync(folder,{recursive:true,force:true}));
  const {check}=await f.start();await f.answer(check);f.ctx.store.close();f.ctx.store=new Store(f.ctx.config,filename);
  await syncActivityChecks(f.ctx,f.guild,DEADLINE);f.ctx.store.close();f.ctx.store=new Store(f.ctx.config,filename);await syncActivityChecks(f.ctx,f.guild,DEADLINE+60000);
  assert.equal(f.ctx.store.warnCount(OTHER),0);assert.equal(f.ctx.store.warnCount(f.ids[1]),1);assert.equal(f.guild.channels.cache.get(check.channel_id).posted.size,1);
});
test('gelijktijdig afronden en dubbele bevestigingen blijven eenmalig; handmatig ingetrokken warns keren niet terug',async t=>{
  const f=fixture(t),{check}=await f.start();await Promise.all([f.answer(check),f.answer(check)]);
  await Promise.all([finishActivityCheck(f.ctx,f.guild,check.id,DEADLINE),finishActivityCheck(f.ctx,f.guild,check.id,DEADLINE)]);
  const warning=f.ctx.store.warnings(f.ids[1])[0];f.ctx.store.removeWarn(warning.id,ACTOR,'Correctie');await syncActivityChecks(f.ctx,f.guild,DEADLINE+60000);assert.equal(f.ctx.store.warnCount(f.ids[1]),0);assert.equal(f.ctx.store.warnCount(f.ids[2]),1);
});
test('warnmeldingen herstellen na storingen zonder spam en geblokkeerde DMs worden niet eindeloos herhaald',async t=>{
  const f=fixture(t),{check}=await f.start();for(const id of f.ids.slice(1))await f.answer(check,id);await finishActivityCheck(f.ctx,f.guild,check.id,DEADLINE);
  const channel=f.guild.channels.cache.get(f.ctx.config.warnLogChannelId),send=channel.send;channel.send=async()=>{throw Object.assign(new Error('Offline'),{code:503});};
  let attempts=0;f.guild.members.cache.get(OTHER).user.send=async()=>{attempts++;throw Object.assign(new Error('Geblokkeerd'),{code:50007});};await syncActivityWarnings(f.ctx,f.guild,DEADLINE);channel.send=send;
  await syncActivityWarnings(f.ctx,f.guild,DEADLINE+61000);await syncActivityWarnings(f.ctx,f.guild,DEADLINE+62000);assert.equal(channel.posted.size,1);assert.equal(attempts,1);
  f.ctx.store.db.prepare('UPDATE activity_check_warnings SET log_id=NULL').run();await syncActivityWarnings(f.ctx,f.guild,DEADLINE+63000);assert.equal(channel.posted.size,1);
});
test('commando antwoordt privé, vinkje bevestigt activiteit en dashboard kan de aparte check-in starten, volgen en annuleren',async t=>{
  const f=fixture(t);let reply;await handleActivitiesCheck(f.ctx,{guild:f.guild,member:f.lead,memberPermissions:f.lead.permissions,channelId:f.ctx.config.planningChannelId,options:{getString:name=>name==='datum'?'morgenavond':'20:00',getChannel:()=>null},deferReply:async value=>assert.equal(value.flags,64),editReply:async value=>{reply=value;}});assert.ok(reply.content.includes('automatisch'));
  const check=f.ctx.store.db.prepare('SELECT * FROM activity_check_sessions').get();const reaction=f.guild.channels.cache.get(check.channel_id).posted.get(check.message_id).reactions.cache.get('✅');reaction.users.cache.set(OTHER,f.guild.members.cache.get(OTHER).user);await handleActivityCheckReaction(f.ctx,reaction,f.guild.members.cache.get(OTHER).user,true,NOW+1000);
  const dashboard=new Dashboard({...f,locks:new Locks()}),summary=dashboard.summary(f.ctx,f.guild,f.lead);assert.equal(summary.activityChecks[0].members.find(item=>item.user_id===OTHER).status,'responded');
  await assert.rejects(dashboard.action(f.ctx,f.guild,f.lead,{action:'activitycheck.cancel',id:check.id}),/Bevestig/);
  await dashboard.action(f.ctx,f.guild,f.lead,{action:'activitycheck.cancel',id:check.id,confirm:true});
  await dashboard.action(f.ctx,f.guild,f.lead,{action:'activitycheck.create',date:'morgenavond',time:'20:00',channelId:check.channel_id});assert.equal(f.ctx.store.db.prepare("SELECT COUNT(*) AS n FROM activity_check_sessions WHERE status='open'").get().n,1);
});
test('publicatie herstelt een verstuurd check-in-bericht na een crash zonder duplicaat',async t=>{
  const f=fixture(t),channel=f.guild.channels.cache.get(f.ctx.config.planningChannelId),send=channel.send,sent=[];
  channel.send=async payload=>{sent.push(payload);return send(payload);};
  const {check}=await f.start();assert.equal(sent[0].content,`<@&${f.ctx.config.memberRoleId}>`);assert.deepEqual(sent[0].allowedMentions.roles,[f.ctx.config.memberRoleId]);assert.deepEqual(sent[0].allowedMentions.parse,[]);
  f.ctx.store.db.prepare('UPDATE activity_check_sessions SET message_id=NULL,published_at=NULL,dirty=1 WHERE id=?').run(check.id);
  await publishActivityCheck(f.ctx,f.guild,check.id);assert.equal(f.guild.channels.cache.get(check.channel_id).posted.size,1);assert.equal(f.record(check.id).message_id,check.message_id);
  await syncActivityChecks(f.ctx,f.guild,NOW+1000);assert.equal(sent.length,1);
  for(const edit of f.calls.filter(item=>item.method==='message.edit'&&item.id===check.message_id)){assert.deepEqual(edit.payload.allowedMentions.parse,[]);assert.equal(edit.payload.allowedMentions.roles,undefined);}
  const card=activityCheckMessage(f.ctx,f.record(check.id));assert.ok(!(card.embeds[0].data.fields||[]).some(item=>item.name.includes('Nog niet bevestigd')));
});
test('vinkjes uit een offline periode worden hersteld vóór de deadline en bij afronding',async t=>{
  const f=fixture(t),{check,posted}=await f.start(),reaction=posted.reactions.cache.get('✅');
  reaction.users.cache.set(OTHER,f.guild.members.cache.get(OTHER).user);
  await syncActivityChecks(f.ctx,f.guild,NOW+60000);
  assert.equal(f.ctx.store.db.prepare('SELECT status FROM activity_check_members WHERE check_id=? AND user_id=?').get(check.id,OTHER).status,'responded');
  reaction.users.cache.delete(OTHER);await handleActivityCheckReaction(f.ctx,reaction,f.guild.members.cache.get(OTHER).user,false,NOW+70000);
  reaction.users.cache.set(f.ids[1],f.guild.members.cache.get(f.ids[1]).user);
  await syncActivityChecks(f.ctx,f.guild,DEADLINE);
  assert.equal(f.ctx.store.warnCount(OTHER),0);assert.equal(f.ctx.store.warnCount(f.ids[1]),0);assert.equal(f.ctx.store.warnCount(f.ids[2]),1);
});
test('een late vinkjesreactie wordt verwijderd en voorkomt geen gangwarn',async t=>{
  const f=fixture(t),{check,posted}=await f.start(),reaction=posted.reactions.cache.get('✅'),user=f.guild.members.cache.get(OTHER).user;
  reaction.users.cache.set(OTHER,user);await handleActivityCheckReaction(f.ctx,reaction,user,true,DEADLINE);assert.equal(reaction.users.cache.has(OTHER),false);
  await syncActivityChecks(f.ctx,f.guild,DEADLINE);assert.equal(f.ctx.store.warnCount(OTHER),1);
});
test('onvolledige reactieverversing stelt alle warns uit tot de vinkjes weer leesbaar zijn',async t=>{
  const f=fixture(t),{check,posted}=await f.start(),reaction=posted.reactions.cache.get('✅'),fetch=reaction.users.fetch;
  reaction.users.fetch=async()=>{throw Object.assign(new Error('Offline'),{code:503});};await syncActivityChecks(f.ctx,f.guild,DEADLINE);
  assert.equal(f.record(check.id).status,'open');assert.equal(f.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM activity_check_warnings').get().n,0);
  reaction.users.fetch=fetch;reaction.users.cache.set(OTHER,f.guild.members.cache.get(OTHER).user);await syncActivityChecks(f.ctx,f.guild,DEADLINE+61000);assert.equal(f.ctx.store.warnCount(OTHER),0);assert.equal(f.ctx.store.warnCount(f.ids[1]),1);
});
test('check-in-herinnering respecteert ingestelde tijd en wordt één keer verstuurd, behalve bij vinkje of goedgekeurde afwezigheid',async t=>{
  const f=fixture(t),{check}=await f.start();saveDashboardSettings(f.ctx,{operations:{activityCheck:{reminderMinutes:30}}},ACTOR);await f.answer(check);f.absence(f.ids[1]);
  await syncCheckReminders(f.ctx,f.guild,DEADLINE-31*60000);assert.equal(f.ctx.store.db.prepare("SELECT COUNT(*) AS n FROM feature_notices WHERE kind='checkin.reminder'").get().n,0);
  await syncCheckReminders(f.ctx,f.guild,DEADLINE-30*60000);await syncCheckReminders(f.ctx,f.guild,DEADLINE-29*60000);assert.equal(f.ctx.store.db.prepare("SELECT COUNT(*) AS n FROM feature_notices WHERE kind='checkin.reminder' AND status='sent'").get().n,4);
  for(const id of [OTHER,f.ids[1]])assert.equal(f.ctx.store.db.prepare("SELECT COUNT(*) AS n FROM feature_notices WHERE kind='checkin.reminder' AND user_id=?").get(id).n,0);
});
test('een wachtende herinnering wordt na een vinkje overgeslagen en uitschakelen voorkomt nieuwe meldingen',async t=>{
  const f=fixture(t),{check}=await f.start();for(const id of f.ids.slice(1))await f.answer(check,id);
  const user=f.guild.members.cache.get(OTHER).user;user.send=async()=>{throw Object.assign(new Error('Offline'),{code:503});};await syncCheckReminders(f.ctx,f.guild,DEADLINE-3600000);
  assert.equal(f.ctx.store.db.prepare("SELECT status FROM feature_notices WHERE kind='checkin.reminder'").get().status,'pending');
  await f.answer(check,OTHER,DEADLINE-3500000);await syncCheckReminders(f.ctx,f.guild,DEADLINE-3400000);assert.equal(f.ctx.store.db.prepare("SELECT status FROM feature_notices WHERE kind='checkin.reminder'").get().status,'skipped');
  saveDashboardSettings(f.ctx,{operations:{activityCheck:{remindersEnabled:false}}},ACTOR);await syncCheckReminders(f.ctx,f.guild,DEADLINE-1000);assert.equal(f.ctx.store.db.prepare("SELECT COUNT(*) AS n FROM feature_notices WHERE kind='checkin.reminder'").get().n,1);
});
test('een privékanaal kan geen automatische check voor onzichtbare leden starten en verloren leestoegang geeft geen warn',async t=>{
  const f=fixture(t),channel=f.guild.channels.cache.get(f.ctx.config.planningChannelId),permissions=channel.permissionsFor;
  channel.permissionsFor=target=>target.id===OTHER?new PermissionsBitField(0n):permissions(target);await assert.rejects(f.start(),/alle Legion-leden/);
  channel.permissionsFor=permissions;const {check}=await f.start();channel.permissionsFor=target=>target.id===OTHER?new PermissionsBitField(0n):permissions(target);
  await finishActivityCheck(f.ctx,f.guild,check.id,DEADLINE);assert.equal(f.ctx.store.warnCount(OTHER),0);assert.equal(f.ctx.store.warnCount(f.ids[1]),1);
});
