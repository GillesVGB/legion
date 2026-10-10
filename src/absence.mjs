import {randomBytes} from 'node:crypto';
import {MessageFlags,ButtonStyle} from 'discord.js';
import {assertUser} from './errors.mjs';
import {embed,row,button,safeText} from './ui.mjs';
import {quiet,staffLogChannel} from './service.mjs';
import {serializeCommunity,updateCommunityPost} from './community-posts.mjs';
import {planningTime} from './activities.mjs';
import {missionDay} from './mission-definitions.mjs';
import {gangpotWindow,gangpotPeriodId,requireGangPot,gangpotEligible,GANGPOT_LEAD_ROLE_ID,reconcileGangpotDebt} from './gangpot.mjs';
import {operationSettings} from './feature-settings.mjs';
import {queueFeatureNotice,deliverFeatureNotices} from './notices.mjs';
const uid=()=>randomBytes(6).toString('hex');
const statusLabels={pending:'Wacht op Lead',approved:'Goedgekeurd',rejected:'Afgewezen',cancelled:'Ingetrokken'};
const shift=(date,days)=>missionDay(Date.parse(date+'T12:00:00Z')+days*86400000);
export const exemptionFor=(ctx,user,week)=>ctx.store.db.prepare('SELECT * FROM gangpot_exemptions WHERE user_id=? AND period_id=? AND revoked_at IS NULL').get(user,week);
export const absenceById=(ctx,id)=>ctx.store.db.prepare('SELECT * FROM absence_requests WHERE id=?').get(id);
export function approvedAway(ctx,activity,user){
  const date=missionDay(activity.starts_at);
  return ctx.store.db.prepare("SELECT * FROM absence_requests WHERE user_id=? AND status='approved' AND ((kind='planning' AND activity_id=?) OR (kind='range' AND start_date<=? AND end_date>=?)) ORDER BY reviewed_at DESC LIMIT 1").get(user,activity.id,date,date);
}
export function activityAbsences(ctx,activity){
  const date=missionDay(activity.starts_at),rows=ctx.store.db.prepare("SELECT * FROM absence_requests WHERE status IN ('pending','approved','rejected') AND ((kind='planning' AND activity_id=?) OR (kind='range' AND status='approved' AND start_date<=? AND end_date>=?)) ORDER BY CASE status WHEN 'approved' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,created_at DESC").all(activity.id,date,date);
  const result=new Map();for(const item of rows){const response=ctx.store.db.prepare('SELECT response FROM activity_rsvps WHERE activity_id=? AND user_id=?').get(activity.id,item.user_id)?.response;if(response&&response!=='no')continue;if(!result.has(item.user_id))result.set(item.user_id,item);}
  return [...result.values()];
}
function grantInside(ctx,user,week,actor,reason,request,now){
  if(exemptionFor(ctx,user,week))return;
  ctx.store.db.prepare('INSERT INTO gangpot_exemptions(id,user_id,period_id,actor_id,reason,request_id,created_at) VALUES(?,?,?,?,?,?,?)').run(uid(),user,week,actor,reason,request,now);
  reconcileGangpotDebt(ctx,week,user,actor,now);
  ctx.store.audit('absence.exemption',actor,{user,week,request});
}
export async function requireLead(ctx,guild,member){
  requireGangPot(ctx);assertUser(guild.id===ctx.config.guildId,'Kies de Legion-hoofdserver.');const fresh=await guild.members.fetch({user:member.id,force:true});
  assertUser(!fresh.user.bot&&fresh.roles.cache.has(GANGPOT_LEAD_ROLE_ID),'Alleen Lead kan afmeldingen en vrijstellingen beoordelen.');return fresh;
}
export async function createAbsence(ctx,guild,user,input,now=Date.now()){
  requireGangPot(ctx);const member=await guild.members.fetch({user,force:true});assertUser(input.activityId?!member.user.bot:gangpotEligible(ctx,member),'Alleen Legion-leden kunnen afwezigheid aanvragen.');
  const channel=await staffLogChannel(guild,ctx.config),reason=String(input.reason||'').trim();assertUser(reason&&reason.length<=500,'Geef een reden van 1 tot 500 tekens.');
  let start,end,weeks=[];
  if(input.activityId){const activity=ctx.store.db.prepare('SELECT * FROM activities WHERE id=?').get(input.activityId);assertUser(activity?.status==='open'&&activity.ends_at>now,'Deze planning is niet meer open.');const approved=approvedAway(ctx,activity,user);if(approved){ctx.store.transaction(()=>{ctx.store.db.prepare("INSERT INTO activity_rsvps(activity_id,user_id,response,updated_at) VALUES(?,?,'no',?) ON CONFLICT(activity_id,user_id) DO UPDATE SET response='no',updated_at=excluded.updated_at").run(activity.id,user,now);ctx.store.db.prepare('UPDATE activities SET dirty=1,next_attempt=0 WHERE id=?').run(activity.id);ctx.store.audit('planning.absence.approved',user,{activity:activity.id,request:approved.id});});return approved;}}
  else{
    start=missionDay(planningTime(input.start,'12:00',now));end=missionDay(planningTime(input.end,'12:00',now));
    assertUser(start>=missionDay(now)&&end>=start,'Gebruik vandaag of een toekomstige begindatum en een einddatum na de begindatum.');
    assertUser(Date.parse(end)-Date.parse(start)<operationSettings(ctx).absence.maxDays*86400000,'Deze afwezigheid duurt langer dan de ingestelde maximale duur.');
    assertUser(Date.parse(start)-Date.parse(missionDay(now))<=366*86400000,'Kies een begindatum binnen een jaar.');
    for(let date=start;date<=end;date=shift(date,1)){const week=gangpotWindow(ctx.config.gangpot,planningTime(date,'12:00',now))?.id;if(week&&!weeks.includes(week))weeks.push(week);}
  }
  return serializeCommunity(`${guild.id}:absences`,()=>ctx.store.transaction(()=>{
    const previous=input.activityId?ctx.store.db.prepare("SELECT * FROM absence_requests WHERE user_id=? AND activity_id=? AND status IN ('pending','approved') ORDER BY created_at DESC LIMIT 1").get(user,input.activityId):ctx.store.db.prepare("SELECT * FROM absence_requests WHERE user_id=? AND kind='range' AND status='pending' AND start_date<=? AND end_date>=?").get(user,end,start);
    if(previous){assertUser(input.activityId,'Je hebt al een overlappende afwezigheidsaanvraag.');if(previous.status==='pending'&&!input.automatic&&input.reason!==previous.reason)ctx.store.db.prepare('UPDATE absence_requests SET reason=?,dirty=1,next_attempt=0 WHERE id=?').run(reason,previous.id);return absenceById(ctx,previous.id);}
    const id=uid();ctx.store.db.prepare('INSERT INTO absence_requests(id,user_id,kind,activity_id,start_date,end_date,weeks,reason,created_at,channel_id) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,user,input.activityId?'planning':'range',input.activityId||null,start||null,end||null,JSON.stringify(weeks),reason,now,channel.id);
    if(input.activityId){ctx.store.db.prepare("INSERT INTO activity_rsvps(activity_id,user_id,response,updated_at) VALUES(?,?,'no',?) ON CONFLICT(activity_id,user_id) DO UPDATE SET response='no',updated_at=excluded.updated_at").run(input.activityId,user,now);ctx.store.db.prepare('UPDATE activities SET dirty=1,next_attempt=0 WHERE id=?').run(input.activityId);}
    ctx.store.audit('absence.request',user,{id,kind:input.activityId?'planning':'range',weeks,activity:input.activityId});return absenceById(ctx,id);
  }));
}
export async function decideAbsence(ctx,guild,member,id,decision,now=Date.now()){
  const lead=await requireLead(ctx,guild,member);assertUser(['approve','reject'].includes(decision),'Kies goedkeuren of afwijzen.');
  return serializeCommunity(`${guild.id}:absences`,()=>ctx.store.transaction(()=>{
    const item=absenceById(ctx,id);assertUser(item,'Deze aanvraag bestaat niet.');if(item.status!=='pending')return item;
    const target=guild.members.cache.get(item.user_id);assertUser(item.kind==='planning'?target&&!target.user.bot:gangpotEligible(ctx,target),'De aanvrager heeft geen Legion-ledenrol meer.');
    if(decision==='approve'&&item.kind==='range')for(const week of JSON.parse(item.weeks))grantInside(ctx,item.user_id,week,lead.id,item.reason,item.id,now);
    ctx.store.db.prepare('UPDATE absence_requests SET status=?,reviewer_id=?,reviewed_at=?,dirty=1,next_attempt=0 WHERE id=?').run(decision==='approve'?'approved':'rejected',lead.id,now,id);
    if(item.activity_id)ctx.store.db.prepare('UPDATE activities SET dirty=1,next_attempt=0 WHERE id=?').run(item.activity_id);
    else ctx.store.db.prepare('UPDATE activities SET dirty=1,next_attempt=0 WHERE starts_at>=? AND starts_at<=?').run(planningTime(item.start_date,'00:00',now),planningTime(shift(item.end_date,1),'00:00',now));
    ctx.store.audit(`absence.${decision}`,lead.id,{id,user:item.user_id,weeks:JSON.parse(item.weeks),activity:item.activity_id});
    queueFeatureNotice(ctx,{key:`absence:${id}:decision`,kind:'absence',user:item.user_id,payload:{embeds:[embed(ctx.config,decision==='approve'?'Legion — Afmelding goedgekeurd':'Legion — Afmelding afgewezen',`Je aanvraag is ${decision==='approve'?'goedgekeurd':'afgewezen'}.${item.kind==='range'?`\nPeriode: ${item.start_date} t/m ${item.end_date}\nGangpotweken: ${JSON.parse(item.weeks).join(', ')}`:`\nPlanning: ${item.activity_id}`}\n${decision==='approve'?'Je afwezigheid is geregistreerd.':'Zonder goedgekeurde vrijstelling blijft de gangpotbijdrage verplicht.'}`).setColor(decision==='approve'?0x22C55E:0xEF4444)],allowedMentions:quiet},now});
    return absenceById(ctx,id);
  }));
}
export async function setExemption(ctx,guild,member,user,week,reason,revoke=false,now=Date.now()){
  const lead=await requireLead(ctx,guild,member),target=await guild.members.fetch({user,force:true});assertUser(gangpotEligible(ctx,target),'Kies een lid met de Legion-ledenrol.');
  const period=gangpotPeriodId(week);assertUser(typeof reason==='string'&&reason.trim()&&reason.length<=500,'Geef een reden van maximaal 500 tekens.');
  return ctx.store.transaction(()=>{
    if(revoke){const existing=exemptionFor(ctx,user,period);assertUser(existing,'Er is geen actieve vrijstelling voor deze week.');ctx.store.db.prepare('UPDATE gangpot_exemptions SET revoked_at=?,revoked_by=?,revoke_reason=? WHERE id=?').run(now,lead.id,reason.trim(),existing.id);reconcileGangpotDebt(ctx,period,user,lead.id,now);ctx.store.audit('absence.exemption.revoke',lead.id,{user,week:period});}
    else grantInside(ctx,user,period,lead.id,reason.trim(),null,now);
  });
}
export function absenceMessage(ctx,item){
  const planning=item.kind==='planning',pending=item.status==='pending';
  return{embeds:[embed(ctx.config,planning?'Legion — Afmelding planning':'Legion — Afwezigheidsaanvraag',`**Lid:** <@${item.user_id}>\n${planning?`**Planning:** ${item.activity_id}`:`**Periode:** ${item.start_date} t/m ${item.end_date}\n**Gangpotvrijstelling voor:** ${JSON.parse(item.weeks).join(', ')}`}\n**Reden:** ${safeText(item.reason)}\n**Status:** ${statusLabels[item.status]||item.status}${item.reviewer_id?`\n**Beoordeeld door:** <@${item.reviewer_id}>`:''}\n\n${planning?'Een rode reactie is pas een geldige afmelding na Lead-goedkeuring.':'Goedkeuren geeft vrijstelling voor de genoemde weken; een aanvraag alleen geeft geen vrijstelling.'}`).setColor(item.status==='approved'?0x22C55E:item.status==='pending'?0xF59E0B:0xEF4444).setFooter({text:`Legion • Afmelding ${item.id}`})],components:pending?[row(button(`absence:approve:${item.id}`,'Goedkeuren',ButtonStyle.Success),button(`absence:reject:${item.id}`,'Afwijzen',ButtonStyle.Danger))]:[],allowedMentions:quiet};
}
export async function syncAbsences(ctx,guild,now=Date.now()){
  if(!ctx.config.gangpot)return;
  for(const item of ctx.store.db.prepare('SELECT * FROM absence_requests WHERE dirty=1 AND next_attempt<=? LIMIT 20').all(now)){
    try{await staffLogChannel(guild,{...ctx.config,logChannelId:item.channel_id});await updateCommunityPost(ctx,guild,'absence_requests',item,absenceMessage(ctx,item),`Legion • Afmelding ${item.id}`);}
    catch(error){ctx.store.db.prepare('UPDATE absence_requests SET next_attempt=?,last_error=? WHERE id=?').run(now+60000,String(error.code||error.name),item.id);}
  }
  await deliverFeatureNotices(ctx,guild,now,item=>item.kind==='absence'?true:null,['absence']);
}
export async function handleAbsenceButton(ctx,interaction){
  await interaction.deferReply({flags:MessageFlags.Ephemeral});const [,decision,id]=interaction.customId.split(':'),item=absenceById(ctx,id);
  assertUser(item&&item.channel_id===interaction.channelId&&item.message_id===interaction.message.id,'Deze knop hoort niet bij de aanvraag.');
  const result=await decideAbsence(ctx,interaction.guild,interaction.member,id,decision);await syncAbsences(ctx,interaction.guild);
  return interaction.editReply({content:`Afmelding: ${statusLabels[result.status]||result.status}.`,allowedMentions:quiet});
}
export async function handleAbsenceCommand(ctx,interaction){
  requireGangPot(ctx);await interaction.deferReply({flags:MessageFlags.Ephemeral});const action=interaction.commandName==='afmelden'?'planning':interaction.options.getSubcommand();
  if(['aanvragen','planning'].includes(action)){
    const item=await createAbsence(ctx,interaction.guild,interaction.user.id,{activityId:action==='planning'?interaction.options.getString('planning',true):null,start:interaction.options.getString('van'),end:interaction.options.getString('tot'),reason:interaction.options.getString('reden',true)});await syncAbsences(ctx,interaction.guild);
    return interaction.editReply({content:item.status==='approved'?'Je afmelding is al goedgekeurd.':`Aanvraag \`${item.id}\` opgeslagen. Lead moet je afmelding goedkeuren${item.kind==='range'?`; aangevraagde gangpotweken: ${JSON.parse(item.weeks).join(', ')}`:''}.`,allowedMentions:quiet});
  }
  if(action==='status'){const requests=ctx.store.db.prepare('SELECT * FROM absence_requests WHERE user_id=? ORDER BY created_at DESC LIMIT 10').all(interaction.user.id);const exemptions=ctx.store.db.prepare('SELECT period_id FROM gangpot_exemptions WHERE user_id=? AND revoked_at IS NULL ORDER BY period_id DESC LIMIT 12').all(interaction.user.id);return interaction.editReply({content:`## Jouw afmeldingen\n${requests.map(item=>`• ${item.id} · ${item.status} · ${item.activity_id||`${item.start_date} t/m ${item.end_date}`}`).join('\n')||'Nog geen aanvragen.'}\n\n**Vrijgestelde gangpotweken:** ${exemptions.map(item=>item.period_id).join(', ')||'Geen.'}`,allowedMentions:quiet});}
  await setExemption(ctx,interaction.guild,interaction.member,interaction.options.getUser('gebruiker',true).id,interaction.options.getString('termijn',true),interaction.options.getString('reden',true),action==='vrijstelling-intrekken');
  return interaction.editReply({content:action==='vrijstelling-intrekken'?'Vrijstelling ingetrokken.':'Vrijstelling voor deze week opgeslagen.',allowedMentions:quiet});
}
