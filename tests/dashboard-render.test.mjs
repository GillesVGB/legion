import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {dashboardFixture} from './dashboard-fixture.mjs';
import {Dashboard} from '../src/dashboard.mjs';
import {Locks} from '../src/locks.mjs';
import {syncGangpot,reportGangpotPayment} from '../src/gangpot.mjs';

test('weekoverzicht en modules tonen de wekelijkse verzending; maandcijfers beloven geen automatische maandverzending meer',()=>{
  const f=dashboardFixture();try{
    const main=f.contexts.values().next().value,guild=f.guilds.get(main.config.guildId),data=new Dashboard({...f,locks:new Locks()}).summary(main,guild);
    const source=readFileSync(new URL('../src/dashboard-assets/app.js',import.meta.url),'utf8'),context=vm.createContext({data,Intl,Date,Number,String,Math,URL,console});
    vm.runInContext(source.slice(0,source.indexOf("document.addEventListener('click'"))+`\nstate.data=data;`,context);
    const week=vm.runInContext('weeklyPage()',context),month=vm.runInContext('monthlyPage()',context),modules=vm.runInContext('modulesPage()',context);
    assert.match(week,/Elke zondag om 09:00/);assert.match(week,/zondag tot en met zaterdag/);assert.match(month,/op aanvraag/);assert.doesNotMatch(month,/eerste dag van de volgende maand/);
    assert.match(modules,/weeklyReports.sendTime/);assert.doesNotMatch(modules,/name="monthlyReports.sendTime"/);
  }finally{f.close();}
});

test('bezwaaroverzicht toont beslisknoppen en escapt uitleg, redenen en namen van leden',()=>{
  const f=dashboardFixture();try{
    const main=f.contexts.values().next().value,guild=f.guilds.get(main.config.guildId),data=new Dashboard({...f,locks:new Locks()}).summary(main,guild);
    data.warnAppeals=[{id:'0123456789ab',warn_id:'abcdef012345',userName:'Naam <img src=x onerror=alert(1)>',warnReason:'<script>reden</script>',reason:'<script>uitleg</script>',status:'pending'}];
    const source=readFileSync(new URL('../src/dashboard-assets/app.js',import.meta.url),'utf8'),context=vm.createContext({data,Intl,Date,Number,String,Math,URL,console});
    vm.runInContext(source.slice(0,source.indexOf("document.addEventListener('click'"))+`\nstate.data=data;`,context);
    const html=vm.runInContext('appealsPage()',context);assert.match(html,/Goedkeuren/);assert.match(html,/Afwijzen/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>|<img src=x/);
    vm.runInContext('state.data.warnAppeals=null;',context);assert.match(vm.runInContext('appealsPage()',context),/hoofdserver/);
  }finally{f.close();}
});

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
    data.activityChecks=[{id:'0123456789ab',deadline_at:Date.now(),status:'open',url:null,members:[{name:'<script>Naam</script>',status:'pending'}]}];
    const planning=vm.runInContext('planningPage()',context),checks=vm.runInContext('activityChecksPage()',context),promotions=vm.runInContext('promotionsPage()',context),games=vm.runInContext('gamesPage()',context);
    assert.ok(planning.includes('emoji-reacties')&&planning.includes('🟢 1'));
    assert.ok(!planning.includes('<script>')&&!planning.includes('<img onerror='));
    assert.ok(planning.includes('&lt;script&gt;')&&promotions.includes('&lt;script&gt;'));
    assert.ok(checks.includes('Nieuwe check-in')&&checks.includes('Nog niet bevestigd')&&checks.includes('&lt;script&gt;')&&!checks.includes('<script>'));
    assert.ok(promotions.includes('Goedkeuren')&&games.includes('Dagelijkse fun-missies'));
    vm.runInContext('state.data.planningChannelId="";',context);
    assert.ok(vm.runInContext('planningPage()',context).includes('Alleen in de gangserver'));
  }finally{f.close();}
});

