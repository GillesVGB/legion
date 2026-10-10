import test from 'node:test';
import assert from 'node:assert/strict';
import {PermissionsBitField,PermissionFlagsBits as P} from 'discord.js';
import {dashboardFixture,ACTOR,OTHER} from './dashboard-fixture.mjs';
import {createAbsence,decideAbsence,setExemption,exemptionFor,activityAbsences,syncAbsences} from '../src/absence.mjs';
import {syncGangpot,gangpotMembers,reportGangpotPayment,reviewGangpotPayment} from '../src/gangpot.mjs';
import {createActivity,handlePlanningReaction,publishActivity,syncPlanningReactions} from '../src/activities.mjs';
import {saveDashboardSettings,loadDashboardSettings,validateDashboardSettings} from '../src/dashboard-settings.mjs';
import {operationSettings} from '../src/feature-settings.mjs';
import {Dashboard} from '../src/dashboard.mjs';
import {Locks} from '../src/locks.mjs';
import {recordInteraction,flushAuditLogs,cleanAudit} from '../src/audit-log.mjs';
import {announceRelease,releaseVersion,releaseNotes} from '../src/release-announcements.mjs';
import {botHealth} from '../src/bot-status.mjs';
import {fishBookMessage,handleFishBookButton} from '../src/fish-book.mjs';
import {commands} from '../src/commands.mjs';
import {publishAbsencePanel,handleAbsencePanel,handleAbsenceSelection} from '../src/absence-panel.mjs';
const SAT=Date.parse('2026-10-10T10:00:00Z'),FRI=Date.parse('2026-10-16T16:00:00Z'),END=Date.parse('2026-10-17T22:00:00Z');
function fixture(t){const f=dashboardFixture();t.after(f.close);const ctx=f.contexts.values().next().value,guild=f.guilds.get(ctx.config.guildId);for(const id of [ACTOR,OTHER])guild.members.cache.get(id).roles.cache.set(ctx.config.gangpot.memberRoleId,guild.roles.cache.get(ctx.config.gangpot.memberRoleId));return{...f,ctx,guild,lead:guild.members.cache.get(ACTOR)};}
const pay=(f,user=OTHER)=>reportGangpotPayment(f.ctx,{userId:user,periodId:'2026-10-17',amount:25000,requestId:`payment-${user}-request`},SAT);
const warns=(f,user=OTHER)=>f.ctx.store.db.prepare("SELECT * FROM warnings WHERE user_id=? AND reason LIKE 'Gangpot t/m %' AND removed_at IS NULL").all(user);

