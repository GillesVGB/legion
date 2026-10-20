import test from 'node:test';
import assert from 'node:assert/strict';
import {Collection,PermissionsBitField,PermissionFlagsBits as P} from 'discord.js';
import {dashboardFixture,OTHER} from './dashboard-fixture.mjs';
import {recoverPublishedActivityChecks} from '../src/checkin-recovery.mjs';
import {finishActivityCheck,handleActivityCheckReaction} from '../src/activity-check.mjs';
import {WEEKLY_CHECK_CHANNEL_ID} from '../src/feature-settings.mjs';

const NOW=Date.parse('2026-10-20T12:00:00Z'),DEADLINE=Date.parse('2026-10-23T05:30:00Z');
function fixture(t){
  t.mock.method(Date,'now',()=>NOW);
  const f=dashboardFixture();t.after(()=>f.close());
  const ctx=f.contexts.values().next().value,guild=f.guilds.get(ctx.config.guildId);
  const ids=['100000000000000020','100000000000000021'];
  const channel=guild.makeChannel(WEEKLY_CHECK_CHANNEL_ID,'mededelingen'),permissions=channel.permissionsFor;
  channel.permissionsFor=member=>member.roles?.cache?.has(ctx.config.memberRoleId)?new PermissionsBitField([P.ViewChannel,P.ReadMessageHistory]):permissions(member);
  const control=guild.channels.cache.get(ctx.config.logChannelId);
  const publish=async(overrides={})=>{
    const data={version:1,id:'aabbccddeeff',guildId:guild.id,channelId:channel.id,messageId:'',deadlineDate:'2026-10-23',deadlineAt:DEADLINE,createdAt:NOW,reason:'Wekelijkse activiteitencheck',members:ids,...overrides};
    const seconds=Math.floor(data.deadlineAt/1000);
    const message=await channel.send({content:`<@&${ctx.config.memberRoleId}>`,embeds:[{title:'Bakarov — Activiteitencheck',description:`Reageer met ✅.\n\n**Reden:** ${data.reason}\n**Deadline:** <t:${seconds}:F> · <t:${seconds}:R>\n**Status:** 🟢 Open`,footer:{text:`Bakarov • Check-in ${data.id}`}}]});
    await message.react('✅');data.messageId=message.id;
    const manifest=await control.send({content:'BAKAROV_CHECKIN_RECOVERY_V1\n'+JSON.stringify(data),embeds:[{title:'Bakarov — Activiteitencheck geplaatst',footer:{text:`Bakarov • Check-inherstel ${data.id}`}}]});
    return{data,message,manifest};
  };
  const count=table=>ctx.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  return{...f,ctx,guild,ids,channel,control,publish,count};
}

