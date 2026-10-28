import test from 'node:test';
import assert from 'node:assert/strict';
import { AuditLogEvent } from 'discord.js';
import { handleSecurityAudit,handleSecurityJoin,handleSecurityMessage,resetSecurityState } from '../src/security.mjs';
import { loadConfig } from '../src/config.mjs';

function fixture({trusted=false,overrides={}}={}){
  const incidents=[],audits=[],bans=[],timeouts=[];
  const member={id:'member-1',user:{bot:false,send:async()=>{}},roles:{cache:{has:id=>trusted&&id==='trusted-role'}},timeout:async(ms,reason)=>timeouts.push({ms,reason})};
  const ctx={securityReady:true,config:{clientId:'bot',guildId:'guild',security:{enabled:true,trustedRoleId:'trusted-role'},content:{gangName:'Bakarov'},operations:{security:overrides}},store:{audit:(...args)=>audits.push(args),db:{prepare(sql){return{run(...args){if(sql.startsWith('DELETE')){for(let i=incidents.length-1;i>=0;i--)if(incidents[i].created_at<args[0])incidents.splice(i,1);}else if(sql.startsWith('INSERT'))incidents.push({user_id:args[0],kind:args[1],created_at:args[2]});},get(...args){return{count:incidents.filter(item=>item.user_id===args[0]&&item.kind===args[1]&&item.created_at>=args[2]).length};}};}}}};
  const guild={id:'guild',members:{me:{id:'bot'},fetch:async()=>member,ban:async(id,options)=>bans.push({id,options})}};
  member.guild=guild;
  const message=(content,{users=0,roles=0,everyone=false}={})=>({id:`m${Math.random()}`,guild,guildId:guild.id,channelId:'channel',author:{id:member.id,bot:false},member,content,mentions:{users:{size:users},roles:{size:roles},everyone},embeds:[],delete:async function(){this.deleted=true;}});
  return{ctx,guild,member,bans,timeouts,audits,message};
}

const COMMUNITY='1555726440933363753',MEDIA_CHANNEL='1555726441944064011';
function mediaFixture({guildId=COMMUNITY,channelId=MEDIA_CHANNEL}={}){
  const config=loadConfig({},false),f=fixture(),message=f.message;
  f.ctx.config={...config,...config.guilds.find(guild=>guild.guildId===guildId),operations:{security:{}}};f.guild.id=guildId;
  f.message=(...args)=>Object.assign(message(...args),{channelId});
  return f;
}

test('trusted role bypasses message automod; ordinary users have a link removed and repeated links ban them',async()=>{
  resetSecurityState();const f=fixture({trusted:true});const trustedMessage=f.message('https://example.com');
  await handleSecurityMessage(f.ctx,trustedMessage,1000);assert.equal(trustedMessage.deleted,undefined);assert.equal(f.bans.length,0);
  resetSecurityState();const g=fixture(),first=g.message('https://example.com');await handleSecurityMessage(g.ctx,first,1000);
  assert.equal(first.deleted,true);assert.equal(g.bans.length,0);
  const second=g.message('https://example.org');await handleSecurityMessage(g.ctx,second,2000);
  assert.equal(second.deleted,true);assert.equal(g.bans.length,1);assert.equal(g.bans[0].id,g.member.id);
});

test('a dotted member name is not treated as a website by the media exception',async()=>{
  resetSecurityState();const f=fixture(),message=f.message('Mijn naam is gilles.vangroenderbe');
  await handleSecurityMessage(f.ctx,message,1000);
  assert.equal(message.deleted,undefined);assert.equal(f.bans.length,0);
});

test('YouTube and Medal links and real subdomains are allowed only in the configured community media channel',async()=>{
  for(const url of ['https://www.youtube.com/watch?v=video123','https://m.youtube.com/watch?v=video123','https://youtu.be/video123','https://www.medal.tv/games/example/clips/video123','https://clips.medal.tv/video123','www.youtube.com/watch?v=video123','www.medal.tv/clips/video123','youtube.com/watch?v=video123','youtu.be/video123','medal.tv/games/example/clips/video123']){
    resetSecurityState();const f=mediaFixture(),message=f.message(url);assert.equal(f.ctx.config.mediaChannelId,MEDIA_CHANNEL);
    await handleSecurityMessage(f.ctx,message,1000);assert.equal(message.deleted,undefined,url);assert.equal(f.bans.length,0,url);
  }
  for(const options of [{channelId:'1555726441759375398'},{guildId:'1555685630640652338'}]){
    resetSecurityState();const f=mediaFixture(options);f.ctx.config.mediaChannelId=MEDIA_CHANNEL;
    const message=f.message('https://youtu.be/video123');await handleSecurityMessage(f.ctx,message,1000);assert.equal(message.deleted,true);
  }
});

test('media exceptions reject spoofed hosts, credentials, custom ports, non-web schemes and YouTube redirect endpoints',async()=>{
  const urls=['https://youtube.com.evil.com/watch?v=video123','https://medal.tv.evil.com/video123','https://youtube.com@evil.com/video123','https://name:password@youtube.com/watch?v=video123','https://youtube.com:8443/watch?v=video123','ftp://youtube.com/video123','https://www.youtube.com/redirect?q=https%3A%2F%2Fevil.com'];
  for(const url of urls){resetSecurityState();const f=mediaFixture(),message=f.message(url);await handleSecurityMessage(f.ctx,message,1000);assert.equal(message.deleted,true,url);}
});

