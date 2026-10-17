import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PermissionsBitField,MessageFlags} from 'discord.js';
import {dashboardFixture,ACTOR} from './dashboard-fixture.mjs';
import {weekId,weekWindow,weeklyReport,weeklyReportMessage,syncWeeklyReports,handleWeeklyReport} from '../src/weekly-reports.mjs';
import {Store} from '../src/store.mjs';
import {loadDashboardSettings,saveDashboardSettings,validateDashboardSettings} from '../src/dashboard-settings.mjs';
import {botHealth} from '../src/bot-status.mjs';
import {commands} from '../src/commands.mjs';
import {Dashboard} from '../src/dashboard.mjs';
import {Locks} from '../src/locks.mjs';
import {createTranscriptServer} from '../src/viewer-server.mjs';
const NOW=Date.parse('2026-10-17T10:00:00Z'),DUE=Date.parse('2026-10-18T07:00:00Z');
function fixture(t){const f=dashboardFixture();t.after(f.close);const ctx=f.contexts.values().next().value,guild=f.guilds.get(ctx.config.guildId);return{...f,ctx,guild};}
test('zondag–zaterdagweken volgen Belgische kalenderdagen, zomer-/wintertijd en jaarwisseling',()=>{
  assert.equal(weekId(NOW),'2026-10-11');assert.equal(weekWindow('17-10-2026').week,'2026-10-11');
  const week=weekWindow('2026-10-11');assert.equal(new Date(week.start).toISOString(),'2026-10-10T22:00:00.000Z');assert.equal(new Date(week.end).toISOString(),'2026-10-17T22:00:00.000Z');assert.equal(week.endDate,'2026-10-17');
  const winter=weekWindow('25-10-2026'),summer=weekWindow('29-03-2026');assert.equal((winter.end-winter.start)/3600000,169);assert.equal((summer.end-summer.start)/3600000,167);
  assert.equal(weekWindow('01-01-2027').week,'2026-12-27');assert.throws(()=>weekWindow('31-02-2026'));
});
test('weekcijfers gebruiken dezelfde statistieken met exacte weekgrenzen inclusief de hele zaterdag',t=>{
  const f=fixture(t),{start,end}=weekWindow('2026-10-11');
  for(const [id,at]of [['before',start-1],['first',start],['saturday',end-1],['after',end]]){
    f.ctx.store.db.prepare('INSERT INTO activities(id,title,description,location,starts_at,ends_at,creator_id,channel_id) VALUES(?,?,?,?,?,?,?,?)').run(id,id,'','HQ',at,at+1000,ACTOR,f.ctx.config.planningChannelId);
    f.ctx.store.db.prepare('INSERT INTO gangpot_entries(id,request_id,kind,user_id,amount,actor_id,paid_at,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id,id,'payment',ACTOR,25000,ACTOR,at,NOW);
  }
  const report=weeklyReport(f.ctx,'17-10-2026',DUE);assert.equal(report.activities.total,2);assert.equal(report.gangpot.payments,50000);assert.equal(report.week,'2026-10-11');assert.equal(report.partial,false);
  assert.match(weeklyReportMessage(f.ctx,report).embeds[0].toJSON().title,/11-10-2026 t\/m 17-10-2026/);
  assert.equal(weeklyReport(f.ctx,'17-10-2026',NOW).partial,true);assert.throws(()=>weeklyReport(f.ctx,'01-11-2026',NOW),/huidige week/);
});
test('zondag om 09:00 verschijnt één overzicht, zonder maandbericht of duplicaat na herstart; volgende week houdt rekening met wintertijd',async t=>{
  const f=fixture(t),channel=f.guild.channels.cache.get(f.ctx.config.logChannelId),dir=mkdtempSync(join(tmpdir(),'bakarov-weekly-')),filename=join(dir,'legacy.sqlite');
  f.ctx.store.close();f.ctx.store=new Store(f.ctx.config,filename);t.after(()=>rmSync(dir,{recursive:true,force:true}));
  await syncWeeklyReports(f.ctx,f.guild,NOW);await syncWeeklyReports(f.ctx,f.guild,DUE-1);assert.equal(channel.posted.size,0);
  await Promise.all([syncWeeklyReports(f.ctx,f.guild,DUE),syncWeeklyReports(f.ctx,f.guild,DUE)]);assert.equal(channel.posted.size,1);assert.equal(f.ctx.store.db.prepare('SELECT week FROM weekly_reports').get().week,'2026-10-11');
  f.ctx.store.close();f.ctx.store=new Store(f.ctx.config,filename);await syncWeeklyReports(f.ctx,f.guild,DUE+86400000);assert.equal(channel.posted.size,1);
  const next=Date.parse('2026-10-25T08:00:00Z');await syncWeeklyReports(f.ctx,f.guild,next-1);assert.equal(channel.posted.size,1);await syncWeeklyReports(f.ctx,f.guild,next);assert.equal(channel.posted.size,2);
  assert.equal(f.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM monthly_reports').get().n,0);
});
test('opgeslagen maandinstellingen worden meegenomen, blijven aanpasbaar en oude rapporten blijven bewaard',async t=>{
  const f=fixture(t);f.ctx.store.setSetting('dashboard-config',JSON.stringify({operations:{monthlyReports:{enabled:false,sendTime:'10:30'}},channels:{monthlyReportChannelId:f.ctx.config.logChannelId}}));
  f.ctx.store.db.prepare('INSERT INTO monthly_reports(month,payload,created_at,last_error) VALUES(?,?,?,?)').run('2026-09','{}',NOW,'OLD_ERROR');loadDashboardSettings(f.ctx);
  assert.deepEqual(f.ctx.config.operations.weeklyReports,{enabled:false,sendTime:'10:30'});assert.equal(f.ctx.config.weeklyReportChannelId,f.ctx.config.logChannelId);
  await syncWeeklyReports(f.ctx,f.guild,NOW);await syncWeeklyReports(f.ctx,f.guild,DUE+60000);assert.equal(f.guild.channels.cache.get(f.ctx.config.logChannelId).posted.size,0);
  saveDashboardSettings(f.ctx,{operations:{weeklyReports:{enabled:true}}},ACTOR);await syncWeeklyReports(f.ctx,f.guild,DUE+60000);assert.equal(f.guild.channels.cache.get(f.ctx.config.logChannelId).posted.size,0);
  await syncWeeklyReports(f.ctx,f.guild,DUE+90*60000);assert.equal(f.guild.channels.cache.get(f.ctx.config.logChannelId).posted.size,1);
  loadDashboardSettings(f.ctx);assert.equal(f.ctx.config.operations.weeklyReports.enabled,true);assert.equal(f.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM monthly_reports').get().n,1);
  assert.equal(botHealth(f.ctx,f.client).errors.some(item=>item.module==='monthly_reports'),false);assert.throws(()=>validateDashboardSettings({operations:{weeklyReports:{sendTime:'25:00'}}}));
});
test('verstuurd weekbericht wordt na een verloren bevestiging teruggevonden en opnieuw proberen behoudt de momentopname',async t=>{
  const f=fixture(t),channel=f.guild.channels.cache.get(f.ctx.config.logChannelId),send=channel.send;await syncWeeklyReports(f.ctx,f.guild,NOW);
  channel.send=async payload=>{await send(payload);throw new Error('ACK_LOST');};await syncWeeklyReports(f.ctx,f.guild,DUE);assert.equal(channel.posted.size,1);const payload=f.ctx.store.db.prepare('SELECT payload FROM weekly_reports').get().payload;
  channel.send=send;await syncWeeklyReports(f.ctx,f.guild,DUE+60001);assert.equal(channel.posted.size,1);assert.ok(f.ctx.store.db.prepare('SELECT message_id FROM weekly_reports').get().message_id);assert.equal(f.ctx.store.db.prepare('SELECT payload FROM weekly_reports').get().payload,payload);
});
test('wekelijkse verzending blijft privé en gemiste weken worden begrensd ingehaald',async t=>{
  const f=fixture(t),channel=f.guild.channels.cache.get(f.ctx.config.logChannelId),permissions=channel.permissionsFor;f.ctx.store.setSetting('weekly:starts','2026-09-27');channel.permissionsFor=()=>new PermissionsBitField(8n);
  await syncWeeklyReports(f.ctx,f.guild,DUE);assert.equal(channel.posted.size,0);assert.equal(f.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM weekly_reports').get().n,2);
  channel.permissionsFor=permissions;await syncWeeklyReports(f.ctx,f.guild,DUE+60001);assert.equal(channel.posted.size,2);await syncWeeklyReports(f.ctx,f.guild,DUE+120002);assert.equal(channel.posted.size,3);
});
test('weekcommando reageert privé, dashboard vraagt actuele leidingrechten en de community krijgt geen weekcijfers',async t=>{
  const f=fixture(t);assert.ok(commands(500,false).some(item=>item.name==='weekoverzicht'));assert.ok(!commands(500,true).some(item=>item.name==='weekoverzicht'));let flags;
  const lead=f.guild.members.cache.get(ACTOR);await handleWeeklyReport(f.ctx,{member:lead,memberPermissions:lead.permissions,options:{getString:()=>null},deferReply:async value=>{flags=value.flags;},editReply:async()=>{}});assert.equal(flags,MessageFlags.Ephemeral);
  const dashboard=new Dashboard({client:f.client,contexts:f.contexts,locks:new Locks()}),server=await createTranscriptServer(f.contexts,0,dashboard);t.after(()=>new Promise(resolve=>server.close(resolve)));
  const origin=`http://127.0.0.1:${server.address().port}`,path=`/api/dashboard/guilds/${f.ctx.config.guildId}/weekly?date=17-10-2026`;
  assert.equal((await fetch(origin+path)).status,401);
  const code=new URL(dashboard.issueLogin(ACTOR,f.ctx.config.guildId)).hash.slice(7),login=await fetch(origin+'/api/dashboard/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://dashboard.test'},body:JSON.stringify({code})});
  const headers={Cookie:login.headers.get('set-cookie').split(';')[0]},response=await fetch(origin+path,{headers});assert.equal(response.status,200);assert.equal((await response.json()).week,'2026-10-11');
  assert.equal((await fetch(origin+`/api/dashboard/guilds/${f.source.config.guildId}/weekly?date=17-10-2026`,{headers})).status,400);
  lead.permissions=new PermissionsBitField(0n);lead.roles.cache.clear();assert.equal((await fetch(origin+path,{headers})).status,403);
});
