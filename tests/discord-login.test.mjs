import test from 'node:test';
import assert from 'node:assert/strict';
import {PermissionFlagsBits as P,PermissionsBitField} from 'discord.js';
import {Dashboard} from '../src/dashboard.mjs';
import {DiscordLogin} from '../src/discord-login.mjs';
import {Locks} from '../src/locks.mjs';
import {createTranscriptServer} from '../src/viewer-server.mjs';
import {dashboardFixture,ACTOR,OTHER} from './dashboard-fixture.mjs';

const CLIENT='1556774794358169652',SECRET='fixture-only-client-secret',TOKEN='fixture-only-access-token';
async function fixture(t,{enabled=true,userId=ACTOR,fail=false}={}){
  const f=dashboardFixture(),requests=[];t.after(()=>f.close());
  for(const ctx of f.contexts.values())Object.assign(ctx.config,{clientId:CLIENT,discordClientSecret:enabled?SECRET:''});
  const oauthFetch=async(url,options)=>{
    requests.push({url,options});
    if(fail)throw new Error(`Private upstream error ${SECRET} ${TOKEN}`);
    return new Response(JSON.stringify(url.endsWith('/token')?{access_token:TOKEN,refresh_token:'fixture-only-refresh',token_type:'Bearer',scope:'identify'}:{id:userId,username:'Fixture Lead'}),{status:200});
  };
  const dashboard=new Dashboard({client:f.client,contexts:f.contexts,locks:new Locks(),oauthFetch});t.after(()=>dashboard.close());
  const server=await createTranscriptServer(f.contexts,0,dashboard);t.after(()=>new Promise(resolve=>server.close(resolve)));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const request=(path,{cookie,body,csrf,method}={})=>fetch(origin+path,{redirect:'manual',method:method||(body?'POST':'GET'),headers:{...(cookie?{Cookie:cookie}:{}),...(body?{Origin:'https://dashboard.test','Content-Type':'application/json','X-CSRF-Token':csrf||''}:{} )},...(body?{body:JSON.stringify(body)}:{})});
  const start=async()=>{
    const response=await request('/api/dashboard/oauth/start'),url=new URL(response.headers.get('location'));
    return{response,url,state:url.searchParams.get('state'),cookie:response.headers.get('set-cookie')?.split(';')[0]};
  };
  const callback=(login,extra='')=>request(`/api/dashboard/oauth/callback?state=${login.state}&code=fixture-code&iss=https%3A%2F%2Fdiscord.com${extra}`,{cookie:login.cookie});
  return{...f,dashboard,requests,request,start,callback};
}

test('publieke Discord-loginconfig bevat alleen de vaste login-URL en geen privégegevens',async t=>{
  const f=await fixture(t),response=await f.request('/api/dashboard/auth'),body=await response.text();
  assert.deepEqual(JSON.parse(body),{discordLoginEnabled:true,loginURL:'https://dashboard.test/api/dashboard/oauth/start'});
  for(const value of [SECRET,TOKEN,ACTOR,'NEVER-RETURN-THIS-TOKEN'])assert.ok(!body.includes(value));
  assert.match(response.headers.get('cache-control'),/no-store/);
  assert.equal((await f.request('/api/dashboard/oauth/start',{method:'POST',body:{}})).status,405);
});

test('ontbrekende OAuth-secret blokkeert de bot en bestaande Lead-inloglinks niet',async t=>{
  const f=await fixture(t,{enabled:false});
  assert.deepEqual(await(await f.request('/api/dashboard/auth')).json(),{discordLoginEnabled:false,loginURL:null});
  assert.equal((await f.request('/api/dashboard/oauth/start')).headers.get('location'),'/dashboard#oauth=unavailable');
  const code=new URL(f.dashboard.issueLogin(ACTOR,f.source.config.guildId)).hash.slice(7);
  assert.equal((await f.request('/api/dashboard/login',{body:{code}})).status,200);
});

