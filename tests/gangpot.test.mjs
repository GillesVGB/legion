import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {dashboardFixture,ACTOR,OTHER} from './dashboard-fixture.mjs';
import {Store} from '../src/store.mjs';
import {commands} from '../src/commands.mjs';
import {Dashboard} from '../src/dashboard.mjs';
import {Locks} from '../src/locks.mjs';
import {gangpotWindow,syncGangpot,reportGangpotPayment,reviewGangpotPayment,gangpotBalance,gangpotPaid,gangpotMembers,gangpotSummary,recordGangpotEntry,voidGangpotEntry,removeGangpotPayment,handleGangpotCommand,handleGangpotReview} from '../src/gangpot.mjs';

const SAT=Date.parse('2026-10-10T10:00:00Z'),DEADLINE=Date.parse('2026-10-17T21:59:30Z'),END=Date.parse('2026-10-17T22:00:00Z');
const fixture=t=>{const f=dashboardFixture();t.after(f.close);const main=f.contexts.values().next().value,guild=f.guilds.get(main.config.guildId);for(const id of [ACTOR,OTHER])guild.members.cache.get(id).roles.cache.set(main.config.gangpot.memberRoleId,guild.roles.cache.get(main.config.gangpot.memberRoleId));return{...f,main,guild,lead:guild.members.cache.get(ACTOR)};};
const period=f=>f.main.store.db.prepare("SELECT * FROM gangpot_periods WHERE id='2026-10-17'").get();
const claim=(f,user=OTHER,amount=25000,key=`claim-request-${user}`)=>reportGangpotPayment(f.main,{userId:user,amount,periodId:period(f).id,requestId:key,note:'In-game overgemaakt'},SAT);
const warns=(f,user)=>f.main.store.db.prepare("SELECT * FROM warnings WHERE user_id=? AND reason LIKE 'Gangpot t/m %'").all(user);
const removal=(f,user=OTHER,key='payment-removal-request')=>({userId:user,periodId:period(f).id,actor:ACTOR,requestId:key,reason:'Per ongeluk goedgekeurd'});

test('gangpottermijnen eindigen zaterdag 23:59 Belgische tijd, inclusief eerste weekend en wintertijd',()=>{
  const config={startsOn:'2026-10-10',weeklyAmount:25000};
  assert.equal(gangpotWindow(config,SAT).starts_at,Date.parse('2026-10-09T22:00:00Z'));
  assert.equal(gangpotWindow(config,DEADLINE).id,'2026-10-17');
  assert.equal(gangpotWindow(config,DEADLINE).ends_at,END);
  assert.equal(gangpotWindow(config,END).id,'2026-10-24');
  assert.equal(gangpotWindow(config,SAT).id,'2026-10-17'); // Niet al straffen op de dag waarop het systeem begint.
  const dst=gangpotWindow(config,Date.parse('2026-10-30T12:00:00Z'));
  assert.equal(dst.ends_at,Date.parse('2026-10-31T23:00:00Z'));
  assert.equal(dst.ends_at-dst.starts_at,169*3600000);
  assert.equal(gangpotWindow(config,Date.parse('2026-10-09T12:00:00Z')),null);
});

test('leden met de ledenrol staan in de gangpot; uitleg en totaal blijven in afzonderlijke vaste berichten en community wordt geweigerd',async t=>{
  const f=fixture(t);await syncGangpot(f.main,f.client,SAT);
  const humans=[...f.guild.members.cache.values()].filter(member=>!member.user.bot&&member.roles.cache.has(f.main.config.gangpot.memberRoleId));
  assert.equal(gangpotMembers(f.main,period(f),SAT).length,humans.length);
  assert.ok(gangpotMembers(f.main,period(f),SAT).some(item=>item.user_id===ACTOR));
  const payment=f.guild.channels.cache.get('1558238040932225034'),info=f.guild.channels.cache.get('1555685634515927050'),total=f.guild.channels.cache.get('1558420548000813126');
  const ids=[info.posted.first().id,total.posted.first().id];
  f.main.store.db.prepare("DELETE FROM settings WHERE key LIKE 'gangpot:%'").run();
  await syncGangpot(f.main,f.client,SAT+60000);
  assert.equal(payment.posted.size,0);assert.equal(info.posted.size,1);assert.equal(total.posted.size,1);
  assert.deepEqual([info.posted.first().id,total.posted.first().id],ids);
  assert.ok(info.posted.first().embeds[0].description.includes('Ook een melding die nog op controle wacht geeft geen uitstel'));
  assert.equal(info.posted.first().embeds[0].fields,undefined);
  assert.ok(!info.posted.first().embeds[0].description.includes('saldo'));
  assert.throws(()=>reportGangpotPayment(f.source,{userId:OTHER,amount:25000,requestId:'community-test',periodId:'2026-10-17'},SAT),/hoofdserver/);
  assert.equal(commands(10000,true).some(command=>command.name==='gangpot'),false);
  const pay=commands(10000,false).find(command=>command.name==='gangpot').options.find(option=>option.name==='betaling');
  assert.ok(!pay.options.some(option=>['lid','betaald_op'].includes(option.name)));
});