test('dashboard toont module-instellingen, botstatus, afmeldingen en visverzamelingen met veilige tekst',()=>{
  const f=dashboardFixture();try{
    const ctx=f.contexts.values().next().value,guild=f.guilds.get(ctx.config.guildId),data=new Dashboard({...f,locks:new Locks()}).summary(ctx,guild,guild.members.cache.get('100000000000000001'));
    data.absences=[{kind:'range',id:'0123456789ab',userName:'<script>lid</script>',reason:'<img onerror=x>',weeks:['2026-10-17'],start_date:'2026-10-10',end_date:'2026-10-17',status:'pending'}];
    data.fishCollections=[{userName:'<script>lid</script>',catch_id:'ring',amount:3}];
    const source=readFileSync(new URL('../src/dashboard-assets/app.js',import.meta.url),'utf8'),context=vm.createContext({data,Intl,Date,Number,String,Math,URL,console});vm.runInContext(source.slice(0,source.indexOf("document.addEventListener('click'"))+`\nstate.data=data;`,context);
    const modules=vm.runInContext('modulesPage()',context),absence=vm.runInContext('absencesPage()',context),health=vm.runInContext('healthPage()',context),collection=vm.runInContext('collectionPage()',context);
    for(const name of ['gangpot.weeklyAmount','gangpot.deadlineTime','gangpot.fridayTime','gangpot.leadTime','fishing.reward','planning.preparation'])assert.ok(modules.includes(name));
    assert.ok(absence.includes('Afwezigheidsmeldingen')&&absence.includes('Planningsafmeldingen'));
    assert.ok(absence.includes('Goedkeuren')&&absence.includes('&lt;img')&&!absence.includes('<img onerror'));
    assert.ok(health.includes('Wachtrijen')&&collection.includes('&lt;script&gt;'));
    const profile=vm.runInContext("memberOverviewHtml({user:{name:'<script>lid</script>'},activeWarnings:1,checks:[],absences:[],warnings:[{id:'123',created_at:1,reason:'<img onerror=x>'}]})",context);assert.ok(profile.includes('&lt;script&gt;')&&profile.includes('&lt;img')&&!profile.includes('<img onerror'));
    assert.ok(modules.includes('activityCheck.reminderMinutes')&&modules.includes('activityCheck.weeklyIntervalWeeks')&&modules.includes('Interval activiteitencheck (weken)')&&modules.includes('backups.keep'));
    const logs=vm.runInContext("activityRows([{event:'message.delete',actor_name:'Systeem',created_at:1,presentation:{title:'Bericht verwijderd',fields:[{name:'Auteur',value:'<script>naam</script>'}],sections:[{label:'Verwijderd bericht',text:'<img onerror=x>'}]}}])",context);assert.ok(logs.includes('Bericht verwijderd')&&logs.includes('&lt;img')&&!logs.includes('<img onerror'));
  }finally{f.close();}
});

