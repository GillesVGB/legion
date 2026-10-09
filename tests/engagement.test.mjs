import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PermissionsBitField,PermissionFlagsBits as P,MessageFlags } from 'discord.js';
import { dashboardFixture,ACTOR,APPLICANT,OTHER } from './dashboard-fixture.mjs';
import { Store } from '../src/store.mjs';
import { loadConfig } from '../src/config.mjs';
import { commands } from '../src/commands.mjs';
import { createActivity,activityById,activityMessage,attendanceChoices,planningTime,handlePlanningReaction,syncPlanningReactions,cancelActivity,syncActivities,clearPlanningReactions } from '../src/activities.mjs';
import { createPromotion,decidePromotion,promotionById,syncPromotions,promotionVotes,PROMOTION_LEAD_ROLE_ID } from '../src/promotions.mjs';
import { applicationQueue,showApplicationStatus } from '../src/application-status.mjs';
import { createCase,decideCase,reconcileCases } from '../src/service.mjs';
import { recruitmentState } from '../src/recruitment.mjs';
import { missionDay } from '../src/mission-definitions.mjs';
import { missionMessage,handleMissionButton } from '../src/missions.mjs';
import { syncCommands } from '../src/command-sync.mjs';
import { Dashboard } from '../src/dashboard.mjs';
import { Locks } from '../src/locks.mjs';

const fixture=t=>{const f=dashboardFixture();t.after(f.close);const main=f.contexts.values().next().value,guild=f.guilds.get(main.config.guildId);guild.addMember('100000000000000080','Lead twee',[PROMOTION_LEAD_ROLE_ID,main.config.memberRoleId]);guild.addMember('100000000000000081','Lead drie',[PROMOTION_LEAD_ROLE_ID,main.config.memberRoleId]);return{...f,main,guild};};
const leadIds=[ACTOR,'100000000000000080','100000000000000081'];
async function castThree(f,id,choices=['approve','approve','approve']){let result;for(let i=0;i<3;i++)result=await decidePromotion(f.main,f.guild,f.guild.members.cache.get(leadIds[i]),id,choices[i]);return result;}
function seedVotes(f,id,choices=['approve','approve','approve']){for(let i=0;i<3;i++)f.main.store.db.prepare('INSERT INTO promotion_votes(proposal_id,voter_id,response,updated_at) VALUES(?,?,?,?)').run(id,leadIds[i],choices[i],Date.now()+i);}
function interaction(f,user=ACTOR,guild=f.guild) {const member=guild.members.cache.get(user);return{guild,guildId:guild.id,channelId:f.main.config.logChannelId,channel:guild.channels.cache.get(f.main.config.logChannelId),client:f.client,user:member.user,member,memberPermissions:member.permissions,editReply:async()=>{},reply:async()=>{},deferReply:async()=>{}};}
const future=()=>({date:missionDay(Date.now()+2*86400000),time:'20:30',location:'Legion HQ'});
async function planning(t){const f=fixture(t);const item=await createActivity(f.main,interaction(f),future());const activity=activityById(f.main,item.id),message=f.guild.channels.cache.get(activity.channel_id).posted.get(activity.message_id);return{...f,activity,message};}
async function react(f,emoji,user=OTHER,added=true){const reaction=f.message.reactions.cache.get(emoji),member=f.guild.members.cache.get(user);if(added)reaction.users.cache.set(user,member.user);else reaction.users.cache.delete(user);await handlePlanningReaction(f.main,reaction,member.user,added);return reaction;}