test('leden melden hun eigen betaling; de melding wacht op Lead en raakt saldo of fun-coins niet aan',async t=>{
  const f=fixture(t);t.mock.method(Date,'now',()=>SAT);await syncGangpot(f.main,f.client,SAT);
  let reply;const member=f.guild.members.cache.get(OTHER),wallet=f.main.store.wallet(OTHER).balance;
  await handleGangpotCommand(f.main,{id:'100000000000999999',createdTimestamp:SAT,guild:f.guild,client:f.client,user:member.user,member,memberPermissions:member.permissions,options:{getSubcommand:()=> 'betaling',getString:()=>null,getInteger:()=>null},deferReply:async()=>{},editReply:async value=>{reply=value;}});
  const stored=f.main.store.db.prepare('SELECT * FROM gangpot_claims').get();
  assert.equal(stored.user_id,OTHER);assert.equal(stored.status,'pending');assert.equal(stored.amount,25000);
  assert.equal(gangpotBalance(f.main),0);assert.equal(f.main.store.wallet(OTHER).balance,wallet);
  assert.ok(reply.content.includes('Lead moet'));
  const message=f.guild.channels.cache.get(f.main.config.gangpot.paymentsChannelId).posted.get(stored.message_id);
  assert.deepEqual(message.components[0].components.map(button=>button.label),['✅ Goedkeuren','❌ Afkeuren']);
});

test('één pending melding per lid/week, veilige herhaling en controle van bedrag',async t=>{
  const f=fixture(t);await syncGangpot(f.main,f.client,SAT);const first=claim(f);
  assert.equal(claim(f).id,first.id);
  assert.throws(()=>claim(f,OTHER,25000,'different-request'),/al een betaalmelding/);
  assert.throws(()=>claim(f,ACTOR,25001,'too-much-request'),/25.000/);
  assert.throws(()=>claim(f,ACTOR,-1,'negative-request'),/geldig betaald bedrag/);
  assert.throws(()=>claim(f,ACTOR,0.5,'decimal-request'),/geldig betaald bedrag/);
  assert.equal(gangpotBalance(f.main),0);
});

test('alleen een actuele Lead-rol kan goedkeuren; gelijktijdige vinkjes boeken precies één transactie',async t=>{
  const f=fixture(t);await syncGangpot(f.main,f.client,SAT);const item=claim(f);
  const admin=f.guild.addMember('100000000000000200','Admin zonder Lead',[],true);
  await assert.rejects(reviewGangpotPayment(f.main,f.guild,admin,item.id,'approve',()=>DEADLINE),/Lead-rol/);
  await assert.rejects(reviewGangpotPayment(f.main,f.guild,f.guild.members.cache.get(OTHER),item.id,'approve',()=>DEADLINE),/Lead-rol/);
  await Promise.all([reviewGangpotPayment(f.main,f.guild,f.lead,item.id,'approve',()=>DEADLINE),reviewGangpotPayment(f.main,f.guild,f.lead,item.id,'reject',()=>DEADLINE)]);
  assert.equal(gangpotBalance(f.main),25000);assert.equal(f.main.store.db.prepare('SELECT COUNT(*) AS n FROM gangpot_entries').get().n,1);
  assert.equal(gangpotPaid(f.main,period(f),OTHER).on_time,25000);
  await syncGangpot(f.main,f.client,DEADLINE);
  const total=f.guild.channels.cache.get(f.main.config.gangpot.totalChannelId).posted.first(),info=f.guild.channels.cache.get(f.main.config.gangpot.infoChannelId).posted.first();
  assert.ok(total.embeds[0].description.includes('$25.000')&&total.embeds[0].fields.some(field=>field.value.includes(`<@${OTHER}>`)));
  assert.ok(!info.embeds[0].description.includes(`<@${OTHER}>`));assert.equal(info.embeds[0].fields,undefined);
  await syncGangpot(f.main,f.client,END);assert.equal(warns(f,OTHER).length,0);
});

