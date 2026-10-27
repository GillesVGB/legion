import test from 'node:test';
import assert from 'node:assert/strict';
import { AuditLogEvent } from 'discord.js';
import { handleSecurityAudit,handleSecurityJoin,handleSecurityMessage,resetSecurityState } from '../src/security.mjs';

function fixture({trusted=false,overrides={}}={}){
  const incidents=[],audits=[],bans=[],timeouts=[];
  const member={id:'member-1',user:{bot:false,send:async()=>{}},roles:{cache:{has:id=>trusted&&id==='trusted-role'}},timeout:async(ms,reason)=>timeouts.push({ms,reason})};
  const ctx={securityReady:true,config:{clientId:'bot',guildId:'guild',security:{enabled:true,trustedRoleId:'trusted-role'},content:{gangName:'Bakarov'},operations:{security:overrides}},store:{audit:(...args)=>audits.push(args),db:{prepare(sql){return{run(...args){if(sql.startsWith('DELETE')){for(let i=incidents.length-1;i>=0;i--)if(incidents[i].created_at<args[0])incidents.splice(i,1);}else if(sql.startsWith('INSERT'))incidents.push({user_id:args[0],kind:args[1],created_at:args[2]});},get(...args){return{count:incidents.filter(item=>item.user_id===args[0]&&item.kind===args[1]&&item.created_at>=args[2]).length};}};}}}};
  const guild={id:'guild',members:{me:{id:'bot'},fetch:async()=>member,ban:async(id,options)=>bans.push({id,options})}};
  member.guild=guild;
  const message=(content,{users=0,roles=0,everyone=false}={})=>({id:`m${Math.random()}`,guild,guildId:guild.id,channelId:'channel',author:{id:member.id,bot:false},member,content,mentions:{users:{size:users},roles:{size:roles},everyone},embeds:[],delete:async function(){this.deleted=true;}});
  return{ctx,guild,member,bans,timeouts,audits,message};
}

test('trusted role bypasses message automod; ordinary users have a link removed and repeated links ban them',async()=>{
  resetSecurityState();const f=fixture({trusted:true});const trustedMessage=f.message('https://example.com');
  await handleSecurityMessage(f.ctx,trustedMessage,1000);assert.equal(trustedMessage.deleted,undefined);assert.equal(f.bans.length,0);
  resetSecurityState();const g=fixture(),first=g.message('https://example.com');await handleSecurityMessage(g.ctx,first,1000);
  assert.equal(first.deleted,true);assert.equal(g.bans.length,0);
  const second=g.message('https://example.org');await handleSecurityMessage(g.ctx,second,2000);
  assert.equal(second.deleted,true);assert.equal(g.bans.length,1);assert.equal(g.bans[0].id,g.member.id);
});

test('up to three tags pass; four tags and mass mentions are removed and banned',async()=>{
  resetSecurityState();const f=fixture();const allowed=f.message('hello',{users:3});await handleSecurityMessage(f.ctx,allowed,1000);
  assert.equal(allowed.deleted,undefined);assert.equal(f.bans.length,0);
  const excessive=f.message('tag spam',{users:4});await handleSecurityMessage(f.ctx,excessive,2000);
  assert.equal(excessive.deleted,true);assert.equal(f.bans.length,1);
  const mass=f.message('announcement',{everyone:true});await handleSecurityMessage(f.ctx,mass,3000);assert.equal(f.bans.length,2);
});

test('cursing and repeated spam time out users and increase repeat timeout duration',async()=>{
  resetSecurityState();const f=fixture(),curse1=f.message('Wat een kut situatie');await handleSecurityMessage(f.ctx,curse1,1000);
  const curse2=f.message('Dit is kut');await handleSecurityMessage(f.ctx,curse2,2000);
  assert.equal(curse1.deleted,true);assert.deepEqual(f.timeouts.slice(0,2).map(item=>item.ms),[600000,1800000]);
  resetSecurityState();const g=fixture();let current;
  for(let i=0;i<6;i++){current=g.message(`spam ${i}`);await handleSecurityMessage(g.ctx,current,1000+i*500);}
  assert.equal(current.deleted,true);assert.equal(g.timeouts.at(-1).ms,600000);assert.equal(g.bans.length,0);
});

test('unauthorized channel actions ban the executor, while the trusted role is exempt',async()=>{
  resetSecurityState();const f=fixture();let member=f.member;const entry={action:AuditLogEvent.ChannelDelete,executorId:member.id,targetId:'channel',id:'audit-1',executor:{bot:false}};
  await handleSecurityAudit(f.ctx,entry,f.guild);assert.equal(f.bans.length,1);assert.equal(f.audits.some(row=>row[0]==='security.unauthorized_action'),true);
  const g=fixture({trusted:true});await handleSecurityAudit(g.ctx,entry,g.guild);assert.equal(g.bans.length,0);
});