test('Discord authorization code login bindt de browser, gebruikt identify en maakt een beveiligde sessie',async t=>{
  const f=await fixture(t),login=await f.start();
  assert.equal(login.response.status,302);assert.equal(login.url.origin,'https://discord.com');
  assert.equal(login.url.pathname,'/oauth2/authorize');assert.equal(login.url.searchParams.get('scope'),'identify');
  assert.equal(login.url.searchParams.get('client_id'),CLIENT);assert.equal(login.url.searchParams.get('response_type'),'code');
  assert.equal(login.url.searchParams.get('redirect_uri'),'https://dashboard.test/api/dashboard/oauth/callback');
  assert.match(login.state,/^[A-Za-z0-9_-]{43}$/);assert.ok(!login.url.href.includes(SECRET));
  assert.match(login.response.headers.get('set-cookie'),/__Host-legion-oauth=.*HttpOnly; SameSite=Lax; Max-Age=600; Secure/);
  const response=await f.callback(login);assert.equal(response.status,303);assert.equal(response.headers.get('location'),'/dashboard');
  const cookies=response.headers.getSetCookie();assert.equal(cookies.length,2);
  assert.match(cookies[0],/__Host-legion-session=.*HttpOnly; SameSite=Strict; Max-Age=1800; Secure/);
  assert.match(cookies[1],/Max-Age=0/);
  const cookie=cookies[0].split(';')[0],session=await(await f.request('/api/dashboard/session',{cookie})).json();
  assert.equal(session.user.id,ACTOR);assert.equal(session.guilds.length,2);assert.match(session.csrf,/^[A-Za-z0-9_-]{43}$/);
  assert.equal(f.requests[0].url,'https://discord.com/api/oauth2/token');
  const tokenOptions=f.requests[0].options;assert.equal(tokenOptions.method,'POST');assert.equal(tokenOptions.headers['Content-Type'],'application/x-www-form-urlencoded');
  assert.equal(tokenOptions.body.get('client_secret'),SECRET);assert.equal(tokenOptions.body.get('grant_type'),'authorization_code');
  assert.equal(tokenOptions.body.get('redirect_uri'),login.url.searchParams.get('redirect_uri'));
  assert.equal(f.requests[1].url,'https://discord.com/api/v10/users/@me');assert.equal(f.requests[1].options.headers.Authorization,`Bearer ${TOKEN}`);
  const stored=JSON.stringify([...f.dashboard.sessions.values()]);assert.ok(!stored.includes(TOKEN));assert.ok(!stored.includes(SECRET));
  assert.equal(f.dashboard.discordLogin.pending.size,0);
  const path=`/api/dashboard/guilds/${session.guilds[0].id}/actions`;
  assert.equal((await f.request(path,{cookie,body:{action:'settings.save',settings:{dailyCoins:333}}})).status,403);
  assert.equal((await f.request(path,{cookie,csrf:session.csrf,body:{action:'settings.save',settings:{dailyCoins:333}}})).status,200);
  assert.equal((await f.request('/api/dashboard/logout',{cookie,csrf:session.csrf,body:{}})).status,200);
  assert.equal((await f.request('/api/dashboard/session',{cookie})).status,401);
});

test('OAuth zonder de bijbehorende browsercookie of met andere state weigert login-CSRF',async t=>{
  const f=await fixture(t),login=await f.start(),other=await f.start();
  for(const cookie of [undefined,other.cookie]){
    const response=await f.request(`/api/dashboard/oauth/callback?state=${login.state}&code=fixture-code`,{cookie});
    assert.equal(response.headers.get('location'),'/dashboard#oauth=state');
  }
  assert.equal((await f.request('/api/dashboard/oauth/callback?state=wrong&code=fixture-code',{cookie:login.cookie})).headers.get('location'),'/dashboard#oauth=state');
  assert.equal(f.requests.length,0);assert.equal(f.dashboard.sessions.size,0);
  assert.equal((await f.callback(login)).headers.get('location'),'/dashboard');
});