test('zonder ledenrol hoeft een lid niet te betalen, kan het geen melding maken en krijgt het geen automatische warn',async t=>{
  const f=fixture(t);t.mock.method(Date,'now',()=>SAT);
  const id='100000000000000077',person=f.guild.addMember(id,'Geen gangrol',[f.main.config.staffRoleIds[0]],true);
  await syncGangpot(f.main,f.client,SAT);
  assert.ok(!gangpotMembers(f.main,period(f),SAT).some(item=>item.user_id===id));
  assert.throws(()=>claim(f,id),/betaaloverzicht/);
  await assert.rejects(handleGangpotCommand(f.main,{id:'100000000000999997',createdTimestamp:SAT,guild:f.guild,client:f.client,user:person.user,member:person,options:{getSubcommand:()=> 'betaling',getString:()=>null,getInteger:()=>null},deferReply:async()=>{},editReply:async()=>{}}),/Alleen leden met rol/);
  // Een oude versie kan deze persoon wel hebben ingeschreven; de nieuwe deadlinecontrole sluit hem alsnog uit.
  f.main.store.db.prepare('INSERT INTO gangpot_dues(period_id,user_id,enrolled_at) VALUES(?,?,?)').run(period(f).id,id,SAT);
  f.guild.members.cache.get(OTHER).roles.cache.delete(f.main.config.gangpot.memberRoleId);
  await syncGangpot(f.main,f.client,END);
  assert.equal(warns(f,id).length,0);assert.equal(warns(f,OTHER).length,0);
  assert.equal(f.main.store.db.prepare('SELECT active FROM gangpot_dues WHERE period_id=? AND user_id=?').get(period(f).id,id).active,0);
});

test('een ontvangen ledenrol schrijft het lid in, ook als het later in de week lid wordt',async t=>{
  const f=fixture(t),id='100000000000000078',member=f.guild.addMember(id,'Nieuw lid',[]);
  await syncGangpot(f.main,f.client,SAT);assert.ok(!gangpotMembers(f.main,period(f),SAT).some(item=>item.user_id===id));
  member.roles.cache.set(f.main.config.gangpot.memberRoleId,f.guild.roles.cache.get(f.main.config.gangpot.memberRoleId));
  await syncGangpot(f.main,f.client,SAT+86400000);assert.ok(gangpotMembers(f.main,period(f),SAT).some(item=>item.user_id===id&&item.active));
  await syncGangpot(f.main,f.client,END);assert.equal(warns(f,id).length,1);
});