test('planning staat in het vaste gangkanaal als tekst, met voorbereiding en vier botreacties; community wordt geweigerd',async t=>{
  const f=await planning(t);
  assert.equal(f.activity.channel_id,'1555685633266163793');
  assert.equal(f.message.embeds.length,0);assert.equal(f.message.components.length,0);
  for(const text of ['Datum:','Tijd:','Afspreekpunt:','geheald','Tank','repairkits','op tijd'])assert.ok(f.message.content.includes(text));
  for(const choice of attendanceChoices){assert.ok(f.message.content.includes(`${choice.emoji}: ${choice.label}`));assert.equal(f.message.reactions.cache.get(choice.emoji).me,true);}
  assert.equal(f.message.reactions.cache.size,4);
  await assert.rejects(createActivity(f.source,interaction(f,ACTOR,f.guilds.get(f.source.config.guildId)),future()),/gangserver/);
  assert.equal(f.source.store.db.prepare('SELECT COUNT(*) AS n FROM activities').get().n,0);
  const forged=await createActivity(f.main,interaction(f),{...future(),channelId:f.source.config.panelChannelId});
  assert.equal(activityById(f.main,forged.id).channel_id,f.main.config.planningChannelId);
});
test('planning verwerkt wisselen en intrekken van reacties zonder dubbele stemmen of verlies door een oude verwijdering',async t=>{
  const f=await planning(t);await react(f,'🟢');await react(f,'🕒');
  assert.equal(f.main.store.db.prepare('SELECT response FROM activity_rsvps WHERE activity_id=? AND user_id=?').get(f.activity.id,OTHER).response,'late');
  assert.equal(f.message.reactions.cache.get('🟢').users.cache.has(OTHER),false);
  await react(f,'🟢',OTHER,false); // Gateway-event na verwijderen van de oude keuze.
  assert.equal(f.main.store.db.prepare('SELECT response FROM activity_rsvps WHERE activity_id=? AND user_id=?').get(f.activity.id,OTHER).response,'late');
  await Promise.all([react(f,'🔴',OTHER),react(f,'🟠',OTHER)]);
  assert.equal(f.main.store.db.prepare('SELECT COUNT(*) AS n FROM activity_rsvps WHERE activity_id=? AND user_id=?').get(f.activity.id,OTHER).n,1);
  assert.equal(f.main.store.db.prepare('SELECT response FROM activity_rsvps WHERE activity_id=? AND user_id=?').get(f.activity.id,OTHER).response,'maybe');
  assert.equal(f.message.reactions.cache.get('🟠').users.cache.has(OTHER),true);
  await react(f,'🟠',OTHER,false);
  assert.equal(f.main.store.db.prepare('SELECT COUNT(*) AS n FROM activity_rsvps WHERE activity_id=?').get(f.activity.id).n,0);
});
test('reacties uit een offline periode worden hersteld; annuleren en afloop sluiten inschrijven',async t=>{
  const f=await planning(t),yes=f.message.reactions.cache.get('🟢');
  yes.users.cache.set(OTHER,f.guild.members.cache.get(OTHER).user);
  await syncPlanningReactions(f.main,f.guild,f.activity.id);
  assert.equal(f.main.store.db.prepare('SELECT response FROM activity_rsvps WHERE activity_id=? AND user_id=?').get(f.activity.id,OTHER).response,'yes');
  await cancelActivity(f.main,f.guild,f.activity.id,ACTOR);await react(f,'🔴',ACTOR);
  assert.equal(f.main.store.db.prepare('SELECT COUNT(*) AS n FROM activity_rsvps WHERE activity_id=?').get(f.activity.id).n,1);
  assert.ok(f.message.content.includes('geannuleerd'));
  const second=await createActivity(f.main,interaction(f),future());
  f.main.store.db.prepare('UPDATE activities SET ends_at=? WHERE id=?').run(Date.now()-1,second.id);
  await syncActivities(f.main,f.guild);
  assert.equal(activityById(f.main,second.id).status,'ended');
});
test('lege of gewiste reacties worden hersteld zonder nieuwe planningberichten te plaatsen',async t=>{
  const f=await planning(t);await react(f,'🟢');const id=f.message.id;
  f.message.reactions.cache.clear();await clearPlanningReactions(f.main,f.message);
  assert.equal(f.message.id,id);assert.equal(f.message.reactions.cache.size,4);
  assert.equal(f.main.store.db.prepare('SELECT COUNT(*) AS n FROM activity_rsvps WHERE activity_id=?').get(f.activity.id).n,0);
  assert.equal(f.guild.channels.cache.get(f.activity.channel_id).posted.size,1);
});
test('planning weigert verkeerde rechten en ongeldige tijden; zomer- en wintertijd worden correct verwerkt',async t=>{
  const f=fixture(t);await assert.rejects(createActivity(f.main,interaction(f,OTHER),future()),/leiding/);
  assert.equal(planningTime('12-10-2026','20:30'),Date.parse('2026-10-12T18:30:00Z'));
  assert.equal(planningTime('12-12-2026','20:30'),Date.parse('2026-12-12T19:30:00Z'));
  for(const [date,time] of [['31-02-2026','20:00'],['29-03-2026','02:30'],['25-10-2026','02:30'],['12-10-2026','25:99']])assert.throws(()=>planningTime(date,time));
  const channel=f.guild.channels.cache.get(f.main.config.planningChannelId);channel.permissionsFor=()=>new PermissionsBitField([P.ViewChannel,P.SendMessages,P.ReadMessageHistory,P.AddReactions]);
  await assert.rejects(createActivity(f.main,interaction(f),future()),/Berichten beheren/);
});
test('promotie vereist drie Lead-stemmen, controleert rangvolgorde en bewaart andere rollen',async t=>{
  const f=fixture(t),user='100000000000000035',target=f.guild.members.cache.get(user),role=f.main.config.roster.roleIds[7];
  const proposal=await createPromotion(f.main,interaction(f),{memberId:user,roleId:role,reason:'Actief aanwezig en helpt recruits.'});
  assert.ok(proposal.posted);await assert.rejects(decidePromotion(f.main,f.guild,f.guild.members.cache.get(OTHER),proposal.id,'approve'),/Lead-rol/);
  const original=target.roles.cache.get(f.main.config.memberRoleId);
  const first=await decidePromotion(f.main,f.guild,f.guild.members.cache.get(ACTOR),proposal.id,'approve');assert.equal(first.status,'pending');assert.equal(first.voting.total,1);assert.equal(target.roles.cache.has(role),false);
  const second=await decidePromotion(f.main,f.guild,f.guild.members.cache.get(leadIds[1]),proposal.id,'approve');assert.equal(second.status,'pending');assert.equal(target.roles.cache.has(role),false);
  const done=await decidePromotion(f.main,f.guild,f.guild.members.cache.get(leadIds[2]),proposal.id,'reject');
  assert.equal(done.status,'approved');assert.ok(target.roles.cache.has(role));assert.equal(target.roles.cache.get(f.main.config.memberRoleId),original);
  assert.equal(f.main.config.roster.roleIds.filter(id=>target.roles.cache.has(id)).length,1);
  await assert.rejects(decidePromotion(f.main,f.guild,f.guild.members.cache.get(ACTOR),proposal.id,'approve'),/beoordeeld/);
  assert.equal(f.calls.filter(call=>call.method==='roles.add').length,1);assert.equal(f.calls.filter(call=>call.method==='roles.set').length,0);
  await assert.rejects(createPromotion(f.main,interaction(f),{memberId:user,roleId:f.main.config.roster.roleIds[9],reason:'Test'}),/hogere rang/);
});
test('een hoge niet-gangrol zoals + blokkeert Chef niet en blijft behouden',async t=>{
  const f=fixture(t),user='100000000000000035',member=f.guild.members.cache.get(user),role=f.main.config.roster.roleIds[0];
  const extra={id:'100000000000000150',name:'+',position:150,managed:false,permissions:new PermissionsBitField(P.Administrator),comparePositionTo(other){return this.position-other.position;}};
  f.guild.roles.cache.set(extra.id,extra);member.roles.cache.set(extra.id,extra);member.roles.highest=extra;member.permissions=new PermissionsBitField(P.Administrator);
  const proposal=await createPromotion(f.main,interaction(f,user),{memberId:user,roleId:role,reason:'Een Chef-voorstel met een hogere aparte rol.'});
  const done=await castThree(f,proposal.id,['approve','reject','approve']);
  assert.equal(done.status,'approved');assert.ok(member.roles.cache.has(role));assert.ok(member.roles.cache.has(extra.id));
  assert.equal(f.calls.some(call=>call.method==='roles.remove'&&call.role===extra.id),false);
  assert.equal(f.calls.some(call=>call.method==='roles.set'),false);
});
test('dubbel stemmen telt eenmaal; veranderen past die ene stem aan en een meerderheid tegen wijzigt geen rang',async t=>{
  const f=fixture(t),user='100000000000000035',role=f.main.config.roster.roleIds[7];
  const proposal=await createPromotion(f.main,interaction(f),{memberId:user,roleId:role,reason:'Stemwijzigingtest'});
  await decidePromotion(f.main,f.guild,f.guild.members.cache.get(ACTOR),proposal.id,'approve');
  await decidePromotion(f.main,f.guild,f.guild.members.cache.get(ACTOR),proposal.id,'approve');
  assert.equal(promotionVotes(f.main,proposal.id).total,1);
  await decidePromotion(f.main,f.guild,f.guild.members.cache.get(ACTOR),proposal.id,'reject');
  assert.equal(promotionVotes(f.main,proposal.id).approve,0);assert.equal(promotionVotes(f.main,proposal.id).reject,1);
  await decidePromotion(f.main,f.guild,f.guild.members.cache.get(leadIds[1]),proposal.id,'approve');
  const result=await decidePromotion(f.main,f.guild,f.guild.members.cache.get(leadIds[2]),proposal.id,'reject');
  assert.equal(result.status,'rejected');assert.equal(result.voting.total,3);
  assert.equal(f.calls.filter(call=>call.method==='roles.add'||call.method==='roles.remove').length,0);
});
test('administrators zonder de exacte Lead-rol en bots met de rol mogen niet stemmen',async t=>{
  const f=fixture(t),user='100000000000000035',role=f.main.config.roster.roleIds[7];
  const proposal=await createPromotion(f.main,interaction(f),{memberId:user,roleId:role,reason:'Toegangscontrole'});
  const admin=f.guild.addMember('100000000000000082','Admin zonder Lead',[f.main.config.memberRoleId],true);
  const robot=f.guild.addMember('100000000000000083','Testbot met Lead',[PROMOTION_LEAD_ROLE_ID],true,true);
  for(const actor of [admin,robot])await assert.rejects(decidePromotion(f.main,f.guild,actor,proposal.id,'approve'),/Lead-rol/);
  assert.equal(promotionVotes(f.main,proposal.id).total,0);
});
test('een verloren Lead-rol telt niet mee vóór de uitslag',async t=>{
  const f=fixture(t),user='100000000000000035',role=f.main.config.roster.roleIds[7];
  const proposal=await createPromotion(f.main,interaction(f),{memberId:user,roleId:role,reason:'Lead-rol gewijzigd'});
  await decidePromotion(f.main,f.guild,f.guild.members.cache.get(ACTOR),proposal.id,'approve');
  f.guild.members.cache.get(ACTOR).roles.cache.delete(PROMOTION_LEAD_ROLE_ID);
  await decidePromotion(f.main,f.guild,f.guild.members.cache.get(leadIds[1]),proposal.id,'approve');
  const second=await decidePromotion(f.main,f.guild,f.guild.members.cache.get(leadIds[2]),proposal.id,'reject');
  assert.equal(second.status,'pending');assert.equal(second.voting.total,2);
  const extra=f.guild.addMember('100000000000000082','Nieuwe Lead',[PROMOTION_LEAD_ROLE_ID,f.main.config.memberRoleId]);
  const result=await decidePromotion(f.main,f.guild,extra,proposal.id,'approve');assert.equal(result.status,'approved');
});
test('gelijkstand blijft open en een extra unieke Lead-stem bepaalt de meerderheid',async t=>{
  const f=fixture(t),user='100000000000000035',role=f.main.config.roster.roleIds[7];
  const fourth=f.guild.addMember('100000000000000082','Vierde Lead',[PROMOTION_LEAD_ROLE_ID,f.main.config.memberRoleId]);
  const fifth=f.guild.addMember('100000000000000083','Vijfde Lead',[PROMOTION_LEAD_ROLE_ID,f.main.config.memberRoleId]);
  const proposal=await createPromotion(f.main,interaction(f),{memberId:user,roleId:role,reason:'Herstelde stemming met gelijkstand'});
  seedVotes(f,proposal.id,['approve','reject','approve']);
  f.main.store.db.prepare('INSERT INTO promotion_votes(proposal_id,voter_id,response,updated_at) VALUES(?,?,?,?)').run(proposal.id,fourth.id,'reject',Date.now());
  await syncPromotions(f.main,f.guild);assert.equal(promotionById(f.main,proposal.id).status,'pending');
  const result=await decidePromotion(f.main,f.guild,fifth,proposal.id,'approve');assert.equal(result.status,'approved');assert.equal(result.voting.approve,3);assert.equal(result.voting.reject,2);
});
test('gelijktijdige Lead-stemmen voeren een promotie maar één keer uit',async t=>{
  const f=fixture(t),user='100000000000000035',role=f.main.config.roster.roleIds[7];
  const proposal=await createPromotion(f.main,interaction(f),{memberId:user,roleId:role,reason:'Gelijktijdige stemming'});
  await Promise.all(leadIds.map(id=>decidePromotion(f.main,f.guild,f.guild.members.cache.get(id),proposal.id,'approve')));
  assert.equal(promotionById(f.main,proposal.id).status,'approved');assert.equal(promotionVotes(f.main,proposal.id).total,3);
  assert.equal(f.calls.filter(call=>call.method==='roles.add').length,1);assert.equal(f.calls.filter(call=>call.method==='roles.remove').length,1);
});
test('twee stemmen blijven bij een herstart bewaard en de derde Lead-stem beslist',async t=>{
  const f=fixture(t),folder=mkdtempSync(join(tmpdir(),'legion-votes-')),config={...f.main.config,dataDir:folder};
  const first=new Store(config),ctx={...f.main,store:first};
  const proposal=await createPromotion(ctx,interaction(f),{memberId:'100000000000000035',roleId:f.main.config.roster.roleIds[7],reason:'Blijvende stemmen'});
  for(const id of leadIds.slice(0,2))await decidePromotion(ctx,f.guild,f.guild.members.cache.get(id),proposal.id,'approve');
  first.close();const second=new Store(config);ctx.store=second;
  t.after(()=>{second.close();assert.ok(folder.startsWith(join(tmpdir(),'legion-votes-')));rmSync(folder,{recursive:true,force:true});});
  assert.equal(promotionVotes(ctx,proposal.id).total,2);assert.equal(promotionById(ctx,proposal.id).status,'pending');
  const result=await decidePromotion(ctx,f.guild,f.guild.members.cache.get(leadIds[2]),proposal.id,'reject');assert.equal(result.status,'approved');
});
test('botrechten blijven gecontroleerd voor de gewenste gangrang en oude goedkeuring zonder drie stemmen wordt niet uitgevoerd',async t=>{
  const f=fixture(t),user='100000000000000035',role=f.main.config.roster.roleIds[0];
  const target=f.guild.roles.cache.get(role),position=target.position;target.position=150;
  await assert.rejects(createPromotion(f.main,interaction(f),{memberId:user,roleId:role,reason:'Te hoge gangrol'}),/botrol.*boven/);
  target.position=position;
  const proposal=await createPromotion(f.main,interaction(f),{memberId:user,roleId:role,reason:'Oud onafgerond voorstel'});
  f.main.store.db.prepare("UPDATE promotions SET status='approving',approver_id=? WHERE id=?").run(ACTOR,proposal.id);
  await syncPromotions(f.main,f.guild);
  assert.equal(promotionById(f.main,proposal.id).status,'pending');assert.equal(f.calls.filter(call=>call.method==='roles.add').length,0);
});
test('leden kunnen zichzelf voorstellen, geen andere leden; verkeerde berichten en dubbele voorstellen worden geweigerd',async t=>{
  const f=fixture(t),user='100000000000000035',role=f.main.config.roster.roleIds[7];
  await assert.rejects(createPromotion(f.main,interaction(f,user),{memberId:'100000000000000036',roleId:role,reason:'Test'}),/jezelf/);
  const proposal=await createPromotion(f.main,interaction(f,user),{memberId:user,roleId:role,reason:'Ik neem verantwoordelijkheid.'});
  await assert.rejects(createPromotion(f.main,interaction(f),{memberId:user,roleId:role,reason:'Test'}),/al een open/);
  await assert.rejects(decidePromotion(f.main,f.guild,f.guild.members.cache.get(ACTOR),proposal.id,'approve',{channelId:'wrong',messageId:proposal.posted.id}),/oorspronkelijke/);
  const done=await castThree(f,proposal.id,['reject','approve','reject']);assert.equal(done.status,'rejected');
  assert.equal(f.calls.filter(call=>call.method==='roles.set').length,0);
});
test('een promotie die tijdens de rolwijziging herstartte wordt gecontroleerd en één keer afgerond',async t=>{
  const f=fixture(t),user='100000000000000035',role=f.main.config.roster.roleIds[7];
  const proposal=await createPromotion(f.main,interaction(f),{memberId:user,roleId:role,reason:'Hersteltest'});
  seedVotes(f,proposal.id);
  f.main.store.db.prepare("UPDATE promotions SET status='approving',approver_id=? WHERE id=?").run(ACTOR,proposal.id);
  await f.guild.members.cache.get(user).roles.set([f.main.config.memberRoleId,role]);
  await syncPromotions(f.main,f.guild);await syncPromotions(f.main,f.guild);
  assert.equal(promotionById(f.main,proposal.id).status,'approved');
  assert.equal(f.main.store.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE event='promotion.approved'").get().n,1);
});
test('een tijdelijke Discord-storing houdt de goedgekeurde promotie in verwerking en herstelt zonder dubbele rangwijziging',async t=>{
  const f=fixture(t),user='100000000000000035',role=f.main.config.roster.roleIds[7],member=f.guild.members.cache.get(user);
  const proposal=await createPromotion(f.main,interaction(f),{memberId:user,roleId:role,reason:'Netwerkhersteltest'});
  const add=member.roles.add;let attempts=0;
  member.roles.add=async value=>{if(++attempts===1)throw Object.assign(new Error('Testverbinding onderbroken'),{code:'ECONNRESET'});return add(value);};
  const result=await castThree(f,proposal.id);
  assert.equal(result.status,'approving');
  await syncPromotions(f.main,f.guild,Date.now()+61000);
  assert.equal(promotionById(f.main,proposal.id).status,'approved');assert.equal(attempts,2);
  assert.equal(f.calls.filter(call=>call.method==='roles.add').length,1);
});
test('migratie van schema 5 bewaart coins, gangwarns en open sollicitaties',t=>{
  const f=fixture(t),folder=mkdtempSync(join(tmpdir(),'legion-migration-')),config={...f.main.config,dataDir:folder};
  const old=new Store(config);old.adjustCoins(OTHER,500,ACTOR,'Oude fixturecoins');old.addWarn(OTHER,ACTOR,'Oude fixturewarn');
  const dossier=old.reserveCase('application',OTHER,{template:true});old.bindCase(dossier.id,'fixture-channel');old.openCase(dossier.id,'fixture-message');
  old.db.exec('DROP TABLE activities; DROP TABLE activity_rsvps; DROP TABLE promotions; DROP TABLE promotion_votes; DROP TABLE mission_progress; DROP TABLE mission_claims; PRAGMA user_version=5;');old.close();
  const upgraded=new Store(config);t.after(()=>{upgraded.close();assert.ok(folder.startsWith(join(tmpdir(),'legion-migration-')));rmSync(folder,{recursive:true,force:true});});
  assert.equal(upgraded.wallet(OTHER).balance,config.startingCoins+500);assert.equal(upgraded.warnCount(OTHER),1);assert.equal(upgraded.caseById(dossier.id).status,'open');
  assert.equal(upgraded.db.prepare('PRAGMA user_version').get().user_version,8);assert.equal(upgraded.missionStatus(OTHER).missions.length,3);
});
test('missies tellen echte gameacties, betalen eenmaal en resetten op Belgische middernacht',t=>{
  const f=fixture(t),store=f.main.store,now=Date.parse('2026-10-08T12:00:00Z');
  for(let i=0;i<5;i++)store.fish(OTHER,0,now);store.daily(OTHER,now);
  const status=store.missionStatus(OTHER,now);assert.equal(status.missions.find(item=>item.id==='fishing').progress,5);
  const before=store.wallet(OTHER).balance,result=store.claimMissions(OTHER,status.day,now);
  assert.equal(result.reward,275);assert.equal(store.wallet(OTHER).balance,before+275);
  assert.throws(()=>store.claimMissions(OTHER,status.day,now),/geen nieuwe beloning/);
  assert.equal(missionDay(Date.parse('2026-10-08T21:59:59Z')),'2026-10-08');assert.equal(missionDay(Date.parse('2026-10-08T22:00:00Z')),'2026-10-09');
  assert.equal(store.missionStatus(OTHER,Date.parse('2026-10-08T22:00:00Z')).missions[0].progress,0);
  assert.throws(()=>store.claimMissions(OTHER,status.day,now+86400000),/andere dag/);
  const game=store.startGame(OTHER,100,now,['2S','3S','4S','5S','6S','7S','8S','9S']);
  store.playGame(game.id,OTHER,game.revision,'stand',now);
  assert.equal(store.missionStatus(OTHER,now).missions.find(item=>item.id==='blackjack').progress,1);
  assert.throws(()=>store.playGame(game.id,OTHER,game.revision,'stand',now),/afgelopen/);
  assert.equal(store.claimMissions(OTHER,status.day,now).reward,200);
});
test('missiekaart is publiek, claimen kan alleen door de eigenaar en voortgang blijft op schijf bewaard',async t=>{
  const f=fixture(t);const message=missionMessage(f.main,OTHER);assert.equal(message.flags,undefined);
  await assert.rejects(handleMissionButton(f.main,{customId:`mission:claim:${OTHER}:${missionDay()}`,user:{id:ACTOR}}),/iemand anders/);
  const folder=mkdtempSync(join(tmpdir(),'legion-mission-'));
  const config={...f.main.config,dataDir:folder},first=new Store(config);first.daily(OTHER);first.close();
  const second=new Store(config);t.after(()=>{second.close();assert.ok(folder.startsWith(join(tmpdir(),'legion-mission-')));rmSync(folder,{recursive:true,force:true});});assert.equal(second.missionStatus(OTHER).missions.find(item=>item.id==='daily').progress,1);
});
test('bij 25/25 wordt een sollicitatie met waarschuwing aangemaakt; aannemen wacht op een vrije plek',async t=>{
  const f=fixture(t),ctx=f.source,guild=f.guilds.get(ctx.config.guildId);
  for(let i=0;i<8;i++)guild.addMember(String(BigInt('100000000000000060')+BigInt(i)),`Extra ${i}`,[ctx.config.memberRoleId]);
  ctx.recruitment=recruitmentState(25);
  guild.makeChannel(ctx.config.applicationCategoryId,'sollicitaties').type=4;
  guild.channels.create=async options=>{const channel=guild.makeChannel('100000000000000900',options.name,options.topic);channel.parentId=options.parent;return channel;};
  let reply;const applicant=interaction(f,OTHER,guild);applicant.channelId=ctx.config.logChannelId;applicant.editReply=async value=>reply=value;
  await createCase(ctx,applicant,'application',{template:true});
  const dossier=ctx.store.activeCases().find(item=>item.owner_id===OTHER&&item.kind==='application'),channel=guild.channels.cache.get(dossier.channel_id);
  assert.equal(dossier.status,'open');assert.match(reply.content,/bekijken.*langer duren/);
  assert.ok(channel.posted.get(dossier.message_id).embeds[0].fields.some(field=>field.name==='Langere wachttijd'));
  const staff=interaction(f,ACTOR,guild);staff.channelId=channel.id;staff.channel=channel;
  await assert.rejects(decideCase(ctx,staff,dossier.id,'accept'),/zit vol/);assert.equal(ctx.store.caseById(dossier.id).status,'open');
  ctx.recruitment=recruitmentState(24);await reconcileCases(ctx,guild);
  assert.equal(channel.posted.get(dossier.message_id).embeds[0].fields.some(field=>field.name==='Langere wachttijd'),false);
});
test('sollicitanten zien alleen hun eigen status; binnenkomstvolgorde verandert na afhandelen en gesprek',async t=>{
  const f=fixture(t),ctx=f.source;
  ctx.store.db.prepare('UPDATE cases SET created_at=? WHERE id=?').run(1000,f.open.id);
  const second=ctx.store.reserveCase('application',OTHER,{template:true},100000);ctx.store.bindCase(second.id,'second');ctx.store.openCase(second.id,'intro');
  assert.equal(applicationQueue(ctx.store).get(second.id).position,2);
  let response;const own=interaction(f,OTHER,f.guilds.get(ctx.config.guildId));own.reply=async value=>response=value;
  await showApplicationStatus(ctx,own,second.id);assert.equal(response.flags,MessageFlags.Ephemeral);assert.match(response.embeds[0].toJSON().description,/plek 2 van 2/);
  await assert.rejects(showApplicationStatus(ctx,own,f.open.id),/sollicitant en de leiding/);
  ctx.store.closeCase(f.open.id,'rejected',ACTOR);ctx.store.bindInterview(second.id,'voice',ACTOR);
  await showApplicationStatus(ctx,own,second.id);assert.match(response.embeds[0].toJSON().description,/Gesprek ingepland/);assert.match(response.embeds[0].toJSON().description,/plek 1 van 1/);
});
test('commands registreren alleen planning in de gangserver, precies drie invoervelden en één registratie per versie',async t=>{
  const f=fixture(t),gang=commands(500,false),community=commands(500,true),planning=gang.find(command=>command.name==='planning');
  assert.deepEqual(planning.options.map(option=>option.name),['datum','tijd','afspreekpunt']);assert.ok(planning.options.every(option=>option.required));
  assert.equal(community.some(command=>command.name.startsWith('planning')||command.name==='promotie'),false);
  assert.ok(community.some(command=>command.name==='missies'));assert.ok(community.some(command=>command.name==='sollicitatiestatus'));
  let count=0;f.guild.commands={set:async()=>count++};assert.equal(await syncCommands(f.main,f.guild),true);assert.equal(await syncCommands(f.main,f.guild),false);assert.equal(count,1);
});
test('dashboard toont planning, promoties en missies; annuleren en beoordelen vereisen bevestiging',async t=>{
  const f=await planning(t),dashboard=new Dashboard({...f,locks:new Locks()});
  const summary=dashboard.summary(f.main,f.guild);assert.equal(summary.plannings.length,1);assert.equal(summary.planningChannelId,f.main.config.planningChannelId);assert.equal(summary.missions.definitions.length,3);
  await assert.rejects(dashboard.action(f.main,f.guild,f.guild.members.cache.get(ACTOR),{action:'planning.cancel',id:f.activity.id}),/Bevestig/);
  await dashboard.action(f.main,f.guild,f.guild.members.cache.get(ACTOR),{action:'planning.cancel',id:f.activity.id,confirm:true});
  assert.equal(activityById(f.main,f.activity.id).status,'cancelled');
});
