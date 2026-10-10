import {randomBytes} from 'node:crypto';
import {ActionRowBuilder,StringSelectMenuBuilder,MessageFlags,ButtonStyle} from 'discord.js';
import {assertUser} from './errors.mjs';
import {embed,row,button} from './ui.mjs';
import {quiet} from './service.mjs';
import {communityChannel,serializeCommunity} from './community-posts.mjs';
import {createAbsence,syncAbsences} from './absence.mjs';
import {requireGangPot} from './gangpot.mjs';
import {operationSettings} from './feature-settings.mjs';
import {missionDay} from './mission-definitions.mjs';
const reasons={holiday:'Vakantie',work:'Werk of school',private:'Privéomstandigheden',illness:'Ziekte',other:'Andere verplichtingen'};
const shift=(date,days)=>missionDay(Date.parse(date+'T12:00:00Z')+days*86400000);
export async function publishAbsencePanel(ctx,guild){
  if(!ctx.config.absencePanelChannelId)return;
  return serializeCommunity(`${guild.id}:absence-panel`,async()=>{
    const channel=await communityChannel(guild,ctx.config.absencePanelChannelId),key=`absence:panel:${channel.id}`,marker='Legion • Afmeldingen';
    let message=ctx.store.setting(key)?await channel.messages.fetch(ctx.store.setting(key)).catch(error=>{if(error.code===10008)return null;throw error;}):null;
    if(!message){const history=await channel.messages.fetch({limit:100});message=[...history.values()].find(item=>item.author.id===guild.members.me.id&&item.embeds?.some(card=>card.footer?.text===marker));}
    assertUser(!message||message.author.id===guild.members.me.id,'Het afmeldpaneel hoort niet bij deze bot.');
    const payload={embeds:[embed(ctx.config,'Legion — Afmelden & afwezigheid','Kun je niet deelnemen? Kies hieronder wat je wilt melden.\n\n**📅 Afmelden voor planning**\nKies de activiteit waarvoor je afwezig bent. Een rode reactie is pas een geldige afmelding na goedkeuring van Lead.\n\n**🌴 Afwezigheid melden**\nKies een begin- en einddatum voor langere afwezigheid, zoals vakantie. Lead beoordeelt de aanvraag en eventuele gangpotvrijstelling voor de genoemde weken.\n\nJe maakt je keuzes privé via dit paneel. Een aanvraag geeft pas toestemming nadat Lead deze heeft goedgekeurd.').setFooter({text:marker})],components:[row(button('absencepanel:planning','📅 Afmelden voor planning',ButtonStyle.Primary),button('absencepanel:range','🌴 Afwezigheid melden',ButtonStyle.Secondary))],allowedMentions:quiet};
    const posted=message?await message.edit(payload):await channel.send({...payload,nonce:`ap:${channel.id}`,enforceNonce:true});ctx.store.setSetting(key,posted.id);ctx.store.setSetting('absence:panel:error','');return posted;
  });
}
function select(id,placeholder,options){return new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(id).setPlaceholder(placeholder).addOptions(options));}
function monthOptions(draft,ctx,now){
  const date=draft.stage.startsWith('end')?draft.start_date:missionDay(now),last=draft.stage.startsWith('end')?shift(date,operationSettings(ctx).absence.maxDays-1):shift(date,366),[y,m]=date.split('-').map(Number),items=[];
  for(let offset=0;offset<13;offset++){const month=new Date(Date.UTC(y,m-1+offset,1,12)),value=month.toISOString().slice(0,7);if(value>last.slice(0,7))break;items.push({label:month.toLocaleDateString('nl-BE',{timeZone:'Europe/Brussels',month:'long',year:'numeric'}),value});}return items;
}
function dayOptions(draft,ctx,now){
  const from=draft.stage.startsWith('end')?draft.start_date:missionDay(now),until=draft.stage.startsWith('end')?shift(from,operationSettings(ctx).absence.maxDays-1):shift(from,366),[y,m]=draft.month.split('-').map(Number),days=new Date(Date.UTC(y,m,0,12)).getUTCDate(),items=[];
  for(let d=1;d<=days;d++){const value=`${draft.month}-${String(d).padStart(2,'0')}`;if(value<from||value>until)continue;items.push({label:new Date(value+'T12:00:00Z').toLocaleDateString('nl-BE',{timeZone:'Europe/Brussels',weekday:'long',day:'numeric',month:'long'}),value});}return items;
}
export function absenceDraftMessage(ctx,draft,now=Date.now()){
  let options,placeholder;
  if(draft.stage.endsWith('month')){options=monthOptions(draft,ctx,now);placeholder=draft.stage==='start-month'?'Begindatum: kies maand':'Einddatum: kies maand';}
  else if(draft.stage.endsWith('day')){options=dayOptions(draft,ctx,now);placeholder=draft.stage==='start-day'?'Kies de begindatum':'Kies de einddatum';}
  else{options=Object.entries(reasons).map(([value,label])=>({value,label}));placeholder='Waarom ben je afwezig?';}
  const page=options.slice(draft.page*25,draft.page*25+25),components=[select(`absflow:choose:${draft.id}:${draft.revision}`,placeholder,page)];
  if(options.length>25)components.push(row(button(`absflow:prev:${draft.id}:${draft.revision}`,'Vorige dagen').setDisabled(draft.page===0),button(`absflow:next:${draft.id}:${draft.revision}`,'Meer dagen').setDisabled((draft.page+1)*25>=options.length)));
  components.push(row(button(`absflow:restart:${draft.id}:${draft.revision}`,'Datums opnieuw kiezen')));
  return{content:`## Afwezigheid melden\n${draft.start_date?`**Vanaf:** ${draft.start_date}\n`:''}${draft.end_date?`**Tot en met:** ${draft.end_date}\n`:''}${placeholder}. De aanvraag wordt na je laatste keuze naar Lead gestuurd.`,components,embeds:[],allowedMentions:quiet};
}
export async function handleAbsencePanel(ctx,interaction,now=Date.now()){
  requireGangPot(ctx);await interaction.deferReply({flags:MessageFlags.Ephemeral});const [,kind]=interaction.customId.split(':');
  assertUser(interaction.channelId===ctx.config.absencePanelChannelId&&interaction.message.id===ctx.store.setting(`absence:panel:${interaction.channelId}`),'Gebruik het huidige afmeldpaneel.');
  if(kind==='planning'){
    const items=ctx.store.db.prepare("SELECT * FROM activities WHERE status='open' AND ends_at>? ORDER BY starts_at LIMIT 25").all(now);
    if(!items.length)return interaction.editReply({content:'Er zijn nog geen open planningen.',components:[]});
    return interaction.editReply({content:'Kies de planning waarvoor je je wilt afmelden. Lead moet de aanvraag goedkeuren.',components:[select(`absplan:choose:${interaction.user.id}`,'Kies een planning',items.map(item=>({label:item.title.slice(0,80),description:new Date(item.starts_at).toLocaleString('nl-BE',{timeZone:'Europe/Brussels'}).slice(0,100),value:item.id})))]});
  }
  assertUser(kind==='range','Onbekende afmeldkeuze.');const id=randomBytes(6).toString('hex');ctx.store.db.prepare("INSERT INTO absence_drafts(id,user_id,stage,expires) VALUES(?,?,'start-month',?) ON CONFLICT(user_id) DO UPDATE SET id=excluded.id,stage='start-month',revision=0,month=NULL,start_date=NULL,end_date=NULL,page=0,expires=excluded.expires").run(id,interaction.user.id,now+1800000);
  return interaction.editReply(absenceDraftMessage(ctx,ctx.store.db.prepare('SELECT * FROM absence_drafts WHERE id=?').get(id),now));
}
export async function handleAbsenceSelection(ctx,interaction,now=Date.now()){
  requireGangPot(ctx);const [type,action,id,revision]=interaction.customId.split(':');
  if(type==='absplan'){
    assertUser(id===interaction.user.id,'Deze keuzes horen bij een ander lid.');await interaction.deferUpdate();const item=await createAbsence(ctx,interaction.guild,id,{activityId:interaction.values[0],reason:'Afmelding aangevraagd via het planningpaneel. Het lid kan toelichten met /afmelden.'},now);await syncAbsences(ctx,interaction.guild,now);
    return interaction.editReply({content:item.status==='approved'?'Je afmelding is al goedgekeurd.':`Je afmelding \`${item.id}\` wacht op goedkeuring van Lead.`,components:[]});
  }
  return serializeCommunity(`${ctx.config.guildId}:absence-draft:${id}`,async()=>{
    const draft=ctx.store.db.prepare('SELECT * FROM absence_drafts WHERE id=?').get(id);assertUser(draft&&draft.user_id===interaction.user.id&&draft.expires>now,'Deze afmelding is verlopen of hoort bij iemand anders. Klik opnieuw op de embed.');assertUser(draft.revision===Number(revision),'Deze keuze is verouderd. Gebruik de nieuwste keuzelijst.');await interaction.deferUpdate();
    const options=draft.stage.endsWith('month')?monthOptions(draft,ctx,now):draft.stage.endsWith('day')?dayOptions(draft,ctx,now):Object.entries(reasons).map(([value,label])=>({value,label}));
    if(action==='restart')ctx.store.db.prepare("UPDATE absence_drafts SET stage='start-month',month=NULL,start_date=NULL,end_date=NULL,page=0,revision=revision+1 WHERE id=?").run(id);
    else if(action==='next'||action==='prev'){const page=draft.page+(action==='next'?1:-1);assertUser(page>=0&&page*25<options.length,'Deze pagina is niet beschikbaar.');ctx.store.db.prepare('UPDATE absence_drafts SET page=?,revision=revision+1 WHERE id=?').run(page,id);}
    else{
      const value=interaction.values?.[0];assertUser(options.some(option=>option.value===value),'Kies een waarde uit de keuzelijst.');
      if(draft.stage==='reason'){
        const item=await createAbsence(ctx,interaction.guild,draft.user_id,{start:draft.start_date,end:draft.end_date,reason:reasons[value]},now);ctx.store.db.prepare('DELETE FROM absence_drafts WHERE id=?').run(id);await syncAbsences(ctx,interaction.guild,now);
        return interaction.editReply({content:`Afwezigheid **${draft.start_date} t/m ${draft.end_date}** aangevraagd. Lead moet goedkeuren. Gangpotweken: ${JSON.parse(item.weeks).join(', ')}.`,components:[],embeds:[]});
      }
      const stage={'start-month':'start-day','start-day':'end-month','end-month':'end-day','end-day':'reason'}[draft.stage],field=draft.stage.endsWith('month')?'month':draft.stage==='start-day'?'start_date':'end_date';
      ctx.store.db.prepare(`UPDATE absence_drafts SET ${field}=?,stage=?,page=0,revision=revision+1 WHERE id=?`).run(value,stage,id);
    }
    return interaction.editReply(absenceDraftMessage(ctx,ctx.store.db.prepare('SELECT * FROM absence_drafts WHERE id=?').get(id),now));
  });
}