test('migratie bewaart oude zondagbetalingen en meldingen, hergebruikt de oude gangpot-embed als informatie en verplaatst het totaal',async t=>{
  const f=fixture(t),old='2026-10-11';
  f.main.store.db.prepare('INSERT INTO gangpot_periods(id,starts_at,ends_at,weekly_amount) VALUES(?,?,?,?)').run(old,Date.parse('2026-10-09T22:00:00Z'),Date.parse('2026-10-11T22:00:00Z'),25000);
  for(const id of [OTHER,ACTOR])f.main.store.db.prepare('INSERT INTO gangpot_dues(period_id,user_id,enrolled_at) VALUES(?,?,?)').run(old,id,SAT);
  const reported=reportGangpotPayment(f.main,{userId:OTHER,amount:25000,periodId:old,requestId:'legacy-paid-request'},SAT);
  await reviewGangpotPayment(f.main,f.guild,f.lead,reported.id,'approve',()=>SAT+1000);
  const pending=reportGangpotPayment(f.main,{userId:ACTOR,amount:25000,periodId:old,requestId:'legacy-pending-request'},SAT);
  const information=f.guild.channels.cache.get(f.main.config.gangpot.infoChannelId),payments=f.guild.channels.cache.get(f.main.config.gangpot.paymentsChannelId);
  const oldTotal=await information.send({embeds:[{title:'Oud totaal',description:'$25.000',footer:{text:'Legion • Totaal gangpot'}}]}),oldPanel=await payments.send({embeds:[{footer:{text:'Legion • Gangpotbetalingen'}}]});
  const someoneElse=await payments.send({embeds:[{footer:{text:'Legion • Gangpotbetalingen'}}]});someoneElse.author={id:OTHER};
  f.main.store.setSetting('gangpot:total:message',oldTotal.id);f.main.store.setSetting('gangpot:payments:message',oldPanel.id);
  await syncGangpot(f.main,f.client,SAT+2000);
  assert.equal(f.main.store.db.prepare('SELECT * FROM gangpot_periods WHERE id=?').get(old),undefined);
  assert.equal(f.main.store.db.prepare('SELECT period_id FROM gangpot_claims WHERE id=?').get(pending.id).period_id,'2026-10-17');
  assert.equal(gangpotPaid(f.main,period(f),OTHER).on_time,25000);assert.equal(gangpotBalance(f.main),25000);
  assert.equal(information.posted.size,1);assert.equal(information.posted.first().id,oldTotal.id);assert.equal(information.posted.first().embeds[0].footer.text,'Legion • Gangpotinformatie');
  assert.equal(payments.posted.has(oldPanel.id),false);assert.equal(payments.posted.has(someoneElse.id),true);
  const total=f.guild.channels.cache.get('1558420548000813126').posted.first();assert.ok(total.embeds[0].fields[0].value.includes(`<@${OTHER}>`));
  await syncGangpot(f.main,f.client,Date.parse('2026-10-12T10:00:00Z'));assert.equal(warns(f,ACTOR).length,0);
  await syncGangpot(f.main,f.client,END);assert.equal(warns(f,ACTOR).length,1);assert.equal(warns(f,OTHER).length,0);
});

test('geen commando, pending zonder vinkje, afkeuring en gedeeltelijke goedkeuring geven elk één automatische warn',async t=>{
  const f=fixture(t);await syncGangpot(f.main,f.client,SAT);
  const pending=claim(f),rejected=claim(f,ACTOR),partialUser='100000000000000020',partial=claim(f,partialUser,10000);
  await reviewGangpotPayment(f.main,f.guild,f.lead,rejected.id,'reject',()=>DEADLINE);
  await reviewGangpotPayment(f.main,f.guild,f.lead,partial.id,'approve',()=>DEADLINE);
  await syncGangpot(f.main,f.client,DEADLINE);assert.equal(warns(f,OTHER).length,0);
  await syncGangpot(f.main,f.client,END);await syncGangpot(f.main,f.client,END+60000);
  for(const user of [OTHER,ACTOR,partialUser,'100000000000000021'])assert.equal(warns(f,user).length,1);
  assert.equal(f.main.store.db.prepare('SELECT status FROM gangpot_claims WHERE id=?').get(pending.id).status,'pending');
  const warnId=warns(f,OTHER)[0].id;
  assert.equal(f.calls.filter(call=>call.method==='dm'&&call.user===OTHER&&(call.payload.embeds[0].data||call.payload.embeds[0]).description.includes(warnId)).length,1);
  assert.equal(f.guild.channels.cache.get(f.main.config.warnLogChannelId).posted.size,f.main.store.db.prepare("SELECT COUNT(*) AS n FROM gangpot_notifications WHERE kind='issue'").get().n);
});

test('goedkeuring na de deadline verwijdert geen warn en kan niet worden teruggedateerd naar de melding',async t=>{
  const f=fixture(t);await syncGangpot(f.main,f.client,SAT);const item=claim(f);
  await syncGangpot(f.main,f.client,END);
  const warning=warns(f,OTHER)[0];await reviewGangpotPayment(f.main,f.guild,f.lead,item.id,'approve',()=>END);
  assert.equal(gangpotBalance(f.main),25000);assert.equal(gangpotPaid(f.main,period(f),OTHER).on_time,0);
  await syncGangpot(f.main,f.client,END+120000);
  assert.equal(warns(f,OTHER).length,1);assert.equal(warns(f,OTHER)[0].id,warning.id);assert.equal(warns(f,OTHER)[0].removed_at,null);
});

