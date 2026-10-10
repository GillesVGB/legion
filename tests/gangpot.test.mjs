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
import {gangpotWindow,syncGangpot,reportGangpotPayment,reviewGangpotPayment,gangpotBalance,gangpotPaid,gangpotMembers,recordGangpotEntry,voidGangpotEntry,handleGangpotCommand,handleGangpotReview} from '../src/gangpot.mjs';

const SAT=Date.parse('2026-10-10T10:00:00Z'),SUNDAY=Date.parse('2026-10-11T21:59:30Z'),END=Date.parse('2026-10-11T22:00:00Z');
const fixture=t=>{const f=dashboardFixture();t.after(f.close);const main=f.contexts.values().next().value,guild=f.guilds.get(main.config.guildId);return{...f,main,guild,lead:guild.members.cache.get(ACTOR)};};
const period=f=>f.main.store.db.prepare("SELECT * FROM gangpot_periods WHERE id='2026-10-11'").get();
const claim=(f,user=OTHER,amount=25000,key=`claim-request-${user}`)=>reportGangpotPayment(f.main,{userId:user,amount,periodId:period(f).id,requestId:key,note:'In-game overgemaakt'},SAT);
const warns=(f,user)=>f.main.store.db.prepare("SELECT * FROM warnings WHERE user_id=? AND reason LIKE 'Gangpot t/m %'").all(user);

test('gangpottermijnen eindigen zondag 23:59 Belgische tijd, inclusief eerste weekend en wintertijd',()=>{
  const config={startsOn:'2026-10-10',weeklyAmount:25000};
  assert.equal(gangpotWindow(config,SAT).starts_at,Date.parse('2026-10-09T22:00:00Z'));
  assert.equal(gangpotWindow(config,SUNDAY).id,'2026-10-11');
  assert.equal(gangpotWindow(config,SUNDAY).ends_at,END);
  assert.equal(gangpotWindow(config,END).id,'2026-10-18');
  const dst=gangpotWindow(config,Date.parse('2026-10-25T12:00:00Z'));
  assert.equal(dst.ends_at,Date.parse('2026-10-25T23:00:00Z'));
  assert.equal(dst.ends_at-dst.starts_at,169*3600000);
  assert.equal(gangpotWindow(config,Date.parse('2026-10-09T12:00:00Z')),null);
});

test('alle menselijke hoofdserverleden staan in de gangpot; vaste berichten worden aangepast en community wordt geweigerd',async t=>{
  const f=fixture(t);await syncGangpot(f.main,f.client,SAT);
  const humans=[...f.guild.members.cache.values()].filter(member=>!member.user.bot);
  assert.equal(gangpotMembers(f.main,period(f),SAT).length,humans.length);
  assert.ok(gangpotMembers(f.main,period(f),SAT).some(item=>item.user_id===ACTOR));
  const payment=f.guild.channels.cache.get('1558238040932225034'),total=f.guild.channels.cache.get('1555685634515927050');
  const ids=[payment.posted.first().id,total.posted.first().id];
  f.main.store.db.prepare("DELETE FROM settings WHERE key LIKE 'gangpot:%'").run();
  await syncGangpot(f.main,f.client,SAT+60000);
  assert.equal(payment.posted.size,1);assert.equal(total.posted.size,1);
  assert.deepEqual([payment.posted.first().id,total.posted.first().id],ids);
  assert.ok(payment.posted.first().embeds[0].description.includes('Ook een melding die nog op controle wacht geeft geen uitstel'));
  assert.throws(()=>reportGangpotPayment(f.source,{userId:OTHER,amount:25000,requestId:'community-test',periodId:'2026-10-11'},SAT),/hoofdserver/);
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
  await assert.rejects(reviewGangpotPayment(f.main,f.guild,admin,item.id,'approve',()=>SUNDAY),/Lead-rol/);
  await assert.rejects(reviewGangpotPayment(f.main,f.guild,f.guild.members.cache.get(OTHER),item.id,'approve',()=>SUNDAY),/Lead-rol/);
  await Promise.all([reviewGangpotPayment(f.main,f.guild,f.lead,item.id,'approve',()=>SUNDAY),reviewGangpotPayment(f.main,f.guild,f.lead,item.id,'reject',()=>SUNDAY)]);
  assert.equal(gangpotBalance(f.main),25000);assert.equal(f.main.store.db.prepare('SELECT COUNT(*) AS n FROM gangpot_entries').get().n,1);
  assert.equal(gangpotPaid(f.main,period(f),OTHER).on_time,25000);
  await syncGangpot(f.main,f.client,END);assert.equal(warns(f,OTHER).length,0);
});

test('geen commando, pending zonder vinkje, afkeuring en gedeeltelijke goedkeuring geven elk één automatische warn',async t=>{
  const f=fixture(t);await syncGangpot(f.main,f.client,SAT);
  const pending=claim(f),rejected=claim(f,ACTOR),partialUser='100000000000000020',partial=claim(f,partialUser,10000);
  await reviewGangpotPayment(f.main,f.guild,f.lead,rejected.id,'reject',()=>SUNDAY);
  await reviewGangpotPayment(f.main,f.guild,f.lead,partial.id,'approve',()=>SUNDAY);
  await syncGangpot(f.main,f.client,SUNDAY);assert.equal(warns(f,OTHER).length,0);
  await syncGangpot(f.main,f.client,END);await syncGangpot(f.main,f.client,END+60000);
  for(const user of [OTHER,ACTOR,partialUser,'100000000000000021'])assert.equal(warns(f,user).length,1);
  assert.equal(f.main.store.db.prepare('SELECT status FROM gangpot_claims WHERE id=?').get(pending.id).status,'pending');
  const warnId=warns(f,OTHER)[0].id;
  assert.equal(f.calls.filter(call=>call.method==='dm'&&call.user===OTHER&&call.payload.embeds[0].data.description.includes(warnId)).length,1);
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
  const approved=await reviewGangpotPayment(f.main,f.guild,f.lead,item.id,'approve',()=>SUNDAY);
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
  const second=claim(f,OTHER,25000,'claim-second-request');await reviewGangpotPayment(f.main,f.guild,f.lead,second.id,'approve',()=>SUNDAY);
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
