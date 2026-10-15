import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {Collection} from 'discord.js';
import {dashboardFixture,ACTOR,OTHER} from './dashboard-fixture.mjs';
import {createDataBackup,backupSummary} from '../src/backups.mjs';
import {messageMatchesPayload,editIfChanged} from '../src/message-updates.mjs';
import {refreshMembers} from '../src/members.mjs';
import {runMaintenanceJobs} from '../src/maintenance.mjs';
import {queueFeatureNotice,deliverFeatureNotices} from '../src/notices.mjs';
import {publishAbsencePanel} from '../src/absence-panel.mjs';
import {publishRoster} from '../src/roster.mjs';
import {memberOverview,handleMemberOverview} from '../src/member-overview.mjs';
import {Store} from '../src/store.mjs';
const MAIN='1555685630640652338';
function temp(t){const path=mkdtempSync(join(tmpdir(),'legion private backup '));t.after(()=>rmSync(path,{recursive:true,force:true}));return path;}

test('een back-up neemt gecommitteerde SQLite-WAL-data mee, bewaart bestanden privé en migreert de bron niet',t=>{
  const path=temp(t),source=join(path,`legion-${MAIN}.sqlite`),db=new DatabaseSync(source);db.exec('PRAGMA journal_mode=WAL; PRAGMA user_version=13; CREATE TABLE wallets(user_id TEXT,balance INTEGER); INSERT INTO wallets VALUES(\'lid\',750);');
  mkdirSync(join(path,'transcripts'));writeFileSync(join(path,'transcripts','case.txt'),'Gesprek');writeFileSync(join(path,'.env'),'GEHEIM');
  const result=createDataBackup(path,'1.8.0',{automatic:true,now:1000});const backup=new DatabaseSync(join(path,'backups',result.id,`legion-${MAIN}.sqlite`),{readOnly:true});
  try{assert.equal(backup.prepare('SELECT balance FROM wallets').get().balance,750);assert.equal(backup.prepare('PRAGMA user_version').get().user_version,13);assert.equal(db.prepare('PRAGMA user_version').get().user_version,13);}finally{backup.close();db.close();}
  const manifest=JSON.parse(readFileSync(join(path,'backups',result.id,'manifest.json'),'utf8'));assert.ok(!manifest.files.some(file=>file==='.env'||file.endsWith('-wal')||file.endsWith('-shm')));assert.equal(readFileSync(join(path,'backups',result.id,'transcripts','case.txt'),'utf8'),'Gesprek');
  assert.equal(createDataBackup(path,'1.8.0',{automatic:true,now:2000}).reason,'current');assert.equal(backupSummary(path).length,1);
});

test('retentie verwijdert alleen eigen complete back-ups en een mislukte nieuwe kopie tast de vorige niet aan',t=>{
  const path=temp(t),db=new DatabaseSync(join(path,`legion-${MAIN}.sqlite`));db.exec('CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);');db.prepare('INSERT INTO settings VALUES(?,?)').run('dashboard-config',JSON.stringify({operations:{backups:{keep:2}}}));db.close();
  mkdirSync(join(path,'backups','bewaren'),{recursive:true});writeFileSync(join(path,'backups','bewaren','notitie.txt'),'Niet verwijderen');
  for(let i=1;i<=3;i++)createDataBackup(path,`1.8.${i}`,{automatic:true,now:1000*i});assert.equal(backupSummary(path).length,2);assert.equal(readFileSync(join(path,'backups','bewaren','notitie.txt'),'utf8'),'Niet verwijderen');
  const state=readFileSync(join(path,'backups','state.json'),'utf8');writeFileSync(join(path,'broken.sqlite'),'Geen database');assert.throws(()=>createDataBackup(path,'1.9.0',{automatic:true,now:4000}));assert.equal(readFileSync(join(path,'backups','state.json'),'utf8'),state);assert.equal(backupSummary(path).length,2);assert.ok(!readdirSync(join(path,'backups')).some(name=>name.startsWith('.partial-')));
});

test('handmatig bewaren werkt ook wanneer automatische back-ups zijn uitgeschakeld',t=>{
  const path=temp(t),db=new DatabaseSync(join(path,`legion-${MAIN}.sqlite`));db.exec('CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);');db.prepare('INSERT INTO settings VALUES(?,?)').run('dashboard-config',JSON.stringify({operations:{backups:{enabled:false}}}));db.close();assert.equal(createDataBackup(path,'1.8.0',{automatic:true}).reason,'disabled');assert.equal(createDataBackup(path,'1.8.0').saved,true);
});

test('Discordmetadata en een nieuwe rendertijd veroorzaken geen edit, maar gewijzigde tekst en knoppen wel',async()=>{
  let edits=0;const message={content:'',embeds:[{type:'rich',title:'Titel',timestamp:'2026-01-01',fields:[{name:'A',value:'B',inline:false}]}],components:[{type:1,id:1,components:[{type:2,id:2,style:1,label:'Keuze',custom_id:'choice',disabled:false}]}],edit:async()=>{edits++;return message;}};
  const payload={embeds:[{title:'Titel',timestamp:'2026-02-01',fields:[{name:'A',value:'B'}]}],components:[{type:1,components:[{type:2,style:1,label:'Keuze',custom_id:'choice'}]}]};
  assert.equal(messageMatchesPayload(message,payload),true);await editIfChanged(message,payload);assert.equal(edits,0);
  await editIfChanged(message,{...payload,content:'Nieuw'});await editIfChanged(message,{...payload,components:[]});assert.equal(edits,2);
});