test('betalingscorrecties na de deadline geven één warn en verloren Discord-bezorging wordt herhaald zonder nieuwe warns',async t=>{
  const f=fixture(t);await syncGangpot(f.main,f.client,SAT);const item=claim(f);
  const approved=await reviewGangpotPayment(f.main,f.guild,f.lead,item.id,'approve',()=>DEADLINE);
  await syncGangpot(f.main,f.client,END);assert.equal(warns(f,OTHER).length,0);
  voidGangpotEntry(f.main,approved.payment_id,ACTOR,'Betaling was verkeerd bevestigd',END+1000);
  const id=warns(f,OTHER)[0].id;
  const channel=f.guild.channels.cache.get(f.main.config.warnLogChannelId),send=channel.send;
  channel.send=async()=>{throw Object.assign(new Error('tijdelijk offline'),{code:503});};
  await syncGangpot(f.main,f.client,END+2000);assert.equal(warns(f,OTHER).length,1);
  channel.send=send;await syncGangpot(f.main,f.client,END+63000);
  assert.equal(warns(f,OTHER).length,1);assert.equal(warns(f,OTHER)[0].id,id);
  assert.equal(f.main.store.db.prepare('SELECT log_id,dm_id FROM gangpot_notifications WHERE warn_id=?').get(id).log_id!==null,true);
  assert.equal(gangpotBalance(f.main),0);
});

test('afkeuring geeft geen saldo; lid kan opnieuw melden en Lead kan vóór de deadline goedkeuren',async t=>{
  const f=fixture(t);await syncGangpot(f.main,f.client,SAT);const first=claim(f);
  await reviewGangpotPayment(f.main,f.guild,f.lead,first.id,'reject',()=>SAT+1000);
  assert.equal(gangpotBalance(f.main),0);
  const second=claim(f,OTHER,25000,'claim-second-request');await reviewGangpotPayment(f.main,f.guild,f.lead,second.id,'approve',()=>DEADLINE);
  await syncGangpot(f.main,f.client,END);assert.equal(warns(f,OTHER).length,0);assert.equal(gangpotBalance(f.main),25000);
});

test('gangpotboekhouding weigert dubbele uitgaven en negatieve saldi; correcties bewaren de oorspronkelijke historie',async t=>{
  const f=fixture(t);await syncGangpot(f.main,f.client,SAT);
  const donation={kind:'donation',amount:50000,actor:ACTOR,requestId:'donation-request'};
  const entry=recordGangpotEntry(f.main,donation,SAT);assert.equal(recordGangpotEntry(f.main,donation,SAT).id,entry.id);
  const expense=recordGangpotEntry(f.main,{kind:'expense',amount:30000,actor:ACTOR,requestId:'expense-request'},SAT);
  assert.equal(gangpotBalance(f.main),20000);
  assert.throws(()=>recordGangpotEntry(f.main,{kind:'expense',amount:20001,actor:ACTOR,requestId:'big-expense-request'},SAT),/groter/);
  assert.throws(()=>voidGangpotEntry(f.main,entry.id,ACTOR,'Fout bedrag',SAT),/saldo niet negatief/);
  voidGangpotEntry(f.main,expense.id,ACTOR,'Uitgave terugbetaald',SAT);assert.equal(gangpotBalance(f.main),50000);
  voidGangpotEntry(f.main,entry.id,ACTOR,'Fout bedrag',SAT);assert.equal(gangpotBalance(f.main),0);
  assert.equal(f.main.store.db.prepare('SELECT COUNT(*) AS n FROM gangpot_entries').get().n,2);
});

test('bij een mislukte ledencontrole komen geen valse warns; een vertrokken lid en bots worden uitgesloten',async t=>{
  const f=fixture(t);await syncGangpot(f.main,f.client,SAT);
  const list=f.guild.members.list;f.guild.members.list=async()=>{throw Object.assign(new Error('Discord tijdelijk offline'),{code:503});};
  await assert.rejects(syncGangpot(f.main,f.client,END),/tijdelijk offline/);assert.equal(warns(f,OTHER).length,0);
  f.guild.members.list=list;f.guild.members.cache.delete(OTHER);await syncGangpot(f.main,f.client,END);
  assert.equal(warns(f,OTHER).length,0);assert.equal(warns(f,f.client.user.id).length,0);
});

