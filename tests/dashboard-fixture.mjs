import { Collection, PermissionsBitField, PermissionFlagsBits as P, IntentsBitField, GatewayIntentBits, EmbedBuilder } from 'discord.js';
import { Store } from '../src/store.mjs';
import { loadConfig } from '../src/config.mjs';
import { recruitmentState } from '../src/recruitment.mjs';
import { encryptTranscript } from '../src/viewer.mjs';
import { renderTranscript } from '../src/transcript-html.mjs';

export const ACTOR = '100000000000000001';
export const APPLICANT = '100000000000000010';
export const OTHER = '100000000000000099';
export function dashboardFixture() {
  const base=loadConfig({},false), contexts=new Map(), guilds=new Collection(), calls=[], invites=new Map();
  const client={user:{id:base.clientId},ws:{ping:37},isReady:()=>true,guilds:{cache:guilds},options:{intents:new IntentsBitField(GatewayIntentBits.MessageContent)}};
  let message=0;
  const rest={
    post:async(path,options)=>{calls.push({method:'post',path,options});const code=`example-${++message}`;invites.set(code,options.body.target_user_ids[0]);return {code,guild:{id:base.guilds[0].guildId},max_uses:1,expires_at:new Date(Date.now()+86400000).toISOString()};},
    get:async path=>{calls.push({method:'get',path});if(path.includes('target-users'))return Buffer.from(`user_id\n${invites.get(path.split('/')[2])}\n`);return {};},
    delete:async path=>{calls.push({method:'delete',path});invites.delete(path.split('/')[2]);},
    put:async(path,options)=>{calls.push({method:'put',path,options});return {};}
  };
  client.rest=rest;
  client.channels={fetch:async id=>{for(const guild of guilds.values())if(guild.channels.cache.has(id))return guild.channels.cache.get(id);throw Object.assign(new Error('Onbekend kanaal'),{code:10003});}};
  for(const settings of base.guilds){
    const config={...base,...settings,token:'NEVER-RETURN-THIS-TOKEN',transcriptViewerMode:'local',transcriptSiteURL:'https://dashboard.test',content:{...base.content}};
    const store=new Store(config,':memory:');const ctx={config,store,ready:true,recruitment:config.recruitment?recruitmentState(17):null};contexts.set(settings.guildId,ctx);
    const roles=new Collection();
    const role=(id,name,position,admin=false)=>({id,name,position,managed:false,permissions:new PermissionsBitField(admin?P.Administrator:0n),comparePositionTo(other){return position-other.position;}});
    roles.set(settings.guildId,role(settings.guildId,'@everyone',0));roles.set(settings.staffRoleIds[0],role(settings.staffRoleIds[0],'Leiding',40));roles.set(settings.memberRoleId,role(settings.memberRoleId,'Legion',4));
    for(const [i,id] of (settings.roster?.roleIds||[]).entries())roles.set(id,role(id,base.content.ranks[i] || 'Recruter',30-i));
    const cache=new Collection(),channels=new Collection();
    const guild={id:settings.guildId,name:settings.ticketsEnabled?'Legion Community | Future Roleplay':'Legion | Future Roleplay',memberCount:0,
      iconURL:()=>null,client,roles:{cache:roles,fetch:async id=>id?roles.get(id):roles},channels:{cache:channels,fetch:async id=>{if(!id)return channels;const channel=channels.get(id);if(!channel)throw Object.assign(new Error('Onbekend kanaal'),{code:10003});return channel;}},
      members:{cache,fetch:async options=>{const id=typeof options==='string'?options:options.user;const member=cache.get(id);if(!member)throw Object.assign(new Error('Onbekend lid'),{code:10007});return member;},list:async()=>new Collection(cache)}};
    guilds.set(guild.id,guild);
    const addMember=(id,name,ids,admin=false,bot=false)=>{
      const member={id,guild,client,displayName:name,displayAvatarURL:()=>null,permissions:new PermissionsBitField(admin?P.Administrator:0n)};
      const user={id,username:name.replace(/ /g,'_').toLowerCase(),bot,send:async payload=>{calls.push({method:'dm',user:id,payload});return{id:String(++message)};}};
      member.user=user;member.roles={cache:new Collection(ids.map(id=>[id,roles.get(id)])),highest:role('highest','Rang',admin?100:12),add:async value=>{const roleId=typeof value==='string'?value:value.id;member.roles.cache.set(roleId,roles.get(roleId)||value);calls.push({method:'roles.add',user:id,role:roleId});},remove:async roleId=>{member.roles.cache.delete(roleId);calls.push({method:'roles.remove',user:id,role:roleId});},set:async values=>{member.roles.cache=new Collection(values.map(id=>[id,roles.get(id)]));member.roles.highest=[...member.roles.cache.values()].sort((a,b)=>b.position-a.position)[0]||role('none','Geen rang',0);calls.push({method:'roles.set',user:id,roles:values});}};
      cache.set(id,member);return member;
    };
    guild.addMember=addMember;
    guild.members.me=addMember(base.clientId,'Legion',[],true,true);
    guild.members.fetchMe=async()=>guild.members.me;
    addMember(ACTOR,'Voorbeeld leiding',settings.staffRoleIds,true);addMember(OTHER,'Nieuw communitylid',[]);
    const names=['Jay Vega','Noah Moreau','Luca Renaud','Milan Dupont','Rafael Leclerc','Enzo Laurent','Milo Ferrand','Alex Mercier','Samuel Beaufort','Louis Pascal','Finn Laurent','Victor Dumont','Lucas Martin','Nolan Pierre','Daan Lefevre','Elias Lucien','Tygo Roland'];
    for(let i=0;i<names.length;i++)addMember(String(BigInt('100000000000000020')+BigInt(i)),names[i],[settings.memberRoleId,...(settings.roster?[settings.roster.roleIds[Math.min(i,settings.roster.roleIds.length-1)]]:[])]);
    if(settings.ticketsEnabled)addMember(APPLICANT,'Kai Mercier',[]);
    const makeChannel=(id,name,topic='')=>{
      const posted=new Collection();
      const channel={id,name,guild,guildId:guild.id,type:0,topic,client,isTextBased:()=>true,
        permissionOverwrites:{cache:new Collection(),edit:async()=>{}},
        permissionsFor:target=>new PermissionsBitField(target.id===base.clientId||config.staffRoleIds.includes(target.id)||target.permissions?.has(P.Administrator)?P.Administrator:0n),
        delete:async()=>{channels.delete(id);calls.push({method:'channel.delete',id});},
        messages:{fetch:async options=>typeof options==='string'?posted.get(options)||null:new Collection([...posted].filter(([id,m])=>!options.before||BigInt(id)<BigInt(options.before)).slice(0,100))},
        setName:async value=>{channel.name=value;},
        send:async payload=>{
          const id=String(BigInt('100000000000000500')+BigInt(++message));
          const item={id,channelId:channel.id,guild,channel,partial:false,createdTimestamp:Date.now(),author:client.user,member:{displayName:'Legion'},content:'',attachments:new Collection(),embeds:[],components:[]};
          const apply=payload=>{if(payload.content!==undefined)item.content=payload.content;if(payload.embeds)item.embeds=payload.embeds.map(card=>{const json=card.toJSON?.()||card;return{...json,toJSON:()=>json};});if(payload.components)item.components=payload.components.map(row=>row.toJSON?.()||row);};
          item.edit=async payload=>{apply(payload);calls.push({method:'message.edit',id,payload});return item;};
          item.delete=async()=>posted.delete(id);item.fetch=async()=>item;
          item.reactions={cache:new Collection()};
          item.react=async emoji=>{
            let reaction=item.reactions.cache.get(emoji);
            if(!reaction){const users=new Collection();reaction={emoji:{name:emoji},message:item,partial:false,
              users:{cache:users,fetch:async options=>new Collection([...users].filter(([id])=>!options?.after||BigInt(id)>BigInt(options.after)).slice(0,options?.limit||100)),remove:async user=>{users.delete(user);calls.push({method:'reaction.remove',emoji,user});}}};
              Object.defineProperty(reaction,'me',{get:()=>users.has(client.user.id)});item.reactions.cache.set(emoji,reaction);}
            reaction.users.cache.set(client.user.id,{...client.user,bot:true});calls.push({method:'reaction.add',emoji,id});return reaction;
          };
          apply(payload);posted.set(id,item);return item;
        },posted};
      channels.set(id,channel);return channel;
    };
    guild.makeChannel=makeChannel;
    for(const id of [config.logChannelId,config.warnLogChannelId,config.applicationTranscriptChannelId,config.ticketTranscriptChannelId,config.panelChannelId,config.planningChannelId,config.admission.inviteChannelId].filter(Boolean))makeChannel(id,'legion-beheer');
    if(config.roster)makeChannel(config.roster.channelId,'ledenlijst');
    if(config.gangpot){makeChannel(config.gangpot.paymentsChannelId,'gangpot-betalingen');makeChannel(config.gangpot.totalChannelId,'gangpot');}
    ctx.store.wallet('100000000000000020');ctx.store.adjustCoins('100000000000000020',2500,ACTOR,'Voorbeeldsaldo');
    ctx.store.wallet('100000000000000021');ctx.store.adjustCoins('100000000000000021',1350,ACTOR,'Voorbeeldsaldo');
  }
  const source=contexts.get(base.guilds[1].guildId),guild=guilds.get(source.config.guildId);
  const open=source.store.reserveCase('application',APPLICANT,{template:true});
  const channel=guild.makeChannel('100000000000000100','sollicitatie-kai-mercier',`Legion dossier:${open.id} | application`);
  source.store.bindCase(open.id,channel.id);source.store.openCase(open.id,'100000000000000101');
  const time=Date.now()-7200000;
  const messages=[
    {id:'100000000000000101',createdTimestamp:time,author:{id:base.clientId,tag:'Legion',bot:true},member:{displayName:'Legion'},content:'',embeds:[{toJSON:()=>({title:'Legion — Sollicitatie',description:'Welkom! Vul de sollicitatietemplate in dit kanaal in.'})}],attachments:new Collection(),edit:async()=>{}},
    {id:'100000000000000102',createdTimestamp:time+60000,author:{id:APPLICANT,tag:'Kai Mercier',bot:false},member:{displayName:'Kai Mercier'},content:'Naam: Kai Mercier\nLeeftijd: 19\nPlaytime: 240 uur\nMotivatie: Ik wil samen met een actieve groep serieus roleplay spelen en mijn bijdrage leveren aan Legion.',embeds:[],attachments:new Collection(),edit:async()=>{}},
    {id:'100000000000000103',createdTimestamp:time+120000,author:{id:ACTOR,tag:'Leiding',bot:false},member:{displayName:'Leiding'},content:'Bedankt voor je antwoorden. We bespreken je sollicitatie met de leiding.',embeds:[],attachments:new Collection(),edit:async()=>{}}
  ];
  for(const message of messages)channel.posted.set(message.id,message);
  const ticket=source.store.reserveCase('ticket',OTHER,{});source.store.bindCase(ticket.id,'100000000000000110');source.store.openCase(ticket.id,'100000000000000111');guild.makeChannel('100000000000000110','vraag-nieuw-communitylid',`Legion dossier:${ticket.id} | ticket`);
  const closed=source.store.reserveCase('application','100000000000000020',{template:true});source.store.bindCase(closed.id,'100000000000000200');source.store.openCase(closed.id,'100000000000000201');source.store.closeCase(closed.id,'accepted',ACTOR);source.store.acceptanceSent(closed.id,'100000000000000202',true);
  const record=messages.map(item=>({id:item.id,created:item.createdTimestamp,author:item.member.displayName,authorId:item.author.id,bot:item.author.bot,content:item.content,embeds:item.embeds.map(card=>card.toJSON()),attachments:[]}));
  source.store.saveTranscriptView(closed.id,encryptTranscript(renderTranscript(guild,{id:closed.channel_id,name:'sollicitatie-jay-vega'},source.store.caseById(closed.id),record)));
  source.store.prepareTranscript(closed.id,[{name:'transcript.txt',content:'Voorbeeldgesprek'}]);source.store.finishTranscript(closed.id);
  const first=contexts.get(base.guilds[0].guildId);first.store.addWarn('100000000000000023',ACTOR,'Afspraken bij het vorige roleplay-evenement niet gevolgd.');
  return {base,client,contexts,guilds,calls,invites,source,open,closed,ticket,close:()=>{for(const ctx of contexts.values())ctx.store.close();}};
}