test('ongewijzigde afmeldpanelen en ledenlijsten veroorzaken geen herhaalde Discord-edits',async t=>{
  const f=dashboardFixture();t.after(f.close);const ctx=f.contexts.get(MAIN),guild=f.guilds.get(MAIN);await publishAbsencePanel(ctx,guild);await publishRoster(ctx,guild);const before=f.calls.filter(item=>item.method==='message.edit').length;
  await publishAbsencePanel(ctx,guild);await publishRoster(ctx,guild);assert.equal(f.calls.filter(item=>item.method==='message.edit').length,before);
  guild.roles.cache.get(ctx.config.roster.roleIds[0]).name='Nieuwe rangnaam';await publishRoster(ctx,guild);assert.equal(f.calls.filter(item=>item.method==='message.edit').length,before+1);
});

test('een mislukte tweede ledenpagina laat de bestaande cache intact en gedeelde aanvragen halen maar één keer op',async()=>{
  const original={id:'1',name:'Origineel'},cache=new Collection([['1',original]]);let count=0;
  const guild={id:'member-atomic-test',members:{cache,list:async options=>{assert.equal(options.cache,false);count++;if(count===2)throw new Error('Offline');return new Collection(Array.from({length:1000},(_,i)=>[String(i+1),{id:String(i+1),name:'Nieuw'}]));}}};
  await assert.rejects(refreshMembers(guild),/Offline/);assert.equal(cache.size,1);assert.equal(cache.get('1'),original);
  count=0;guild.members.list=async()=>{count++;await new Promise(resolve=>setTimeout(resolve,5));return new Collection([['2',{id:'2'}]]);};await Promise.all([refreshMembers(guild),refreshMembers(guild)]);assert.equal(count,1);assert.equal(cache.has('1'),false);assert.equal(cache.has('2'),true);
});

test('een fout in één onderhoudstaak houdt andere taken niet tegen en verdwijnt na herstel uit de botstatus',async t=>{
  const f=dashboardFixture();t.after(f.close);const ctx=f.contexts.get(MAIN),calls=[];
  await runMaintenanceJobs(ctx,[['defect',async()=>{throw Object.assign(new Error('Privé fouttekst'),{code:503});}],['volgende',async()=>{calls.push('uitgevoerd');}]],{report:()=>{}});assert.deepEqual(calls,['uitgevoerd']);assert.ok(ctx.store.setting('maintenance:error:defect').includes('503'));assert.ok(!ctx.store.setting('maintenance:error:defect').includes('Privé'));
  await runMaintenanceJobs(ctx,[['defect',async()=>{}]],{report:()=>{}});assert.equal(ctx.store.setting('maintenance:error:defect'),undefined);
});

test('gelijktijdige verzendrondes versturen een wachtrijbericht één keer en een fout bij één ontvanger blokkeert andere niet',async t=>{
  const f=dashboardFixture();t.after(f.close);const ctx=f.contexts.get(MAIN),guild=f.guilds.get(MAIN);
  queueFeatureNotice(ctx,{key:'one',kind:'test',user:OTHER,payload:{content:'Test'}});await Promise.all([deliverFeatureNotices(ctx,guild),deliverFeatureNotices(ctx,guild)]);assert.equal(f.calls.filter(item=>item.method==='dm'&&item.user===OTHER).length,1);
  queueFeatureNotice(ctx,{key:'bad',kind:'test',user:OTHER,payload:{content:'Bad'},now:1});queueFeatureNotice(ctx,{key:'good',kind:'test',user:ACTOR,payload:{content:'Good'},now:2});await deliverFeatureNotices(ctx,guild,Date.now(),item=>{if(item.notice_key==='bad')throw new Error('Fail');return true;});assert.equal(ctx.store.db.prepare("SELECT status FROM feature_notices WHERE notice_key='good'").get().status,'sent');assert.equal(ctx.store.db.prepare("SELECT status FROM feature_notices WHERE notice_key='bad'").get().status,'pending');
});

test('ledenoverzicht bundelt eigen guildhistorie en blijft privé voor de leiding',async t=>{
  const f=dashboardFixture();t.after(f.close);const ctx=f.contexts.get(MAIN),guild=f.guilds.get(MAIN);ctx.store.addWarn(OTHER,ACTOR,'Voorbeeld');const profile=memberOverview(ctx,guild,OTHER);assert.equal(profile.activeWarnings,1);assert.equal(memberOverview(f.source,f.guilds.get(f.source.config.guildId),OTHER).activeWarnings,0);
  let reply;await handleMemberOverview(ctx,{guild,member:guild.members.cache.get(ACTOR),memberPermissions:guild.members.cache.get(ACTOR).permissions,options:{getUser:()=>({id:OTHER})},reply:async payload=>{reply=payload;}});assert.equal(reply.flags,64);assert.ok(reply.embeds[0].data.fields.every(item=>item.value.length<=1024));
  await assert.rejects(handleMemberOverview(ctx,{guild,member:guild.members.cache.get(OTHER),memberPermissions:guild.members.cache.get(OTHER).permissions}),/leiding/);
});