test('gangpotwaarschuwingen en betaalmeldingen blijven na een echte SQLite-herstart bewaard zonder duplicaten',async t=>{
  const f=fixture(t),dir=mkdtempSync(join(tmpdir(),'legion-gangpot-')),path=join(dir,'guild.sqlite');
  t.after(()=>{assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep+'legion-gangpot-'));rmSync(dir,{recursive:true,force:true});});
  f.main.store.close();f.main.store=new Store(f.main.config,path);
  await syncGangpot(f.main,f.client,SAT);const item=claim(f);await syncGangpot(f.main,f.client,END);
  const id=warns(f,OTHER)[0].id,messages=f.guild.channels.cache.get(f.main.config.gangpot.paymentsChannelId).posted.size;
  f.main.store.close();f.main.store=new Store(f.main.config,path);await syncGangpot(f.main,f.client,END+60000);
  assert.equal(warns(f,OTHER).length,1);assert.equal(warns(f,OTHER)[0].id,id);
  assert.equal(f.main.store.db.prepare('SELECT id FROM gangpot_claims').get().id,item.id);
  assert.equal(f.guild.channels.cache.get(f.main.config.gangpot.paymentsChannelId).posted.size,messages);
});

test('dashboard beoordeelt bestaande meldingen met Lead-controle; oude directe betaling-route en verkeerde knoppen werken niet',async t=>{
  const f=fixture(t);t.mock.method(Date,'now',()=>SAT);await syncGangpot(f.main,f.client,SAT);const item=claim(f);await syncGangpot(f.main,f.client,SAT);
  const dashboard=new Dashboard({...f,locks:new Locks()}),admin=f.guild.addMember('100000000000000200','Admin',[],true);
  await assert.rejects(dashboard.action(f.main,f.guild,admin,{action:'gangpot.approve',id:item.id,confirm:true}),/Lead-rol/);
  await assert.rejects(dashboard.action(f.main,f.guild,f.lead,{action:'gangpot.payment',userId:OTHER,amount:25000,confirm:true}),/Onbekende/);
  await assert.rejects(handleGangpotReview(f.main,{customId:`gangpot:approve:${item.id}`,channelId:'wrong',message:{id:item.message_id},deferReply:async()=>{}}),/hoort niet/);
  await dashboard.action(f.main,f.guild,f.lead,{action:'gangpot.approve',id:item.id,confirm:true});assert.equal(gangpotBalance(f.main),25000);
  assert.equal(dashboard.summary(f.main,f.guild,f.lead).canReviewGangpot,true);assert.equal(dashboard.summary(f.main,f.guild,admin).canReviewGangpot,false);
});