test('eigen privé herstelbericht koppelt de gepubliceerde weekcheck eenmaal aan de hostingregistratie',async t=>{
  const f=fixture(t),{data,message,manifest}=await f.publish();
  assert.equal(await recoverPublishedActivityChecks(f.ctx,f.guild,NOW),1);
  const check=f.ctx.store.db.prepare('SELECT * FROM activity_check_sessions').get();
  assert.equal(check.id,data.id);assert.equal(check.channel_id,f.channel.id);assert.equal(check.message_id,message.id);
  assert.equal(check.created_at,NOW);assert.equal(check.published_at,NOW);assert.equal(check.deadline_at,DEADLINE);assert.equal(check.status,'open');
  assert.deepEqual(f.ctx.store.db.prepare('SELECT user_id FROM activity_check_members ORDER BY user_id').all().map(row=>row.user_id),f.ids);
  assert.deepEqual({...f.ctx.store.db.prepare('SELECT * FROM activity_check_occurrences').get()},{deadline_date:'2026-10-23',check_id:data.id});
  assert.equal(await recoverPublishedActivityChecks(f.ctx,f.guild,NOW+1000),0);
  assert.equal(f.count('activity_check_sessions'),1);assert.equal(f.count('warnings'),1);
  assert.equal(f.ctx.store.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE event='activitycheck.recover-published'").get().n,1);
  assert.ok(f.control.posted.has(manifest.id));assert.equal(f.calls.filter(call=>call.method==='message.edit').length,0);
});

test('herstelde vinkjes en goedgekeurde afwezigheid voorkomen warns; latere leden komen niet in de snapshot',async t=>{
  const f=fixture(t),{data,message}=await f.publish();
  message.reactions.cache.get('✅').users.cache.set(f.ids[0],f.guild.members.cache.get(f.ids[0]).user);
  f.ctx.store.db.prepare("INSERT INTO absence_requests(id,user_id,kind,start_date,end_date,weeks,reason,status,created_at,channel_id) VALUES(?,?,'range',?,?,'[]',?,'approved',?,?)").run('away',f.ids[1],'2026-10-23','2026-10-23','Vakantie',NOW,f.ctx.config.logChannelId);
  f.guild.addMember(OTHER,'Nieuw',[f.ctx.config.memberRoleId]);
  message.reactions.cache.get('✅').users.cache.set(OTHER,f.guild.members.cache.get(OTHER).user);
  await recoverPublishedActivityChecks(f.ctx,f.guild,NOW);
  assert.deepEqual(f.ctx.store.db.prepare('SELECT user_id,status,responded_at FROM activity_check_members ORDER BY user_id').all().map(row=>({...row})),[{user_id:f.ids[0],status:'responded',responded_at:NOW},{user_id:f.ids[1],status:'pending',responded_at:null}]);
  await finishActivityCheck(f.ctx,f.guild,data.id,DEADLINE);
  assert.deepEqual(f.ctx.store.db.prepare('SELECT user_id,status FROM activity_check_members ORDER BY user_id').all().map(row=>({...row})),[{user_id:f.ids[0],status:'responded'},{user_id:f.ids[1],status:'exempt'}]);
  assert.equal(f.count('activity_check_warnings'),0);assert.equal(f.ctx.store.warnCount(OTHER),0);
});

test('herstel accepteert de nieuwe tweewekelijkse reden en telt bestaande ✅ meteen mee',async t=>{
  const f=fixture(t),{data,message}=await f.publish({reason:'Tweewekelijkse activiteitencheck'});
  message.reactions.cache.get('✅').users.cache.set(f.ids[1],f.guild.members.cache.get(f.ids[1]).user);
  assert.equal(await recoverPublishedActivityChecks(f.ctx,f.guild,NOW),1);
  assert.deepEqual(f.ctx.store.db.prepare('SELECT user_id,status,responded_at FROM activity_check_members ORDER BY user_id').all().map(row=>({...row})),[
    {user_id:f.ids[0],status:'pending',responded_at:null},{user_id:f.ids[1],status:'responded',responded_at:NOW}
  ]);
  assert.equal(f.ctx.store.db.prepare('SELECT reason FROM activity_check_sessions WHERE id=?').get(data.id).reason,'Tweewekelijkse activiteitencheck');
});

test('reactie op herstelde check 3ff6ac9b2f8d werkt dezelfde embed meteen bij',async t=>{
  const f=fixture(t),{message}=await f.publish({id:'3ff6ac9b2f8d'});
  await recoverPublishedActivityChecks(f.ctx,f.guild,NOW);
  const user=f.guild.members.cache.get(f.ids[0]).user,reaction=message.reactions.cache.get('✅');
  reaction.users.cache.set(user.id,user);
  await handleActivityCheckReaction(f.ctx,reaction,user,true,NOW+1000);
  const description=message.embeds[0].description;
  assert.match(description,/\*\*Bevestigd:\*\* 1\/2/);
  assert.ok(message.embeds[0].fields.some(field=>field.name==='✅ Actief bevestigd'&&field.value.includes(`<@${user.id}>`)));
});

test('vervalste of ongeldige privé manifesten worden overgeslagen zonder databasewijzigingen',async t=>{
  const mutations=[
    ({manifest})=>{manifest.author={id:OTHER};},
    ({manifest})=>{manifest.embeds[0].footer={text:'andere marker'};},
    ({manifest})=>{manifest.embeds[0].title='andere titel';},
    ({manifest})=>{manifest.content='BAKAROV_CHECKIN_RECOVERY_V1\n{';},
    ({manifest,data})=>{manifest.content='BAKAROV_CHECKIN_RECOVERY_V1\n'+JSON.stringify({...data,extra:true});},
    ({manifest,data})=>{manifest.content='BAKAROV_CHECKIN_RECOVERY_V1\n'+JSON.stringify({...data,members:[...data.members,data.members[0]]});},
    ({manifest,data})=>{manifest.content='BAKAROV_CHECKIN_RECOVERY_V1\n'+JSON.stringify({...data,members:['not-a-member-id']});},
    ({manifest,data})=>{manifest.content='BAKAROV_CHECKIN_RECOVERY_V1\n'+JSON.stringify({...data,createdAt:NOW+1});},
    ({manifest,data})=>{manifest.content='BAKAROV_CHECKIN_RECOVERY_V1\n'+JSON.stringify({...data,deadlineAt:DEADLINE+60000});},
    ({manifest,data})=>{manifest.content='BAKAROV_CHECKIN_RECOVERY_V1\n'+JSON.stringify({...data,channelId:'100000000000000999'});},
    ({manifest,data})=>{manifest.content='BAKAROV_CHECKIN_RECOVERY_V1\n'+JSON.stringify({...data,reason:'Andere reden'});}
  ];
  for(const mutate of mutations){
    const f=fixture(t),published=await f.publish();mutate(published);
    assert.equal(await recoverPublishedActivityChecks(f.ctx,f.guild,NOW),0);assert.equal(f.count('activity_check_sessions'),0);assert.equal(f.count('activity_check_members'),0);
  }
});

test('onveilige publieke berichten blokkeren herstel vóór er een check of warns worden opgeslagen',async t=>{
  const mutations=[
    ({message})=>{message.author={id:OTHER};},
    ({message})=>{message.embeds[0].footer={text:'Bakarov • Check-in fake'};},
    ({message})=>{message.embeds[0].title='Andere check';},
    ({message})=>{message.embeds[0].description=message.embeds[0].description.replace('🟢 Open','🔒 Afgerond');},
    ({message})=>{message.embeds[0].description=message.embeds[0].description.replace('Wekelijkse activiteitencheck','Andere reden');},
    ({message})=>{message.content='@everyone';},
    ({message})=>{message.createdTimestamp=NOW-120000;},
    ({message})=>{message.reactions.cache.clear();}
  ];
  for(const mutate of mutations){
    const f=fixture(t),published=await f.publish();mutate(published);
    await assert.rejects(recoverPublishedActivityChecks(f.ctx,f.guild,NOW),/veilig worden bevestigd/);assert.equal(f.count('activity_check_sessions'),0);assert.equal(f.count('activity_check_members'),0);
  }
});

test('meerdere geldige manifesten met dezelfde weekdeadline worden niet willekeurig geïmporteerd',async t=>{
  const f=fixture(t);await f.publish();await f.publish({id:'ffeeddccbbaa'});
  await assert.rejects(recoverPublishedActivityChecks(f.ctx,f.guild,NOW),/meerdere herstelberichten/);
  assert.equal(f.count('activity_check_sessions'),0);assert.equal(f.count('activity_check_occurrences'),0);
});

test('bestaande open checks, historische besluiten en weekregistraties blijven behouden',async t=>{
  for(const kind of ['open','closed','cancelled','occurrence']){
    const f=fixture(t),{data}=await f.publish();
    if(kind==='occurrence')f.ctx.store.db.prepare('INSERT INTO activity_check_occurrences(deadline_date,check_id) VALUES(?,?)').run(data.deadlineDate,'other-check');
    else f.ctx.store.db.prepare('INSERT INTO activity_check_sessions(id,creator_id,channel_id,created_at,deadline_at,status) VALUES(?,?,?,?,?,?)').run(kind==='open'?'other-check':data.id,f.guild.members.me.id,f.channel.id,NOW,DEADLINE,kind);
    assert.equal(await recoverPublishedActivityChecks(f.ctx,f.guild,NOW),0);
    assert.equal(f.count('activity_check_sessions'),kind==='occurrence'?0:1);assert.equal(f.count('activity_check_members'),0);
  }
});

test('verstreken checks en een andere guild of ingesteld kanaal worden niet geïmporteerd',async t=>{
  const f=fixture(t);await f.publish();
  assert.equal(await recoverPublishedActivityChecks(f.ctx,f.guild,DEADLINE),0);assert.equal(f.count('activity_check_sessions'),0);
  assert.equal(await recoverPublishedActivityChecks(f.source,f.guild,NOW),0);
  f.ctx.config.operations={activityCheck:{weeklyChannelId:f.ctx.config.planningChannelId}};
  assert.equal(await recoverPublishedActivityChecks(f.ctx,f.guild,NOW),0);assert.equal(f.count('activity_check_sessions'),0);
});

test('herstel vereist privé leidinglogs en leesrechten voor alle nog verplichte oorspronkelijke leden',async t=>{
  const f=fixture(t);await f.publish();
  const permissions=f.control.permissionsFor;f.control.permissionsFor=target=>target.id===f.guild.id?new PermissionsBitField(P.ViewChannel):permissions(target);
  await assert.rejects(recoverPublishedActivityChecks(f.ctx,f.guild,NOW),/zichtbaar voor een rol buiten de leiding/);
  f.control.permissionsFor=permissions;
  const publicPermissions=f.channel.permissionsFor;f.channel.permissionsFor=target=>target.id===f.ids[1]?new PermissionsBitField(P.ViewChannel):publicPermissions(target);
  await assert.rejects(recoverPublishedActivityChecks(f.ctx,f.guild,NOW),/Niet alle oorspronkelijke/);
  assert.equal(f.count('activity_check_sessions'),0);assert.equal(f.count('activity_check_members'),0);
});

test('een ledenstoring of verdwenen bericht produceert geen half geïmporteerde check',async t=>{
  const f=fixture(t),{message}=await f.publish(),list=f.guild.members.list;
  f.guild.members.list=async()=>{throw new Error('Leden niet beschikbaar');};
  await assert.rejects(recoverPublishedActivityChecks(f.ctx,f.guild,NOW),/Leden niet beschikbaar/);assert.equal(f.count('activity_check_sessions'),0);
  f.guild.members.list=list;await message.delete();
  await assert.rejects(recoverPublishedActivityChecks(f.ctx,f.guild,NOW),/veilig worden bevestigd/);assert.equal(f.count('activity_check_sessions'),0);
});

test('vastgelegde privé bericht-ID herstelt ook buiten de laatste honderd logs en wordt niet dubbel geteld',async t=>{
  const f=fixture(t),{data,manifest}=await f.publish();
  f.ctx.config.checkinRecoveryMessageIds=[manifest.id,manifest.id,'100000000000000999'];
  const fetch=f.control.messages.fetch;
  f.control.messages.fetch=async options=>{
    if(options.limit)return new Collection();
    if(options.message==='100000000000000999')throw Object.assign(new Error('Unknown message'),{code:10008});
    return fetch(options);
  };
  assert.equal(await recoverPublishedActivityChecks(f.ctx,f.guild,NOW),1);
  assert.equal(f.ctx.store.db.prepare('SELECT id FROM activity_check_sessions').get().id,data.id);
  f.control.messages.fetch=fetch;
  assert.equal(await recoverPublishedActivityChecks(f.ctx,f.guild,NOW),0);
  assert.equal(f.count('activity_check_sessions'),1);
});

test('reactiepagina’s worden volledig opgehaald vóór de snapshot atomair wordt geïmporteerd',async t=>{
  const f=fixture(t),{message}=await f.publish(),reaction=message.reactions.cache.get('✅');
  const outsiders=Array.from({length:100},(_,i)=>({id:String(BigInt('200000000000000000')+BigInt(i)),bot:false}));
  const requests=[];
  reaction.users.fetch=async options=>{
    requests.push(options);
    return options.after?new Collection([[f.ids[0],f.guild.members.cache.get(f.ids[0]).user],[f.ids[1],{id:f.ids[1],bot:true}]]):new Collection(outsiders.map(user=>[user.id,user]));
  };
  assert.equal(await recoverPublishedActivityChecks(f.ctx,f.guild,NOW),1);
  assert.deepEqual(requests,[{limit:100},{limit:100,after:outsiders.at(-1).id}]);
  assert.deepEqual(f.ctx.store.db.prepare('SELECT user_id,status FROM activity_check_members ORDER BY user_id').all().map(row=>({...row})),[{user_id:f.ids[0],status:'responded'},{user_id:f.ids[1],status:'pending'}]);
});

test('een onvolledige of vastgelopen reactielijst laat geen gedeeltelijke checkregistratie achter',async t=>{
  for(const stalled of [false,true]){
    const f=fixture(t),{message}=await f.publish(),reaction=message.reactions.cache.get('✅');
    const users=new Collection(Array.from({length:100},(_,i)=>{const id=String(BigInt('200000000000000000')+BigInt(i));return[id,{id,bot:false}];}));
    reaction.users.fetch=async options=>{if(options.after&&!stalled)throw new Error('Reacties niet beschikbaar');return users;};
    await assert.rejects(recoverPublishedActivityChecks(f.ctx,f.guild,NOW),stalled?/niet volledig worden opgehaald/:/Reacties niet beschikbaar/);
    assert.equal(f.count('activity_check_sessions'),0);assert.equal(f.count('activity_check_members'),0);assert.equal(f.count('activity_check_occurrences'),0);
  }
});
