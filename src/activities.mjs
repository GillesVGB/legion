import { randomBytes } from 'node:crypto';
import { MessageFlags,PermissionFlagsBits as P } from 'discord.js';
import { assertUser } from './errors.mjs';
import { safeText } from './ui.mjs';
import { quiet,requireStaff } from './service.mjs';
import { communityChannel,serializeCommunity,updateCommunityPost } from './community-posts.mjs';
const latestReactions=new Map();

export const attendanceChoices=[
  {id:'yes',emoji:'🟢',label:'Ik ben erbij'},
  {id:'late',emoji:'🕒',label:'Ik ben later'},
  {id:'no',emoji:'🔴',label:'Ik ben er niet bij'},
  {id:'maybe',emoji:'🟠',label:'Ik weet het nog niet zeker'}
];
export const planningPreparation='### Kom voorbereid\n• Zorg dat je volledig bent geheald.\n• Tank je voertuig vooraf helemaal vol.\n• Neem voldoende repairkits en de benodigde spullen mee.\n• Sta op tijd klaar op het afspreekpunt.\n• Volg de aanwijzingen van de leiding en houd de communicatie duidelijk.';
export function requirePlanningGuild(ctx){assertUser(ctx.config.guildId==='1555685630640652338'&&ctx.config.planningChannelId,'De planning wordt alleen in de Legion-gangserver beheerd.');}
export function planningTime(date,time,now=Date.now()) {
  let y,m,d;
  const input=String(date).trim().toLowerCase().replace(/\s+/g,' ');
  const relative=input==='deze avond'||input==='dezeavond'?0:input==='morgenavond'||input==='morgen avond'?1:null;
  if(relative!==null){
    const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Brussels',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(now)).map(part=>[part.type,part.value]));
    const calendar=new Date(Date.UTC(+parts.year,+parts.month-1,+parts.day+relative,12));
    y=calendar.getUTCFullYear();m=calendar.getUTCMonth()+1;d=calendar.getUTCDate();
  }else{
    let match=/^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
    if(match)[,y,m,d]=match.map(Number);
    else {match=/^(\d{2})[-/](\d{2})[-/](\d{4})$/.exec(input);assertUser(match,'Gebruik DD-MM-JJJJ, deze avond of morgenavond.');[,d,m,y]=match.map(Number);}
  }
  const clock=/^(\d{2}):(\d{2})$/.exec(time);
  assertUser(clock&&Number(clock[1])<24&&Number(clock[2])<60,'Gebruik een geldige tijd in UU:MM, bijvoorbeeld 20:30.');
  const h=Number(clock[1]),minute=Number(clock[2]);
  const formatter=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Brussels',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  const candidates=[60,120].map(offset=>Date.UTC(y,m-1,d,h,minute)-offset*60000).filter(timestamp=>{
    const parts=Object.fromEntries(formatter.formatToParts(new Date(timestamp)).map(part=>[part.type,part.value]));
    return +parts.year===y&&+parts.month===m&&+parts.day===d&&+parts.hour===h&&+parts.minute===minute;
  });
  assertUser(candidates.length===1,candidates.length?'Dit tijdstip komt twee keer voor door de wintertijd. Kies een tijd buiten dat overgangsuur.':'Deze datum of tijd bestaat niet. Controleer ook de overgang naar de zomertijd.');
  return candidates[0];
}
export function planningDateSuggestions(value,now=Date.now()){
  const compact=String(value||'').trim().toLowerCase().replace(/\s+/g,'');
  const choices=[['Deze avond','deze avond'],['Morgenavond','morgenavond']].map(([name,value])=>{
    const date=new Date(planningTime(value,'20:00',now)).toLocaleDateString('nl-BE',{timeZone:'Europe/Brussels',day:'2-digit',month:'2-digit',year:'numeric'});
    return {name:`${name} (${date})`,value};
  }).filter(choice=>!compact||choice.name.toLowerCase().replace(/\s+/g,'').includes(compact)||choice.value.replace(/\s+/g,'').includes(compact));
  const typed=String(value||'').trim();
  if(/^\d{2}[-/]\d{2}[-/]\d{4}$|^\d{4}-\d{2}-\d{2}$/.test(typed)){
    try{planningTime(typed,'20:00',now);choices.unshift({name:typed,value:typed});}catch{}
  }
  return choices;
}
export async function handlePlanningAutocomplete(ctx,interaction,now=Date.now()){
  const option=interaction.options.getFocused(true);
  const choices=ctx?.config.guildId==='1555685630640652338'&&ctx.config.planningChannelId&&option.name==='datum'?planningDateSuggestions(option.value,now):[];
  await interaction.respond(choices);
}
export const activityById=(ctx,id)=>ctx.store.db.prepare('SELECT * FROM activities WHERE id=?').get(id);
export function activityMessage(ctx,activity,now=Date.now()) {
  const responses=ctx.store.db.prepare('SELECT user_id,response FROM activity_rsvps WHERE activity_id=? ORDER BY updated_at,user_id').all(activity.id);
  const open=activity.status==='open'&&now<activity.ends_at;
  const date=new Date(activity.starts_at);
  const dateText=date.toLocaleDateString('nl-BE',{timeZone:'Europe/Brussels',day:'2-digit',month:'2-digit',year:'numeric'});
  const timeText=date.toLocaleTimeString('nl-BE',{timeZone:'Europe/Brussels',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  let content=`## Legion — Planning\n**Activiteit:** ${safeText(activity.title)}\n**Datum:** ${dateText}\n**Tijd:** ${timeText} (Belgische tijd) · <t:${Math.floor(activity.starts_at/1000)}:R>\n**Afspreekpunt:** ${safeText(activity.location)}\n`;
  if(activity.description)content+=`\n${safeText(activity.description)}\n`;
  content+=`\n${planningPreparation}\n\n### Laat weten of je erbij bent\n`;
  content+=attendanceChoices.map(choice=>`${choice.emoji}: ${choice.label} — **${responses.filter(item=>item.response===choice.id).length}**`).join('\n');
  content+=open?'\n\nReageer op dit bericht met één van de vier emoji’s. Je kunt je keuze later aanpassen.':`\n\n**${activity.status==='cancelled'?'Deze activiteit is geannuleerd.':'Deze activiteit is afgelopen.'}**`;
  content+=`\n-# Planning-ID: \`${activity.id}\``;
  assertUser(content.length<=2000,'Deze planning is te lang. Gebruik een kortere titel, locatie of toelichting.');
  return {content,embeds:[],components:[],allowedMentions:quiet};
}
export async function seedPlanningReactions(message) {
  if(!message)return;
  for(const choice of attendanceChoices)if(!message.reactions.cache.get(choice.emoji)?.me)await message.react(choice.emoji);
}
async function writeActivity(ctx,guild,activity) {
  const posted=await updateCommunityPost(ctx,guild,'activities',activity,activityMessage(ctx,activity),`Planning-ID: \`${activity.id}\``);
  if(activity.status==='open'&&Date.now()<activity.ends_at){
    try{await seedPlanningReactions(posted);}catch(error){ctx.store.db.prepare('UPDATE activities SET dirty=1,last_error=? WHERE id=?').run(String(error.code||error.name),activity.id);throw error;}
  }
  return posted;
}
export async function publishActivity(ctx,guild,id) {
  return serializeCommunity(`${guild.id}:activity:${id}`,async()=>{
    const activity=activityById(ctx,id);assertUser(activity,'Deze planning bestaat niet in deze server.');
    return writeActivity(ctx,guild,activity);
  });
}
export async function createActivity(ctx,interaction,input,now=Date.now()) {
  requirePlanningGuild(ctx);
  requireStaff(interaction,ctx.config);
  const starts=planningTime(input.date,input.time,now),duration=input.duration??120;
  assertUser(starts>=now+60000&&starts<=now+366*86400000,'Kies een tijdstip vanaf één minuut in de toekomst, binnen een jaar.');
  assertUser(Number.isInteger(duration)&&duration>=15&&duration<=720,'Kies een duur van 15 tot 720 minuten.');
  const title=(input.title||'Gangactiviteit').trim(),location=input.location?.trim(),description=(input.description||'').trim();
  assertUser(title.length>0&&title.length<=80&&location&&location.length<=160&&description.length<=250,'Gebruik een titel tot 80 tekens, een afspreekpunt tot 160 tekens en een toelichting tot 250 tekens.');
  const channel=await communityChannel(interaction.guild,ctx.config.planningChannelId);
  assertUser(channel.permissionsFor(interaction.guild.members.me)?.has([P.AddReactions,P.ManageMessages]),'Geef de bot Reacties toevoegen en Berichten beheren, zodat ieder lid één aanwezigheidskeuze kan maken.');
  const id=randomBytes(6).toString('hex');
  ctx.store.transaction(()=>{
    ctx.store.db.prepare('INSERT INTO activities(id,title,description,location,starts_at,ends_at,creator_id,channel_id) VALUES(?,?,?,?,?,?,?,?)').run(id,title,description,location,starts,starts+duration*60000,interaction.user.id,channel.id);
    ctx.store.audit('planning.create',interaction.user.id,{id,starts,channel:channel.id});
  });
  const posted=await publishActivity(ctx,interaction.guild,id).catch(error=>{ctx.store.db.prepare('UPDATE activities SET last_error=?,next_attempt=? WHERE id=?').run(String(error.code||error.name),Date.now()+60000,id);return null;});
  return {id,posted};
}
export async function cancelActivity(ctx,guild,id,actor) {
  return serializeCommunity(`${guild.id}:activity:${id}`,async()=>{
    const activity=activityById(ctx,id);assertUser(activity?.status==='open','Deze planning is al afgesloten of bestaat niet.');
    ctx.store.transaction(()=>{ctx.store.db.prepare("UPDATE activities SET status='cancelled',dirty=1,next_attempt=0 WHERE id=?").run(id);ctx.store.audit('planning.cancel',actor,{id});});
    return updateCommunityPost(ctx,guild,'activities',activityById(ctx,id),activityMessage(ctx,activityById(ctx,id)),`Planning-ID: \`${id}\``);
  });
}
export async function handlePlanningReaction(ctx,reaction,user,added) {
  if(user.bot)return;
  const choice=attendanceChoices.find(choice=>choice.emoji===reaction.emoji.name);if(!choice)return;
  const record=ctx.store.db.prepare('SELECT * FROM activities WHERE message_id=? AND channel_id=?').get(reaction.message.id,reaction.message.channelId);if(!record)return;
  const key=`${ctx.config.guildId}:${record.id}:${user.id}`,token={response:choice.id};
  if(added)latestReactions.set(key,token);
  if(reaction.message.partial)await reaction.message.fetch();
  return serializeCommunity(`${ctx.config.guildId}:activity:${record.id}`,async()=>{
    if(added&&latestReactions.get(key)!==token)return;
    const activity=activityById(ctx,record.id),id=record.id;
    if(activity.status!=='open'||Date.now()>=activity.ends_at){if(added)await reaction.users.remove(user.id);return;}
    if(added){
      const member=await reaction.message.guild.members.fetch({user:user.id,force:true}).catch(error=>{if(error.code===10007)return null;throw error;});
      if(!member||member.user.bot)return;
      if(latestReactions.get(key)!==token)return;
    }
    let changed=true;
    ctx.store.transaction(()=>{
      if(added)ctx.store.db.prepare('INSERT INTO activity_rsvps(activity_id,user_id,response,updated_at) VALUES(?,?,?,?) ON CONFLICT(activity_id,user_id) DO UPDATE SET response=excluded.response,updated_at=excluded.updated_at').run(id,user.id,choice.id,Date.now());
      else changed=ctx.store.db.prepare('DELETE FROM activity_rsvps WHERE activity_id=? AND user_id=? AND response=?').run(id,user.id,choice.id).changes>0;
      if(changed)ctx.store.db.prepare('UPDATE activities SET dirty=1,next_attempt=0 WHERE id=?').run(id);
    });
    if(!changed)return;
    if(added)for(const other of attendanceChoices)if(other.id!==choice.id&&latestReactions.get(key)===token){const old=reaction.message.reactions.cache.get(other.emoji);if(old)await old.users.remove(user.id);}
    await writeActivity(ctx,reaction.message.guild,activityById(ctx,id));
  }).finally(()=>{if(added&&latestReactions.get(key)===token)latestReactions.delete(key);});
}
export async function handlePlanningCommand(ctx,interaction) {
  requirePlanningGuild(ctx);
  const name=interaction.commandName;
  if(name==='planning') {
    requireStaff(interaction,ctx.config);await interaction.deferReply({flags:MessageFlags.Ephemeral});
    const result=await createActivity(ctx,interaction,{date:interaction.options.getString('datum',true),time:interaction.options.getString('tijd',true),location:interaction.options.getString('afspreekpunt',true)});
    return interaction.editReply({content:result.posted?`Planning geplaatst. ID: \`${result.id}\`. Deelnemers kunnen hun keuze doorgeven met de emoji-reacties.`:`Planning \`${result.id}\` is opgeslagen. De bot probeert het bericht automatisch opnieuw te plaatsen.`,allowedMentions:quiet});
  }
  if(name==='planning-annuleren'){
    requireStaff(interaction,ctx.config);await interaction.deferReply({flags:MessageFlags.Ephemeral});
    await cancelActivity(ctx,interaction.guild,interaction.options.getString('id',true),interaction.user.id);
    return interaction.editReply({content:'De planning is geannuleerd. Nieuwe aanwezigheidsreacties worden niet meer aangenomen.',allowedMentions:quiet});
  }
  const items=ctx.store.db.prepare("SELECT * FROM activities WHERE status='open' AND ends_at>? ORDER BY starts_at LIMIT 10").all(Date.now());
  let content='## Legion — Activiteitenkalender\n';
  for(const item of items){const line=`• **${safeText(item.title)}** · <t:${Math.floor(item.starts_at/1000)}:F>\n  ${safeText(item.location)}${item.message_id?` · [Planning openen](https://discord.com/channels/${interaction.guildId}/${item.channel_id}/${item.message_id})`:' · Bericht wordt geplaatst'}\n`;if(content.length+line.length>1900)break;content+=line;}
  if(!items.length)content+='Er staan nog geen activiteiten gepland. De leiding kan een activiteit toevoegen met /planning.';
  return interaction.reply({content,flags:MessageFlags.Ephemeral,allowedMentions:quiet});
}
export async function syncActivities(ctx,guild,now=Date.now()) {
  ctx.store.db.prepare("UPDATE activities SET status='ended',dirty=1,next_attempt=0 WHERE status='open' AND ends_at<=?").run(now);
  for(const item of ctx.store.db.prepare('SELECT id FROM activities WHERE dirty=1 AND next_attempt<=? LIMIT 10').all(now)){
    try{await publishActivity(ctx,guild,item.id);}catch(error){ctx.store.db.prepare('UPDATE activities SET last_error=?,next_attempt=? WHERE id=?').run(String(error.code||error.name),now+60000,item.id);}
  }
  ctx.planningSyncedAt??=new Map();
  for(const item of ctx.store.db.prepare("SELECT id FROM activities WHERE status='open' AND message_id IS NOT NULL ORDER BY starts_at LIMIT 20").all()){
    if(now-(ctx.planningSyncedAt.get(item.id)||0)<300000)continue;
    try{await syncPlanningReactions(ctx,guild,item.id);ctx.planningSyncedAt.set(item.id,now);}catch(error){console.error(`Planningreacties synchroniseren wacht op herhaling (${error.code||error.name}).`);}
  }
}

export async function syncPlanningReactions(ctx,guild,id) {
  return serializeCommunity(`${guild.id}:activity:${id}`,async()=>{
    const activity=activityById(ctx,id);if(activity?.status!=='open'||!activity.message_id)return;
    const channel=await communityChannel(guild,activity.channel_id),message=await channel.messages.fetch(activity.message_id);
    const votes=new Map(),previous=new Map(ctx.store.db.prepare('SELECT user_id,response FROM activity_rsvps WHERE activity_id=?').all(id).map(item=>[item.user_id,item.response]));
    for(const choice of attendanceChoices){
      const reaction=message.reactions.cache.get(choice.emoji);if(!reaction)continue;
      let after;
      for(let page=0;page<100;page++){
        const users=await reaction.users.fetch({limit:100,...(after?{after}:{})});
        for(const user of users.values())if(!user.bot&&guild.members.cache.has(user.id)){const choices=votes.get(user.id)||[];choices.push(choice.id);votes.set(user.id,choices);}
        if(users.size<100)break;
        assertUser(page<99,'Te veel reacties om deze planning in één keer te controleren.');
        after=users.last().id;
      }
    }
    const choices=new Map();
    for(const [user,responses] of votes){const selected=responses.includes(previous.get(user))?previous.get(user):responses.length===1?responses[0]:null;if(selected)choices.set(user,selected);}
    ctx.store.transaction(()=>{
      ctx.store.db.prepare('DELETE FROM activity_rsvps WHERE activity_id=?').run(id);
      for(const [user,choice] of choices)ctx.store.db.prepare('INSERT INTO activity_rsvps(activity_id,user_id,response,updated_at) VALUES(?,?,?,?)').run(id,user,choice,Date.now());
      ctx.store.db.prepare('UPDATE activities SET dirty=1,next_attempt=0 WHERE id=?').run(id);
    });
    for(const [user,responses] of votes)for(const response of responses)if(response!==choices.get(user))await message.reactions.cache.get(attendanceChoices.find(choice=>choice.id===response).emoji)?.users.remove(user);
    await writeActivity(ctx,guild,activityById(ctx,id));
  });
}
export async function clearPlanningReactions(ctx,message,emoji) {
  const activity=ctx.store.db.prepare('SELECT * FROM activities WHERE message_id=? AND channel_id=?').get(message.id,message.channelId);
  if(!activity||activity.status!=='open')return;
  const choice=emoji?attendanceChoices.find(choice=>choice.emoji===emoji):null;
  if(emoji&&!choice)return;
  await serializeCommunity(`${ctx.config.guildId}:activity:${activity.id}`,async()=>{
    if(choice)ctx.store.db.prepare('DELETE FROM activity_rsvps WHERE activity_id=? AND response=?').run(activity.id,choice.id);
    else ctx.store.db.prepare('DELETE FROM activity_rsvps WHERE activity_id=?').run(activity.id);
    ctx.store.db.prepare('UPDATE activities SET dirty=1,next_attempt=0 WHERE id=?').run(activity.id);
    await writeActivity(ctx,message.guild,activityById(ctx,activity.id));
  });
}