test('a join burst starts raid mode and temporarily times out further joins',async()=>{
  resetSecurityState();const f=fixture();for(let i=0;i<8;i++){f.member.id=`new-${i}`;await handleSecurityJoin(f.ctx,f.member,1000+i*500);}
  assert.equal(f.ctx.securityRaidUntil,1000+7*500+10*60*1000);assert.equal(f.timeouts.length,0);
  f.member.id='new-9';await handleSecurityJoin(f.ctx,f.member,6000);assert.equal(f.timeouts.at(-1).ms,600000);
  assert.equal(f.audits.some(row=>row[0]==='security.raid_detected'),true);
});

test('turning security off skips message penalties, server-action bans and raid checks until enabled again',async()=>{
  resetSecurityState();const f=fixture({overrides:{enabled:false}}),message=f.message('https://example.com https://example.org');
  await handleSecurityMessage(f.ctx,message,1000);
  await handleSecurityAudit(f.ctx,{action:AuditLogEvent.ChannelDelete,executorId:f.member.id,targetId:'channel',id:'audit-disabled'},f.guild);
  for(let i=0;i<8;i++){f.member.id=`disabled-${i}`;await handleSecurityJoin(f.ctx,f.member,1000+i*100);}
  assert.equal(message.deleted,undefined);assert.equal(f.bans.length,0);assert.equal(f.timeouts.length,0);assert.ok(!f.ctx.securityRaidUntil);
  f.ctx.config.operations.security.enabled=true;
  const enabledMessage=f.message('https://example.com https://example.org');await handleSecurityMessage(f.ctx,enabledMessage,3000);
  assert.equal(enabledMessage.deleted,true);assert.equal(f.bans.length,1);
});

test('raid checking can be switched off separately and clears an ongoing raid without disabling message moderation',async()=>{
  resetSecurityState();const f=fixture({overrides:{raidEnabled:false}});f.ctx.securityRaidUntil=600000;
  for(let i=0;i<8;i++){f.member.id=`disabled-raid-${i}`;await handleSecurityJoin(f.ctx,f.member,1000+i*100);}
  assert.ok(!(f.ctx.securityRaidUntil>2000));assert.equal(f.timeouts.length,0);assert.equal(f.audits.some(row=>row[0]==='security.raid_detected'),false);
  const message=f.message('https://example.com');await handleSecurityMessage(f.ctx,message,2000);assert.equal(message.deleted,true);
  f.ctx.config.operations.security.raidEnabled=true;
  f.member.id='first-after-enabling';await handleSecurityJoin(f.ctx,f.member,2100);
  assert.ok(!(f.ctx.securityRaidUntil>2100));assert.equal(f.timeouts.length,0);
});

test('configured raid threshold, protection duration and timeout apply and expire without further penalties',async()=>{
  resetSecurityState();const f=fixture({overrides:{raidJoinCount:5,raidWindowSeconds:5,raidModeMinutes:2,raidTimeoutMinutes:3}});
  for(let i=0;i<5;i++){f.member.id=`custom-raid-${i}`;await handleSecurityJoin(f.ctx,f.member,1000+i*500);}
  assert.equal(f.ctx.securityRaidUntil,3000+2*60000);
  f.member.id='during-raid';await handleSecurityJoin(f.ctx,f.member,4000);assert.equal(f.timeouts.at(-1).ms,3*60000);
  f.member.id='after-raid';await handleSecurityJoin(f.ctx,f.member,124000);assert.equal(f.timeouts.length,1);
});

test('security DM delivery and failures are audited without stopping message enforcement',async()=>{
  resetSecurityState();const f=fixture(),message=f.message('https://example.com');await handleSecurityMessage(f.ctx,message,1000);
  assert.equal(message.deleted,true);assert.equal(f.audits.some(row=>row[0]==='security.notice_sent'&&row[2].user===f.member.id),true);
  resetSecurityState();const g=fixture();g.member.user.send=async()=>{throw Object.assign(new Error('DM geblokkeerd'),{code:50007});};
  const blocked=g.message('https://example.org');await handleSecurityMessage(g.ctx,blocked,2000);
  assert.equal(blocked.deleted,true);const failure=g.audits.find(row=>row[0]==='security.notice_failed');
  assert.ok(failure);assert.equal(failure[2].user,g.member.id);assert.equal(failure[2].error,'50007');
});

test('higher configured spam thresholds work without timing out before the selected limit',async()=>{
  resetSecurityState();const f=fixture({overrides:{spamMessageCount:12,duplicateMessageCount:10}});
  for(let i=0;i<11;i++)await handleSecurityMessage(f.ctx,f.message(`different message ${i}`),1000+i*100);
  assert.equal(f.timeouts.length,0);
  await handleSecurityMessage(f.ctx,f.message('twelfth message'),2200);assert.equal(f.timeouts.length,1);
  resetSecurityState();const g=fixture({overrides:{spamMessageCount:20,duplicateMessageCount:10}});
  for(let i=0;i<9;i++)await handleSecurityMessage(g.ctx,g.message('duplicate'),1000+i*100);
  assert.equal(g.timeouts.length,0);
  await handleSecurityMessage(g.ctx,g.message('duplicate'),2000);assert.equal(g.timeouts.length,1);
});