test('verlopen, hergebruikte of dubbelzinnige OAuth-callbacks en een ongeldige issuer worden geweigerd',async t=>{
  const f=await fixture(t);
  const expired=await f.start();for(const item of f.dashboard.discordLogin.pending.values())item.expires=Date.now()-1;
  assert.equal((await f.callback(expired)).headers.get('location'),'/dashboard#oauth=state');
  for(const suffix of ['&state=second','&code=second','&iss=https%3A%2F%2Fevil.example']){
    const login=await f.start();assert.equal((await f.callback(login,suffix)).headers.get('location'),'/dashboard#oauth=state');
  }
  assert.equal(f.requests.length,0);
  const login=await f.start();await f.callback(login);const calls=f.requests.length;
  assert.equal((await f.callback(login)).headers.get('location'),'/dashboard#oauth=state');assert.equal(f.requests.length,calls);
});

test('geannuleerde en mislukte Discord-logins lekken geen codes, tokens of upstreamfouten',async t=>{
  const f=await fixture(t,{fail:true}),cancelled=await f.start();
  const denied=await f.request(`/api/dashboard/oauth/callback?state=${cancelled.state}&error=access_denied&error_description=${TOKEN}`,{cookie:cancelled.cookie});
  assert.equal(denied.headers.get('location'),'/dashboard#oauth=cancelled');assert.equal(f.requests.length,0);
  const login=await f.start(),response=await f.callback(login);
  assert.equal(response.headers.get('location'),'/dashboard#oauth=unavailable');assert.equal(f.dashboard.sessions.size,0);
  const output=JSON.stringify([...response.headers])+await response.text();
  for(const value of [SECRET,TOKEN,'fixture-code','Private upstream'])assert.ok(!output.includes(value));
});

test('Administrator zonder Lead krijgt via OAuth en oude links geen toegang',async t=>{
  const f=await fixture(t,{userId:OTHER});
  for(const guild of f.guilds.values()){const member=guild.members.cache.get(OTHER);member.roles.cache.clear();member.permissions=new PermissionsBitField(P.Administrator);}
  const login=await f.start();assert.equal((await f.callback(login)).headers.get('location'),'/dashboard#oauth=denied');
  const code=new URL(f.dashboard.issueLogin(OTHER,f.source.config.guildId)).hash.slice(7);
  assert.equal((await f.request('/api/dashboard/login',{body:{code}})).status,403);assert.equal(f.dashboard.sessions.size,0);
});

test('Lead zonder Administrator kan inloggen; alleen guilds met die rol zijn zichtbaar en intrekken werkt direct',async t=>{
  const f=await fixture(t);for(const guild of f.guilds.values())guild.members.cache.get(ACTOR).permissions=new PermissionsBitField(0n);
  const main=f.contexts.values().next().value;f.guilds.get(f.source.config.guildId).members.cache.get(ACTOR).roles.cache.clear();
  const login=await f.start(),response=await f.callback(login),cookie=response.headers.getSetCookie()[0].split(';')[0];
  assert.equal(response.headers.get('location'),'/dashboard');
  const info=await(await f.request('/api/dashboard/session',{cookie})).json();assert.equal(info.guilds.length,1);assert.equal(info.guilds[0].id,main.config.guildId);assert.equal(info.guilds[0].admin,false);
  assert.equal((await f.request(`/api/dashboard/guilds/${f.source.config.guildId}/summary`,{cookie})).status,403);
  const member=f.guilds.get(main.config.guildId).members.cache.get(ACTOR);member.roles.cache.clear();member.permissions=new PermissionsBitField(P.Administrator);
  assert.equal((await f.request('/api/dashboard/session',{cookie})).status,403);
  assert.equal((await f.request(`/api/dashboard/guilds/${main.config.guildId}/actions`,{cookie,csrf:info.csrf,body:{action:'settings.save',settings:{dailyCoins:999}}})).status,403);
});

test('OAuth-state heeft een begrensde wachtrij, vervalt en wordt op afsluiten gewist',()=>{
  const login=new DiscordLogin({config:()=>({clientId:CLIENT,discordClientSecret:SECRET}),origin:()=> 'https://dashboard.test'}),request={headers:{}};
  for(let index=0;index<1000;index++)login.start(request);
  assert.throws(()=>login.start(request),error=>error.reason==='unavailable');
  for(const item of login.pending.values())item.expires=0;
  login.start(request);assert.equal(login.pending.size,1);login.close();assert.equal(login.pending.size,0);
});
