import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionsBitField } from 'discord.js';
import { Dashboard } from '../src/dashboard.mjs';
import { Locks } from '../src/locks.mjs';
import { createTranscriptServer } from '../src/viewer-server.mjs';
import { createPersonalInvite, deliverAcceptance, resendAcceptance, admissionJoined } from '../src/admissions.mjs';
import { caseMessages, panel } from '../src/ui.mjs';
import { recruitmentState } from '../src/recruitment.mjs';
import { validateDashboardSettings, saveDashboardSettings, loadDashboardSettings } from '../src/dashboard-settings.mjs';
import { refreshMembers } from '../src/members.mjs';
import { dashboardFixture, ACTOR, APPLICANT, OTHER } from './dashboard-fixture.mjs';

async function serverFixture(t){
  const f=dashboardFixture();t.after(()=>f.close());
  const dashboard=new Dashboard({client:f.client,contexts:f.contexts,locks:new Locks()});
  const server=await createTranscriptServer(f.contexts,0,dashboard);t.after(()=>new Promise(resolve=>server.close(resolve)));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const request=(path,body,cookie,csrf)=>fetch(origin+path,{method:body?'POST':'GET',headers:{...(body?{'Content-Type':'application/json',Origin:'https://dashboard.test'}:{}),...(cookie?{Cookie:cookie}:{}),...(csrf?{'X-CSRF-Token':csrf}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const login=async user=>{const code=new URL(dashboard.issueLogin(user,f.source.config.guildId)).hash.slice(7);const response=await request('/api/dashboard/login',{code});return{response,code,cookie:response.headers.get('set-cookie')?.split(';')[0],info:await response.json()};};
  return{...f,dashboard,origin,request,login};
}

test('dashboardlinks werken één keer, cookies zijn beveiligd en publieke bezoekers zien geen gangdata',async t=>{
  const f=await serverFixture(t);
  assert.equal((await f.request(`/api/dashboard/guilds/${f.source.config.guildId}/summary`)).status,401);
  const account=await f.login(ACTOR);assert.equal(account.response.status,200);
  assert.match(account.response.headers.get('set-cookie'),/HttpOnly/);assert.match(account.response.headers.get('set-cookie'),/SameSite=Strict/);assert.match(account.response.headers.get('set-cookie'),/Secure/);
  assert.equal((await f.request('/api/dashboard/login',{code:account.code})).status,401);
  const response=await f.request(`/api/dashboard/guilds/${f.source.config.guildId}/summary`,null,account.cookie);
  assert.equal(response.status,200);const text=await response.text();assert.ok(!text.includes('NEVER-RETURN-THIS-TOKEN'));
  const data=JSON.parse(text);assert.equal(data.overview.openApplications,1);assert.equal(data.transcripts[0].status,'accepted');assert.ok(data.transcripts[0].url.includes('#k='));
  assert.equal((await f.request(`/api/dashboard/guilds/999999999999999999/summary`,null,account.cookie)).status,404);
});

test('niet-leiding, verloren rechten en vervallen inloglinks krijgen geen dashboardtoegang',async t=>{
  const f=await serverFixture(t);assert.equal((await f.login(OTHER)).response.status,403);
  const expired=f.dashboard.issueLogin(ACTOR,f.source.config.guildId);for(const item of f.dashboard.logins.values())item.expires=Date.now()-1;
  assert.equal((await f.request('/api/dashboard/login',{code:new URL(expired).hash.slice(7)})).status,401);
  const account=await f.login(ACTOR),member=f.guilds.get(f.source.config.guildId).members.cache.get(ACTOR);
  member.permissions=new PermissionsBitField(0n);member.roles.cache.clear();
  assert.equal((await f.request(`/api/dashboard/guilds/${f.source.config.guildId}/summary`,null,account.cookie)).status,403);
});

test('dashboardmutaties controleren oorsprong, CSRF, guildgrenzen en geblokkeerde instellingen',async t=>{
  const f=await serverFixture(t),account=await f.login(ACTOR),path=`/api/dashboard/guilds/${f.source.config.guildId}/actions`;
  const before=f.source.config.dailyCoins;
  assert.equal((await f.request(path,{action:'settings.save',settings:{dailyCoins:300}},account.cookie)).status,403);
  const foreign=await fetch(f.origin+path,{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://evil.example',Cookie:account.cookie,'X-CSRF-Token':account.info.csrf},body:JSON.stringify({action:'settings.save',settings:{dailyCoins:300}})});
  assert.equal(foreign.status,403);assert.equal(f.source.config.dailyCoins,before);
  assert.equal((await f.request(path,{action:'settings.save',settings:{token:'leak',maxBet:700}},account.cookie,account.info.csrf)).status,400);
  assert.equal(f.calls.filter(call=>call.method==='put').length,0);
  assert.equal((await f.request(path,{action:'settings.save',settings:{dailyCoins:300}},account.cookie,account.info.csrf)).status,200);
  assert.equal(f.source.config.dailyCoins,300);
  assert.equal((await f.request(path,{action:'case.decision',id:f.open.id,decision:'accept'},account.cookie,account.info.csrf)).status,400);
  assert.equal(f.source.store.caseById(f.open.id).status,'open');
});

test('instellingen blijven bewaard, veranderen geen ticketscope en coins kunnen niet negatief worden',()=>{
  const f=dashboardFixture();try{
    assert.throws(()=>validateDashboardSettings({ticketsEnabled:true}),/mag niet/);
    assert.throws(()=>validateDashboardSettings({dailyCoins:-1}),/geheel getal/);
    saveDashboardSettings(f.source,{dailyCoins:350,content:{tagline:'Samen de familie vormen.'}},ACTOR);
    f.source.config.dailyCoins=1;loadDashboardSettings(f.source);assert.equal(f.source.config.dailyCoins,350);
    assert.equal(f.contexts.get(f.base.guilds[0].guildId).config.ticketsEnabled,false);
    const before=f.source.store.wallet(APPLICANT).balance;
    assert.throws(()=>f.source.store.adjustCoins(APPLICANT,-100000,ACTOR,'test'),/nieuwe saldo/);assert.equal(f.source.store.wallet(APPLICANT).balance,before);
  }finally{f.close();}
});

test('aannemen vanuit het dashboard slaat transcript en DM op voordat het echte dossierkanaal verdwijnt',async t=>{
  const f=await serverFixture(t),account=await f.login(ACTOR),path=`/api/dashboard/guilds/${f.source.config.guildId}/actions`;
  const response=await f.request(path,{action:'case.decision',id:f.open.id,decision:'accept',confirm:true},account.cookie,account.info.csrf);
  assert.equal(response.status,200);
  assert.equal(f.source.store.caseById(f.open.id).status,'accepted');
  assert.equal(f.source.store.transcript(f.open.id).state,'done');
  assert.equal(f.source.store.acceptance(f.open.id).status,'sent');
  assert.ok(f.calls.some(call=>call.method==='channel.delete'&&call.id==='100000000000000100'));
});

test('ticket- en sollicitatie-embeds volgen groen, oranje en rood van de ledenstand',()=>{
  const f=dashboardFixture();try{
    for(const [count,color] of [[17,0x22C55E],[20,0xF59E0B],[25,0xEF4444]]){
      const status=recruitmentState(count);
      assert.equal(panel(f.source.config,'alles',status).embeds[0].toJSON().color,color);
      assert.equal(caseMessages(f.source.config,f.source.store.caseById(f.open.id),status)[0].embeds[0].toJSON().color,color);
      assert.equal(caseMessages(f.source.config,f.source.store.caseById(f.ticket.id),status)[0].embeds[0].toJSON().color,color);
    }
    const accepted={...f.source.store.caseById(f.open.id),status:'accepted'};
    assert.equal(caseMessages(f.source.config,accepted,recruitmentState(25))[0].embeds[0].toJSON().color,0x22C55E);
  }finally{f.close();}
});

test('persoonlijke invites zijn aan exact één gebruiker gebonden en falen dicht bij een ontbrekende beperking',async()=>{
  const f=dashboardFixture();try{
    const options={channelId:f.source.config.admission.inviteChannelId,guildId:f.source.config.admission.targetGuildId,userId:APPLICANT};
    const invite=await createPersonalInvite(f.client.rest,options);assert.ok(invite.code);
    const sent=f.calls.find(call=>call.method==='post').options.body;assert.deepEqual(sent.target_user_ids,[APPLICANT]);assert.equal(sent.max_uses,1);assert.equal(sent.unique,true);
    const original=f.client.rest.get;f.client.rest.get=async()=>Buffer.from(`user_id\n${APPLICANT}\n${OTHER}\n`);
    await assert.rejects(createPersonalInvite(f.client.rest,options),/uitsluitend/);
    assert.ok(f.calls.some(call=>call.method==='delete'));f.client.rest.get=original;
  }finally{f.close();}
});

test('aannemen verzendt een groene DM met persoonlijke invite, zonder dubbele DM, en joinen trekt de code in',async()=>{
  const f=dashboardFixture();try{
    const owner=f.guilds.get(f.source.config.guildId).members.cache.get(APPLICANT);owner.roles.cache.set(f.source.config.memberRoleId,{});
    f.source.store.closeCase(f.open.id,'accepted',ACTOR);
    const [a,b]=await Promise.all([deliverAcceptance(f.source,f.client,f.open.id),deliverAcceptance(f.source,f.client,f.open.id)]);
    assert.equal(a.status,'sent');assert.equal(b.status,'sent');
    const dms=f.calls.filter(call=>call.method==='dm'&&call.user===APPLICANT);assert.equal(dms.length,1);assert.equal(dms[0].payload.embeds[0].toJSON().color,0x22C55E);
    assert.match(dms[0].payload.components[0].toJSON().components[0].url,/^https:\/\/discord\.gg\//);
    const destination=f.guilds.get(f.source.config.admission.targetGuildId);const joined=destination.addMember(APPLICANT,'Kai Mercier',[f.source.config.admission.targetRoleId]);
    await admissionJoined(joined,f.contexts);assert.equal(f.source.store.acceptance(f.open.id).status,'joined');assert.equal(f.source.store.acceptance(f.open.id).invite_code,null);
  }finally{f.close();}
});

test('DM-blokkades bewaren de persoonlijke invite; opnieuw sturen herstelt en verloren lidrechten trekken hem in',async()=>{
  const f=dashboardFixture();try{
    const owner=f.guilds.get(f.source.config.guildId).members.cache.get(APPLICANT);owner.roles.cache.set(f.source.config.memberRoleId,{});
    f.source.store.closeCase(f.open.id,'accepted',ACTOR);const send=owner.user.send;owner.user.send=async()=>{throw Object.assign(new Error('DM geblokkeerd'),{code:50007});};
    const blocked=await deliverAcceptance(f.source,f.client,f.open.id);assert.equal(blocked.status,'dm_blocked');assert.ok(blocked.invite_code);
    assert.equal(f.source.store.pendingAcceptances(Date.now()+120000).some(n=>n.case_id===f.open.id),false);
    owner.user.send=send;assert.equal((await resendAcceptance(f.source,f.client,f.open.id)).status,'sent');
    owner.roles.cache.delete(f.source.config.memberRoleId);f.source.store.requeueAcceptance(f.open.id);assert.equal((await deliverAcceptance(f.source,f.client,f.open.id)).status,'revoked');
  }finally{f.close();}
});

test('REST-ledensynchronisatie ruimt oude cacheleden op en gebruikt geen onbetrouwbare gatewayfetch',async()=>{
  const f=dashboardFixture();try{
    const guild=f.guilds.get(f.source.config.guildId);guild.members.cache.set('100000000000000199',{id:'100000000000000199'});
    const list=guild.members.list;guild.members.list=async()=>{const page=await list();page.delete('100000000000000199');return page;};
    await refreshMembers(guild);assert.equal(guild.members.cache.has('100000000000000199'),false);
  }finally{f.close();}
});