test('afwezigheid geeft alleen na Lead-goedkeuring vrijstelling voor de genoemde weken, zonder geldmutatie',async t=>{
  const f=fixture(t);await syncGangpot(f.ctx,f.client,SAT);const item=await createAbsence(f.ctx,f.guild,OTHER,{start:'12-10-2026',end:'19-10-2026',reason:'Vakantie'},SAT);
  assert.deepEqual(JSON.parse(item.weeks),['2026-10-17','2026-10-24']);assert.equal(exemptionFor(f.ctx,OTHER,'2026-10-17'),undefined);
  const admin=f.guild.addMember('100000000000000077','Admin zonder Lead',[],true);
  await assert.rejects(decideAbsence(f.ctx,f.guild,admin,item.id,'approve',SAT+1000),/Alleen Lead/);
  const before=f.ctx.store.wallet(OTHER).balance;await decideAbsence(f.ctx,f.guild,f.lead,item.id,'approve',SAT+1000);await decideAbsence(f.ctx,f.guild,f.lead,item.id,'approve',SAT+2000);
  assert.ok(exemptionFor(f.ctx,OTHER,'2026-10-17'));assert.equal(f.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM gangpot_exemptions').get().n,2);
  assert.equal(f.ctx.store.wallet(OTHER).balance,before);await syncGangpot(f.ctx,f.client,END);assert.equal(warns(f).length,0);
  await syncAbsences(f.ctx,f.guild,END);assert.equal(f.ctx.store.db.prepare("SELECT COUNT(*) AS n FROM feature_notices WHERE kind='absence' AND status='sent'").get().n,1);
});

test('pending of afgewezen afwezigheid geeft geen vrijstelling; een late vrijstelling corrigeert uitsluitend de gangpotwarn en intrekken herstelt dezelfde warn',async t=>{
  const f=fixture(t);await syncGangpot(f.ctx,f.client,SAT);const item=await createAbsence(f.ctx,f.guild,OTHER,{start:'10-10-2026',end:'17-10-2026',reason:'Afwezig'},SAT);
  await decideAbsence(f.ctx,f.guild,f.lead,item.id,'reject',SAT+1000);await syncGangpot(f.ctx,f.client,END);assert.equal(warns(f).length,1);const id=warns(f)[0].id;
  const manual=f.ctx.store.addWarn(OTHER,ACTOR,'Ander voorval');await setExemption(f.ctx,f.guild,f.lead,OTHER,'17-10-2026','Vrijstelling gecontroleerd',false,END+1000);
  assert.equal(warns(f).length,0);assert.equal(f.ctx.store.warnings(OTHER).find(item=>item.id===manual.id).removed_at,null);
  await setExemption(f.ctx,f.guild,f.lead,OTHER,'17-10-2026','Vrijstelling onjuist',true,END+2000);assert.equal(warns(f)[0].id,id);assert.equal(warns(f).length,1);
});

test('rode planningreactie is pending, /afmelden bewaart de reden bij offline synchroniseren, goedkeuring verschijnt in tekst zonder embeds of knoppen',async t=>{
  const f=fixture(t);t.mock.method(Date,'now',()=>SAT);const interaction={guild:f.guild,user:f.lead.user,member:f.lead,memberPermissions:f.lead.permissions};
  const created=await createActivity(f.ctx,interaction,{date:'12-10-2026',time:'20:00',location:'HQ'},SAT),activity=f.ctx.store.db.prepare('SELECT * FROM activities WHERE id=?').get(created.id),message=f.guild.channels.cache.get(activity.channel_id).posted.get(activity.message_id),reaction=message.reactions.cache.get('🔴');
  reaction.users.cache.set(OTHER,f.guild.members.cache.get(OTHER).user);await handlePlanningReaction(f.ctx,reaction,f.guild.members.cache.get(OTHER).user,true);
  assert.equal(activityAbsences(f.ctx,activity)[0].status,'pending');assert.ok(message.content.includes('wacht op Lead'));
  const item=await createAbsence(f.ctx,f.guild,OTHER,{activityId:activity.id,reason:'Kan niet vanwege werk'},SAT);await syncPlanningReactions(f.ctx,f.guild,activity.id);assert.equal(f.ctx.store.db.prepare('SELECT reason FROM absence_requests WHERE id=?').get(item.id).reason,'Kan niet vanwege werk');
  await decideAbsence(f.ctx,f.guild,f.lead,item.id,'approve',SAT+1000);await publishActivity(f.ctx,f.guild,activity.id);
  assert.ok(message.content.includes('Afwezig (goedgekeurd)'));assert.equal(message.embeds.length,0);assert.equal(message.components.length,0);assert.equal(exemptionFor(f.ctx,OTHER,'2026-10-17'),undefined);
});

test('goedgekeurde vakantie verschijnt op een passende planning, maar niet op een andere datum',async t=>{
  const f=fixture(t),item=await createAbsence(f.ctx,f.guild,OTHER,{start:'12-10-2026',end:'14-10-2026',reason:'Vakantie'},SAT);
  await decideAbsence(f.ctx,f.guild,f.lead,item.id,'approve',SAT);
  assert.equal(activityAbsences(f.ctx,{id:'plan-a',starts_at:Date.parse('2026-10-13T12:00:00Z')}).length,1);
  assert.equal(activityAbsences(f.ctx,{id:'plan-b',starts_at:Date.parse('2026-10-15T12:00:00Z')}).length,0);
  await assert.rejects(createAbsence(f.ctx,f.guild,OTHER,{start:'31-02-2026',end:'12-10-2026',reason:'Test'},SAT));
  await assert.rejects(createAbsence(f.ctx,f.guild,OTHER,{start:'01-10-2026',end:'12-10-2026',reason:'Test'},SAT),/vandaag/);
});

test('leden krijgen vrijdag en zaterdag elk één DM; goedgekeurde betalingen en vrijstellingen sluiten herinneringen uit',async t=>{
  const f=fixture(t);await syncGangpot(f.ctx,f.client,SAT);const paid=pay(f,ACTOR);await reviewGangpotPayment(f.ctx,f.guild,f.lead,paid.id,'approve',()=>SAT+1000);
  const exempt='100000000000000020';await setExemption(f.ctx,f.guild,f.lead,exempt,'17-10-2026','Vakantie',false,SAT+1000);
  await syncGangpot(f.ctx,f.client,FRI-1000);assert.equal(f.ctx.store.db.prepare("SELECT COUNT(*) AS n FROM feature_notices WHERE kind='gangpot.member'").get().n,0);
  await syncGangpot(f.ctx,f.client,FRI);await syncGangpot(f.ctx,f.client,FRI+1000);
  assert.equal(f.ctx.store.db.prepare("SELECT COUNT(*) AS n FROM feature_notices WHERE kind='gangpot.member' AND user_id=? AND status='sent'").get(OTHER).n,1);
  for(const user of [ACTOR,exempt])assert.equal(f.ctx.store.db.prepare("SELECT COUNT(*) AS n FROM feature_notices WHERE kind='gangpot.member' AND user_id=?").get(user).n,0);
  await syncGangpot(f.ctx,f.client,Date.parse('2026-10-17T16:00:00Z'));assert.equal(f.ctx.store.db.prepare("SELECT COUNT(*) AS n FROM feature_notices WHERE user_id=? AND kind='gangpot.member'").get(OTHER).n,2);
  await syncGangpot(f.ctx,f.client,END);assert.equal(f.ctx.store.db.prepare("SELECT COUNT(*) AS n FROM feature_notices WHERE user_id=? AND kind='gangpot.member'").get(OTHER).n,2);
});

test('DM-blokkades spammen niet; een mislukte herinnering wordt na betalen overgeslagen en Lead krijgt één privé-overzicht',async t=>{
  const f=fixture(t);await syncGangpot(f.ctx,f.client,SAT);const user=f.guild.members.cache.get(OTHER).user,send=user.send;let attempts=0;user.send=async()=>{attempts++;throw Object.assign(new Error('DM geblokkeerd'),{code:50007});};
  await syncGangpot(f.ctx,f.client,FRI);await syncGangpot(f.ctx,f.client,FRI+60000);assert.equal(attempts,1);user.send=send;
  const paid=pay(f);await reviewGangpotPayment(f.ctx,f.guild,f.lead,paid.id,'approve',()=>FRI+1000);
  await syncGangpot(f.ctx,f.client,Date.parse('2026-10-17T18:00:00Z'));await syncGangpot(f.ctx,f.client,Date.parse('2026-10-17T18:01:00Z'));
  assert.equal(f.ctx.store.db.prepare("SELECT COUNT(*) AS n FROM feature_notices WHERE kind='gangpot.lead' AND status='sent'").get().n,1);
  assert.ok([...f.guild.channels.cache.get(f.ctx.config.logChannelId).posted.values()].some(message=>message.embeds?.[0]?.title==='Legion — Betalingen wachten op Lead'));
  assert.equal(f.ctx.store.db.prepare("SELECT COUNT(*) AS n FROM feature_notices WHERE user_id=? AND kind='gangpot.member'").get(OTHER).n,1);
});

test('dashboardinstellingen bewaren bedrag en tijden; lopende gangpotweek verandert alleen na expliciete bevestiging',async t=>{
  const f=fixture(t);t.mock.method(Date,'now',()=>SAT);await syncGangpot(f.ctx,f.client,SAT);const dashboard=new Dashboard({...f,locks:new Locks()});
  await dashboard.action(f.ctx,f.guild,f.lead,{action:'settings.save',settings:{operations:{gangpot:{weeklyAmount:30000,fridayTime:'17:00',saturdayTime:'17:00',leadTime:'19:00'}}}});
  assert.equal(f.ctx.store.db.prepare("SELECT weekly_amount FROM gangpot_periods WHERE id='2026-10-17'").get().weekly_amount,25000);
  await assert.rejects(dashboard.action(f.ctx,f.guild,f.lead,{action:'settings.save',settings:{operations:{gangpot:{weeklyAmount:40000}}},applyCurrent:true}),/Bevestig/);
  assert.equal(f.ctx.config.gangpot.weeklyAmount,30000);
  await dashboard.action(f.ctx,f.guild,f.lead,{action:'settings.save',settings:{operations:{gangpot:{weeklyAmount:35000}}},applyCurrent:true,confirm:true});assert.equal(f.ctx.store.db.prepare("SELECT weekly_amount FROM gangpot_periods WHERE id='2026-10-17'").get().weekly_amount,35000);
  const restored={config:{...f.ctx.config,operations:undefined,gangpot:{...f.base.guilds[0].gangpot}},store:f.ctx.store};loadDashboardSettings(restored);assert.equal(operationSettings(restored).gangpot.weeklyAmount,35000);assert.equal(operationSettings(restored).gangpot.fridayTime,'17:00');
  assert.throws(()=>validateDashboardSettings({operations:{gangpot:{weeklyAmount:-1}}}));assert.throws(()=>validateDashboardSettings({operations:{fishing:{reward:0}}}));
});

test('vangstenboek telt goede en zeldzame items; weekbeloningen worden één keer betaald, blijven per guild en verwerpen oude kaarten',async t=>{
  const f=fixture(t);saveDashboardSettings(f.ctx,{operations:{fishing:{target:2,rareTarget:1,reward:100,rareReward:200}}},ACTOR);
  f.ctx.store.fish(OTHER,60,SAT);assert.equal(f.ctx.store.fishBook(OTHER,SAT).collection.length,0);
  f.ctx.store.fish(OTHER,0,SAT);f.ctx.store.fish(OTHER,42,SAT);const book=f.ctx.store.fishBook(OTHER,SAT);assert.equal(book.progress.total,2);assert.equal(book.progress.rare,1);assert.equal(book.collection.length,2);
  const balance=f.ctx.store.wallet(OTHER).balance;const reward=f.ctx.store.claimFishWeek(OTHER,book.week,SAT);assert.equal(reward.reward,300);assert.equal(reward.balance,balance+300);
  assert.throws(()=>f.ctx.store.claimFishWeek(OTHER,book.week,SAT),/geen nieuwe/);assert.equal(f.source.store.fishBook(OTHER,SAT).collection.length,0);
  saveDashboardSettings(f.ctx,{operations:{fishing:{reward:999}}},ACTOR);assert.equal(f.ctx.store.fishBook(OTHER,SAT).settings.reward,100);assert.equal(f.ctx.store.fishBook(OTHER,SAT+7*86400000).settings.reward,999);
  assert.throws(()=>f.ctx.store.claimFishWeek(OTHER,book.week,SAT+7*86400000),/andere week/);
  await assert.rejects(handleFishBookButton(f.ctx,{customId:`fishbook:claim:${OTHER}:${book.week}`,user:{id:ACTOR}}),/eigen verzameling/);
  assert.ok(fishBookMessage(f.ctx,OTHER,SAT).embeds[0].data.description.includes('fictieve'));
});

test('commands en fouten worden gelogd zonder privé-opties; Discord-logherstel dupliceren geen bericht',async t=>{
  const f=fixture(t);f.ctx.store.setSetting('audit:cursor',String(f.ctx.store.db.prepare('SELECT MAX(id) AS n FROM audit').get().n));
  const interaction={id:'123456789012345678',user:{id:OTHER},commandName:'gangpot',channelId:f.ctx.config.gangpot.paymentsChannelId,isChatInputCommand:()=>true,options:{data:[{name:'betaling',type:1,options:[{name:'notitie',type:3,value:'privé medische tekst'},{name:'bedrag',type:4,value:25000}]}]}};
  recordInteraction(f.ctx,interaction,'started');recordInteraction(f.ctx,interaction,'failed',Object.assign(new Error('Never log this body'),{code:50013}));
  const audit=f.ctx.store.db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 1').get();assert.ok(!audit.details.includes('medische')&&!audit.details.includes('Never log'));assert.ok(audit.details.includes('50013'));
  assert.equal(cleanAudit({token:'hidden',url:'https://example.com/#login=hidden',reason:'private'}).token,'[afgeschermd]');
  const channel=f.guild.channels.cache.get(f.ctx.config.botLogChannelId),send=channel.send;channel.send=async()=>{throw Object.assign(new Error('offline'),{code:503});};await flushAuditLogs(f.ctx,f.guild,SAT);channel.send=send;
  await flushAuditLogs(f.ctx,f.guild,SAT+61000);await flushAuditLogs(f.ctx,f.guild,SAT+62000);assert.equal(channel.posted.size,1);
  const job=f.ctx.store.db.prepare('SELECT * FROM audit_deliveries WHERE message_id IS NOT NULL').get();f.ctx.store.db.prepare('UPDATE audit_deliveries SET message_id=NULL WHERE id=?').run(job.id);f.ctx.store.setSetting('audit:cursor','0');await flushAuditLogs(f.ctx,f.guild,SAT+63000);assert.equal(channel.posted.size,1);
});

test('changelog wordt één keer per versie geplaatst en herstelt een verstuurd bericht na een herstart',async t=>{
  const f=fixture(t),channel=f.guild.channels.cache.get(f.ctx.config.updateChannelId);assert.ok(releaseNotes[releaseVersion].length>0);
  await announceRelease(f.ctx,f.guild);await announceRelease(f.ctx,f.guild);assert.equal(channel.posted.size,1);
  f.ctx.store.db.prepare('UPDATE release_announcements SET message_id=NULL WHERE version=?').run(releaseVersion);await announceRelease(f.ctx,f.guild);assert.equal(channel.posted.size,1);
  await announceRelease(f.ctx,f.guild,'1.7.1',['Een nieuwe verbetering.']);assert.equal(channel.posted.size,2);
});

test('botstatus toont wachtende acties; sollicitatie- en ticketcreatie blijven uitsluitend in de community',t=>{
  const f=fixture(t),health=botHealth(f.ctx,f.client);assert.equal(health.ready,true);assert.ok(Object.hasOwn(health.counts,'logs'));
  assert.throws(()=>f.ctx.store.reserveCase('application',OTHER,{}),/community/);assert.throws(()=>f.ctx.store.reserveCase('ticket',OTHER,{}),/uitgeschakeld/);
  const main=commands(500,false),community=commands(500,true);assert.ok(!main.some(item=>['solliciteren','ticket'].includes(item.name)));assert.ok(community.some(item=>item.name==='solliciteren')&&community.some(item=>item.name==='ticket'));
  for(const name of ['afwezig','afmelden','botstatus','vangstenboek'])assert.ok(main.some(item=>item.name===name));
});

test('een gewijzigde zaterdagdeadline gebruikt Belgische tijd en geeft geen gangwarn vóór die nieuwe deadline',async t=>{
  const f=fixture(t);saveDashboardSettings(f.ctx,{operations:{gangpot:{deadlineTime:'21:00',fridayTime:'16:00',saturdayTime:'16:00',leadTime:'18:00'}}},ACTOR);await syncGangpot(f.ctx,f.client,SAT);
  const end=Date.parse('2026-10-17T19:01:00Z');assert.equal(f.ctx.store.db.prepare("SELECT ends_at FROM gangpot_periods WHERE id='2026-10-17'").get().ends_at,end);
  await syncGangpot(f.ctx,f.client,end-1);assert.equal(warns(f).length,0);await syncGangpot(f.ctx,f.client,end);assert.equal(warns(f).length,1);
});

test('ongeldige gecombineerde instellingen veranderen geen huidige waarden of opgeslagen configuratie',async t=>{
  const f=fixture(t),dashboard=new Dashboard({...f,locks:new Locks()}),before=f.ctx.config.color;
  await assert.rejects(dashboard.action(f.ctx,f.guild,f.lead,{action:'settings.save',settings:{color:'#000000',operations:{gangpot:{deadlineTime:'12:00'}}}}),/vóór de deadline/);
  assert.equal(f.ctx.config.color,before);assert.equal(f.ctx.store.setting('dashboard-config'),undefined);
  const unauthorized=f.guild.members.cache.get(OTHER);await assert.rejects(dashboard.action(f.ctx,f.guild,unauthorized,{action:'settings.save',settings:{channels:{botLogChannelId:f.ctx.config.warnLogChannelId}}}),/administrator/);
});

test('afmeldembed heeft twee knoppen; lange afwezigheid kan volledig met eigen keuzelijsten worden aangevraagd en het paneel blijft één bericht',async t=>{
  const f=fixture(t);const panel=await publishAbsencePanel(f.ctx,f.guild);await publishAbsencePanel(f.ctx,f.guild);
  assert.equal(f.guild.channels.cache.get('1555685636017758248').posted.size,1);assert.deepEqual(panel.components[0].components.map(item=>item.custom_id),['absencepanel:planning','absencepanel:range']);
  let reply;const base={guild:f.guild,user:f.guild.members.cache.get(OTHER).user,channelId:panel.channelId,message:panel,deferReply:async()=>{},deferUpdate:async()=>{},editReply:async value=>{reply=value;}};
  await handleAbsencePanel(f.ctx,{...base,customId:'absencepanel:range'},SAT);
  const id=f.ctx.store.db.prepare('SELECT id FROM absence_drafts WHERE user_id=?').get(OTHER).id;
  await assert.rejects(handleAbsenceSelection(f.ctx,{...base,user:{id:ACTOR},customId:`absflow:choose:${id}:0`,values:['2026-10']},SAT),/iemand anders/);
  for(const value of ['2026-10','2026-10-10','2026-11','2026-11-20','holiday']){
    const draft=f.ctx.store.db.prepare('SELECT * FROM absence_drafts WHERE id=?').get(id);await handleAbsenceSelection(f.ctx,{...base,customId:`absflow:choose:${id}:${draft.revision}`,values:[value]},SAT);
  }
  const request=f.ctx.store.db.prepare('SELECT * FROM absence_requests WHERE user_id=?').get(OTHER);assert.equal(request.status,'pending');assert.equal(request.start_date,'2026-10-10');assert.equal(request.end_date,'2026-11-20');assert.equal(request.reason,'Vakantie');assert.ok(reply.content.includes('Lead moet goedkeuren'));
  assert.equal(f.ctx.store.db.prepare('SELECT * FROM absence_drafts WHERE id=?').get(id),undefined);
});

test('planningknop in afmeldembed laat het lid een planning kiezen en maakt geen goedgekeurde afmelding',async t=>{
  const f=fixture(t);t.mock.method(Date,'now',()=>SAT);const created=await createActivity(f.ctx,{guild:f.guild,user:f.lead.user,member:f.lead,memberPermissions:f.lead.permissions},{date:'12-10-2026',time:'20:00',location:'HQ'},SAT);
  const panel=await publishAbsencePanel(f.ctx,f.guild);let reply;const base={guild:f.guild,user:f.guild.members.cache.get(OTHER).user,channelId:panel.channelId,message:panel,deferReply:async()=>{},deferUpdate:async()=>{},editReply:async value=>{reply=value;}};
  await handleAbsencePanel(f.ctx,{...base,customId:'absencepanel:planning'},SAT);assert.equal(reply.components[0].toJSON().components[0].options[0].value,created.id);
  await handleAbsenceSelection(f.ctx,{...base,customId:`absplan:choose:${OTHER}`,values:[created.id]},SAT);
  assert.equal(f.ctx.store.db.prepare('SELECT status FROM absence_requests WHERE activity_id=? AND user_id=?').get(created.id,OTHER).status,'pending');
  assert.equal(f.ctx.store.db.prepare('SELECT response FROM activity_rsvps WHERE activity_id=? AND user_id=?').get(created.id,OTHER).response,'no');
});