test('betalingen verwijderen per gebruiker corrigeert alle deelbetalingen, laat andere leden en donaties ongemoeid en bewaart historie',async t=>{
  const f=fixture(t);await syncGangpot(f.main,f.client,SAT);
  const first=claim(f,OTHER,10000);await reviewGangpotPayment(f.main,f.guild,f.lead,first.id,'approve',()=>SAT+1000);
  const second=claim(f,OTHER,15000,'second-part-request');await reviewGangpotPayment(f.main,f.guild,f.lead,second.id,'approve',()=>SAT+2000);
  const other=claim(f,ACTOR);await reviewGangpotPayment(f.main,f.guild,f.lead,other.id,'approve',()=>SAT+3000);
  recordGangpotEntry(f.main,{kind:'donation',amount:7000,requestId:'donation-remove-test',actor:ACTOR},SAT+3000);
  const wallet=f.main.store.wallet(OTHER).balance;
  const result=removeGangpotPayment(f.main,removal(f),SAT+4000);
  assert.equal(result.amount,25000);assert.equal(result.claim_count,2);assert.equal(gangpotBalance(f.main),32000);
  assert.equal(gangpotPaid(f.main,period(f),OTHER).total,0);assert.equal(gangpotPaid(f.main,period(f),ACTOR).total,25000);
  assert.equal(f.main.store.wallet(OTHER).balance,wallet);assert.equal(warns(f,OTHER).length,0);
  assert.equal(f.main.store.db.prepare('SELECT COUNT(*) AS n FROM gangpot_entries').get().n,4);
  assert.equal(gangpotSummary(f.main,f.guild,SAT).claims.find(item=>item.id===first.id).status,'revoked');
  await assert.rejects(reviewGangpotPayment(f.main,f.guild,f.lead,first.id,'approve',()=>SAT+5000),/verwijderd/);
  await syncGangpot(f.main,f.client,SAT+5000);
  const closed=f.main.store.db.prepare('SELECT * FROM gangpot_claims WHERE id=?').get(first.id),message=f.guild.channels.cache.get(f.main.config.gangpot.paymentsChannelId).posted.get(closed.message_id);
  assert.equal(message.components.length,0);assert.equal(message.embeds[0].title,'Legion — Betaling verwijderd');
  assert.ok(!f.guild.channels.cache.get(f.main.config.gangpot.totalChannelId).posted.first().embeds[0].fields[0].value.includes(`<@${OTHER}>`));
  const again=claim(f,OTHER,25000,'new-after-removal');await reviewGangpotPayment(f.main,f.guild,f.lead,again.id,'approve',()=>SAT+6000);
  assert.equal(removeGangpotPayment(f.main,removal(f),SAT+7000).id,result.id); // Herhaald verzoek raakt de nieuwe betaling niet.
  assert.equal(gangpotBalance(f.main),57000);
});

test('een open betaalmelding verwijderen geeft geen saldo-afboeking en blokkeert goedkeuren via een oude knop',async t=>{
  const f=fixture(t);await syncGangpot(f.main,f.client,SAT);const first=claim(f);
  const result=removeGangpotPayment(f.main,removal(f),SAT+1000);assert.equal(result.amount,0);assert.equal(result.claim_count,1);
  assert.equal(gangpotBalance(f.main),0);await assert.rejects(reviewGangpotPayment(f.main,f.guild,f.lead,first.id,'approve',()=>SAT+2000),/verwijderd/);
  const second=claim(f,OTHER,25000,'new-pending-request');assert.equal(second.status,'pending');assert.notEqual(second.id,first.id);
});

test('een verwijderde betaling na de deadline leidt één keer tot de bestaande gangwarnregel',async t=>{
  const f=fixture(t);await syncGangpot(f.main,f.client,SAT);const first=claim(f);
  await reviewGangpotPayment(f.main,f.guild,f.lead,first.id,'approve',()=>DEADLINE);
  await syncGangpot(f.main,f.client,END);assert.equal(warns(f,OTHER).length,0);
  removeGangpotPayment(f.main,removal(f),END+1000);const id=warns(f,OTHER)[0].id;
  await syncGangpot(f.main,f.client,END+2000);await syncGangpot(f.main,f.client,END+61000);
  assert.equal(warns(f,OTHER).length,1);assert.equal(warns(f,OTHER)[0].id,id);
});

test('een verwijdering die het saldo negatief zou maken verandert geen betaling, melding of historie',async t=>{
  const f=fixture(t);await syncGangpot(f.main,f.client,SAT);const first=claim(f);
  await reviewGangpotPayment(f.main,f.guild,f.lead,first.id,'approve',()=>SAT+1000);
  recordGangpotEntry(f.main,{kind:'expense',amount:20000,actor:ACTOR,requestId:'already-spent-request'},SAT+2000);
  assert.throws(()=>removeGangpotPayment(f.main,removal(f),SAT+3000),/saldo niet negatief/);
  assert.equal(gangpotBalance(f.main),5000);assert.equal(gangpotPaid(f.main,period(f),OTHER).total,25000);
  assert.equal(f.main.store.db.prepare('SELECT withdrawn_at FROM gangpot_claims WHERE id=?').get(first.id).withdrawn_at,null);
  assert.equal(f.main.store.db.prepare('SELECT COUNT(*) AS n FROM gangpot_removals').get().n,0);
});