test('mixed media messages retain link penalties only for prohibited links and allowed media never counts toward the link ban threshold',async()=>{
  resetSecurityState();const f=mediaFixture();
  for(let i=0;i<3;i++){const allowed=f.message(`https://youtu.be/video${i} https://medal.tv/clips/video${i}`);await handleSecurityMessage(f.ctx,allowed,1000+i*20000);assert.equal(allowed.deleted,undefined);}
  const mixed=f.message('https://youtu.be/allowed https://example.org/prohibited');await handleSecurityMessage(f.ctx,mixed,61000);
  assert.equal(mixed.deleted,true);assert.equal(f.bans.length,0);
  const prohibited=f.message('https://example.net/second');await handleSecurityMessage(f.ctx,prohibited,81000);assert.equal(prohibited.deleted,true);assert.equal(f.bans.length,1);
});

test('media embeds follow the same allowlist and an unrelated embed cannot hide behind an allowed video link',async()=>{
  resetSecurityState();const f=mediaFixture(),allowed=f.message('Bekijk deze video');allowed.embeds=[{url:'https://www.youtube.com/watch?v=video123'}];
  await handleSecurityMessage(f.ctx,allowed,1000);assert.equal(allowed.deleted,undefined);
  const withPreview=f.message('https://medal.tv/clips/video123');withPreview.embeds=[{url:'https://medal.tv/clips/video123'}];
  await handleSecurityMessage(f.ctx,withPreview,21000);assert.equal(withPreview.deleted,undefined);
  const mixed=f.message('https://youtu.be/video123');mixed.embeds=[{url:'https://example.com/prohibited'}];
  await handleSecurityMessage(f.ctx,mixed,41000);assert.equal(mixed.deleted,true);assert.equal(f.bans.length,0);
  const hidden=f.message('Bekijk deze andere video');hidden.embeds=[{url:'https://example.org/prohibited'}];
  await handleSecurityMessage(f.ctx,hidden,61000);assert.equal(hidden.deleted,true);assert.equal(f.bans.length,1);
});

test('allowed media links still receive ordinary mention, profanity and repeated-message enforcement',async()=>{
  resetSecurityState();const f=mediaFixture(),mentions=f.message('https://youtu.be/video123',{users:4});
  await handleSecurityMessage(f.ctx,mentions,1000);assert.equal(mentions.deleted,true);assert.equal(f.bans.length,1);
  resetSecurityState();const g=mediaFixture(),curse=g.message('Dit is kut https://youtu.be/video123');await handleSecurityMessage(g.ctx,curse,1000);
  assert.equal(curse.deleted,true);assert.equal(g.timeouts.length,1);
  resetSecurityState();const h=mediaFixture();let repeated;
  for(let i=0;i<3;i++){repeated=h.message('https://youtu.be/video123');await handleSecurityMessage(h.ctx,repeated,1000+i*1000);}
  assert.equal(repeated.deleted,true);assert.equal(h.timeouts.length,1);assert.equal(h.bans.length,0);
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

test('community guild permits and logs invite creation while main guild and other protected actions retain bans',async()=>{
  resetSecurityState();const config=loadConfig({},false);
  const forGuild=(guildId,overrides={})=>{const f=fixture({overrides});f.ctx.config={...config,...config.guilds.find(guild=>guild.guildId===guildId),operations:{security:overrides}};f.guild.id=guildId;return f;};
  const entry=(f,action)=>({action,executorId:f.member.id,targetId:'private-invite-code',id:`audit-${action}`,executor:{bot:false}});
  const community=forGuild('1555726440933363753');
  await handleSecurityAudit(community.ctx,entry(community,AuditLogEvent.InviteCreate),community.guild);
  assert.equal(community.bans.length,0);
  const allowed=community.audits.find(row=>row[0]==='security.invite_created');assert.ok(allowed);assert.equal(allowed[2].status,'Toegestaan');
  assert.ok(!JSON.stringify(community.audits).includes('private-invite-code'));
  for(const action of [AuditLogEvent.InviteDelete,AuditLogEvent.ChannelDelete])await handleSecurityAudit(community.ctx,entry(community,action),community.guild);
  assert.equal(community.bans.length,2);
  const main=forGuild('1555685630640652338');await handleSecurityAudit(main.ctx,entry(main,AuditLogEvent.InviteCreate),main.guild);
  assert.equal(main.bans.length,1);assert.equal(main.audits.some(row=>row[0]==='security.invite_created'),false);
  const restricted=forGuild('1555726440933363753',{allowInviteCreation:false});await handleSecurityAudit(restricted.ctx,entry(restricted,AuditLogEvent.InviteCreate),restricted.guild);
  assert.equal(restricted.bans.length,1);assert.equal(restricted.audits.some(row=>row[0]==='security.invite_created'),false);
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