test('beveiligingsdashboard toont in beide servers actieve raidcontrole en houdt uitgeschakelde beveiliging instelbaar',()=>{
  const f=dashboardFixture();try{
    const dashboard=new Dashboard({...f,locks:new Locks()}),source=readFileSync(new URL('../src/dashboard-assets/app.js',import.meta.url),'utf8');
    for(const ctx of f.contexts.values()){
      const guild=f.guilds.get(ctx.config.guildId);ctx.securityReady=true;
      const context=vm.createContext({data:dashboard.summary(ctx,guild),Intl,Date,Number,String,Math,URL,console});
      vm.runInContext(source.slice(0,source.indexOf("document.addEventListener('click'"))+`\nstate.data=data;`,context);
      const modules=vm.runInContext('modulesPage()',context),health=vm.runInContext('healthPage()',context);
      for(const setting of ['security.enabled','security.raidEnabled','security.raidModeMinutes'])assert.ok(modules.includes(`name="${setting}"`));
      assert.match(health,/Aan — controleert nieuwe leden/);assert.match(health,/Geen raid gedetecteerd/);
      ctx.securityRaidUntil=Date.now()+60000;context.data=dashboard.summary(ctx,guild);vm.runInContext('state.data=data;',context);
      assert.match(vm.runInContext('healthPage()',context),/Beschermmodus:<\/strong> 🟠 Actief tot/);
      ctx.config.operations={...ctx.config.operations,security:{...ctx.config.operations?.security,enabled:false}};
      context.data=dashboard.summary(ctx,guild);vm.runInContext('state.data=data;',context);
      const disabledHealth=vm.runInContext('healthPage()',context),disabledModules=vm.runInContext('modulesPage()',context);
      assert.match(disabledHealth,/<h2>Beveiligingssysteem<\/h2><p>Uit<\/p>/);assert.doesNotMatch(disabledHealth,/Aan — controleert nieuwe leden/);
      assert.match(disabledModules,/name="security.enabled"/);assert.match(disabledModules,/name="security.raidEnabled"/);
    }
  }finally{f.close();}
});

test('mediakanaal is alleen in de community instelbaar voor administrators en de beveiligingsuitleg noemt YouTube en Medal',()=>{
  const f=dashboardFixture();try{
    const dashboard=new Dashboard({...f,locks:new Locks()}),source=readFileSync(new URL('../src/dashboard-assets/app.js',import.meta.url),'utf8'),mediaChannelId='1555726441944064011';
    for(const ctx of f.contexts.values()){
      const guild=f.guilds.get(ctx.config.guildId);if(ctx.config.ticketsEnabled)guild.makeChannel(mediaChannelId,'media');
      const data=dashboard.summary(ctx,guild,guild.members.cache.get('100000000000000001'));
      const context=vm.createContext({data,Intl,Date,Number,String,Math,URL,console});
      vm.runInContext(source.slice(0,source.indexOf("document.addEventListener('click'"))+`\nstate.data=data;`,context);
      const modules=vm.runInContext('modulesPage()',context);
      if(ctx.config.ticketsEnabled){
        assert.equal(data.channelSettings.mediaChannelId,mediaChannelId);assert.match(modules,/Media: YouTube &amp; Medal/);assert.match(modules,/name="mediaChannelId"/);
        assert.ok(modules.includes(`option value="${mediaChannelId}" selected`));assert.match(modules,/YouTube- en Medal-links mogen alleen in het ingestelde mediakanaal/);
        context.data=dashboard.summary(ctx,guild,guild.members.cache.get('100000000000000099'));vm.runInContext('state.data=data;',context);
        assert.doesNotMatch(vm.runInContext('modulesPage()',context),/name="mediaChannelId"/);
      }else{
        assert.equal(data.channelSettings.mediaChannelId,undefined);assert.doesNotMatch(modules,/name="mediaChannelId"|Media: YouTube|YouTube- en Medal-links mogen alleen/);
        assert.match(modules,/YouTube- en Medal-links mogen in deze server in alle tekstkanalen/);
      }
    }
  }finally{f.close();}
});

test('gangpotdashboard toont betaalmeldingen met Lead-vinkjes, escapt tekst en houdt de community gescheiden',async()=>{
  const f=dashboardFixture();
  try{
    const main=f.contexts.values().next().value,guild=f.guilds.get(main.config.guildId),now=Date.parse('2026-10-10T10:00:00Z');
    guild.members.cache.get('100000000000000099').roles.cache.set(main.config.gangpot.memberRoleId,guild.roles.cache.get(main.config.gangpot.memberRoleId));
    await syncGangpot(main,f.client,now);
    reportGangpotPayment(main,{userId:'100000000000000099',periodId:'2026-10-17',amount:25000,requestId:'render-claim-request',note:'<script>bad()</script>'},now);
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
