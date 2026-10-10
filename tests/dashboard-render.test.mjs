import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {dashboardFixture} from './dashboard-fixture.mjs';
import {Dashboard} from '../src/dashboard.mjs';
import {Locks} from '../src/locks.mjs';
import {syncGangpot,reportGangpotPayment} from '../src/gangpot.mjs';

test('nieuwe dashboardpagina’s tonen de gangmodules, weigeren de community-planning en escapen ingevoerde tekst',()=>{
  const f=dashboardFixture();
  try{
    const main=f.contexts.values().next().value,guild=f.guilds.get(main.config.guildId),dashboard=new Dashboard({...f,locks:new Locks()});
    const data=dashboard.summary(main,guild);
    data.plannings=[{id:'0123456789ab',title:'<script>alert(1)</script>',location:'HQ <img onerror="x">',starts_at:Date.now(),status:'open',url:null,participants:[{name:'Naam <test>',response:'yes'}]}];
    data.promotions=[{id:'0123456789ab',member_name:'Naam <test>',role_name:'Membre',reason:'<script>test</script>',status:'pending',url:null}];
    const source=readFileSync(new URL('../src/dashboard-assets/app.js',import.meta.url),'utf8');
    const context=vm.createContext({data,Intl,Date,Number,String,Math,URL,console});
    vm.runInContext(source.slice(0,source.indexOf("document.addEventListener('click'"))+`\nstate.data=data;`,context);
    const planning=vm.runInContext('planningPage()',context),promotions=vm.runInContext('promotionsPage()',context),games=vm.runInContext('gamesPage()',context);
    assert.ok(planning.includes('emoji-reacties')&&planning.includes('🟢 1'));
    assert.ok(!planning.includes('<script>')&&!planning.includes('<img onerror='));
    assert.ok(planning.includes('&lt;script&gt;')&&promotions.includes('&lt;script&gt;'));
    assert.ok(promotions.includes('Goedkeuren')&&games.includes('Dagelijkse fun-missies'));
    vm.runInContext('state.data.planningChannelId="";',context);
    assert.ok(vm.runInContext('planningPage()',context).includes('Alleen in de gangserver'));
  }finally{f.close();}
});

test('gangpotdashboard toont betaalmeldingen met Lead-vinkjes, escapt tekst en houdt de community gescheiden',async()=>{
  const f=dashboardFixture();
  try{
    const main=f.contexts.values().next().value,guild=f.guilds.get(main.config.guildId),now=Date.parse('2026-10-10T10:00:00Z');
    await syncGangpot(main,f.client,now);
    reportGangpotPayment(main,{userId:'100000000000000099',periodId:'2026-10-11',amount:25000,requestId:'render-claim-request',note:'<script>bad()</script>'},now);
    const data=new Dashboard({...f,locks:new Locks()}).summary(main,guild,guild.members.cache.get('100000000000000001'));
    const source=readFileSync(new URL('../src/dashboard-assets/app.js',import.meta.url),'utf8');
    const context=vm.createContext({data,Intl,Date,Number,String,Math,URL,console});
    vm.runInContext(source.slice(0,source.indexOf("document.addEventListener('click'"))+`\nstate.data=data;`,context);
    const page=vm.runInContext('gangpotPage()',context);
    assert.ok(page.includes('✅ Goedkeuren')&&page.includes('❌ Afkeuren'));
    assert.ok(page.includes('&lt;script&gt;')&&!page.includes('<script>'));
    assert.ok(page.includes('23:59')&&page.includes('wachten op controle geeft geen uitstel'));
    vm.runInContext('state.data.gangpot=null;',context);
    assert.ok(vm.runInContext('gangpotPage()',context).includes('Alleen in de gangserver'));
  }finally{f.close();}
});