test('refresh en verwijderen vereisen leiding; het command selecteert de gebruiker en werkt de bestaande berichten direct bij',async t=>{
  const f=fixture(t);t.mock.method(Date,'now',()=>SAT);await syncGangpot(f.main,f.client,SAT);const first=claim(f);
  await reviewGangpotPayment(f.main,f.guild,f.lead,first.id,'approve',()=>SAT);
  const command=(sub,user=ACTOR)=>{const member=f.guild.members.cache.get(user);return{id:`command-${sub}-request`,createdTimestamp:SAT,guild:f.guild,client:f.client,user:member.user,member,memberPermissions:member.permissions,options:{getSubcommand:()=>sub,getString:()=>null,getUser:name=>name==='gebruiker'?f.guild.members.cache.get(OTHER).user:null},deferReply:async()=>{},editReply:async value=>value};};
  await assert.rejects(handleGangpotCommand(f.main,command('betaling-verwijderen',OTHER)),/leiding/);
  await assert.rejects(handleGangpotCommand(f.main,command('refresh',OTHER)),/leiding/);
  const total=f.guild.channels.cache.get(f.main.config.gangpot.totalChannelId),info=f.guild.channels.cache.get(f.main.config.gangpot.infoChannelId),ids=[total.posted.first().id,info.posted.first().id];
  total.posted.first().embeds[0].description='Verouderd';
  const refreshed=await handleGangpotCommand(f.main,command('refresh'));assert.ok(refreshed.content.includes('bijgewerkt'));
  assert.ok(total.posted.first().embeds[0].description.includes('$25.000'));
  const deleted=await handleGangpotCommand(f.main,command('betaling-verwijderen'));assert.ok(deleted.content.includes('verwijderd'));
  assert.equal(gangpotBalance(f.main),0);assert.deepEqual([total.posted.first().id,info.posted.first().id],ids);
  const schema=commands(10000,false).find(item=>item.name==='gangpot').options;
  assert.ok(schema.find(item=>item.name==='refresh'));assert.equal(schema.find(item=>item.name==='betaling-verwijderen').options[0].name,'gebruiker');
});

test('schema 9 migreert eerdere correcties naar ingetrokken betaalmeldingen en bewaart gegevens bij herstart',async t=>{
  const f=fixture(t),dir=mkdtempSync(join(tmpdir(),'legion-gangpot-')),path=join(dir,'guild.sqlite');
  t.after(()=>{assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep+'legion-gangpot-'));rmSync(dir,{recursive:true,force:true});});
  f.main.store.close();f.main.store=new Store(f.main.config,path);await syncGangpot(f.main,f.client,SAT);
  const first=claim(f);const result=await reviewGangpotPayment(f.main,f.guild,f.lead,first.id,'approve',()=>SAT+1000);
  // Simuleer de vorige release: de transactie was gecorrigeerd, de melding toonde nog een vinkje.
  f.main.store.db.prepare('UPDATE gangpot_entries SET voided_at=?,voided_by=?,void_reason=? WHERE id=?').run(SAT+2000,ACTOR,'Oude correctie',result.payment_id);
  f.main.store.db.exec('ALTER TABLE gangpot_claims DROP COLUMN withdrawn_at; ALTER TABLE gangpot_claims DROP COLUMN withdrawn_by; ALTER TABLE gangpot_claims DROP COLUMN withdraw_reason; DROP TABLE gangpot_removals; PRAGMA user_version=9;');
  f.main.store.close();f.main.store=new Store(f.main.config,path);
  const migrated=f.main.store.db.prepare('SELECT * FROM gangpot_claims WHERE id=?').get(first.id);
  assert.equal(migrated.withdrawn_at,SAT+2000);assert.equal(migrated.withdraw_reason,'Oude correctie');assert.equal(gangpotBalance(f.main),0);
  const newClaim=claim(f,OTHER,25000,'new-payment-after-migration');
  const removalResult=removeGangpotPayment(f.main,removal(f),SAT+3000);
  f.main.store.close();f.main.store=new Store(f.main.config,path);
  assert.equal(f.main.store.db.prepare('PRAGMA user_version').get().user_version,11);
  assert.equal(f.main.store.db.prepare('SELECT id FROM gangpot_removals').get().id,removalResult.id);
  assert.ok(f.main.store.db.prepare('SELECT withdrawn_at FROM gangpot_claims WHERE id=?').get(newClaim.id).withdrawn_at);
});
