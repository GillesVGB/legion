import {embed,safeText} from './ui.mjs';
import {cleanAudit} from './audit-sanitize.mjs';
const names={
  'message.delete':'🗑️ Bericht verwijderd','message.edit':'✏️ Bericht aangepast',
  'security.invite_created':'🔗 Uitnodiging aangemaakt — toegestaan',
  'security.media_links_allowed':'🎬 YouTube-/Medal-link toegestaan',
  'security.ticket_links_allowed':'🎫 Link toegestaan in ticket',
  'security.ready':'🛡️ Beveiligingscontrole gereed','security.unavailable':'⚠️ Beveiliging kan niet starten','security.messages_removed':'🗑️ Beveiliging: berichten verwijderd','security.notice_sent':'📨 Beveiligingsmelding via DM verstuurd','security.notice_failed':'⚠️ Beveiligingsmelding via DM niet bezorgd','security.check_failed':'⚠️ Beveiligingscontrole mislukt',
  'security.link_removed':'🔗 Linkbericht verwijderd','security.links_ban':'🚫 Meerdere links: ban','security.mention_ban':'🚫 Tagspam: ban','security.timeout':'⏳ Automatische time-out','security.ban':'⛔ Automatische ban','security.enforcement_failed':'⚠️ Beveiligingsactie mislukt','security.delete_failed':'⚠️ Beveiliging kon een bericht niet verwijderen','security.unauthorized_action':'🚫 Onbevoegde serveractie: ban','security.unauthorized_action_failed':'⚠️ Onbevoegde actie: ban mislukt','security.raid_detected':'🚨 Mogelijke serverraid','security.raid_timeout':'⏳ Raidbeveiliging: nieuw lid beperkt',
  'interaction.succeeded':'✅ Actie uitgevoerd','interaction.failed':'❌ Actie mislukt',
  'dashboard.action.succeeded':'🖥️ Dashboardactie uitgevoerd','dashboard.action.failed':'❌ Dashboardactie mislukt',
  'member.join':'👋 Lid toegetreden','member.leave':'🚪 Lid vertrokken','member.update':'👤 Lid bijgewerkt',
  'channel.create':'📁 Kanaal aangemaakt','channel.delete':'🗑️ Kanaal verwijderd','channel.update':'📁 Kanaal bijgewerkt',
  'role.create':'🏷️ Rol aangemaakt','role.delete':'🗑️ Rol verwijderd','role.update':'🏷️ Rol bijgewerkt',
  'warn.add':'⚠️ Gangwarn gegeven','warn.remove':'✅ Gangwarn ingetrokken',
  'planning.create':'📅 Planning geplaatst','planning.cancel':'📅 Planning geannuleerd','planning.rsvp':'📅 Planningsreactie gewijzigd',
  'gangpot.asset':'📦 Gangpotvoorraad bijgewerkt','gangpot.asset.void':'📦 Gangpotvoorraad gecorrigeerd',
  'activitycheck.recover-published':'✅ Gepubliceerde activiteitencheck hersteld',
  'activitycheck.create':'✅ Activiteitencheck gestart','activitycheck.respond':'✅ Activiteit bevestigd','activitycheck.finish':'🔒 Activiteitencheck afgerond','activitycheck.cancel':'Activiteitencheck geannuleerd',
  'absence.request':'🌴 Afmelding aangevraagd','absence.approve':'✅ Afmelding goedgekeurd','absence.reject':'❌ Afmelding afgewezen',
  'gangpot.report':'💰 Betaling gemeld','gangpot.approve':'✅ Betaling goedgekeurd','gangpot.reject':'❌ Betaling afgekeurd',
  'promotion.create':'📈 Promotie voorgesteld','promotion.vote':'🗳️ Promotiestem uitgebracht','promotion.approved':'📈 Promotie goedgekeurd',
  'notice.sent':'📨 Melding verstuurd','bot.update':'🆕 Bot bijgewerkt','backup.create':'💾 Back-up gemaakt',
  'dashboard.settings':'⚙️ Instellingen gewijzigd','guild.configure':'⚙️ Server ingericht','coins.adjust':'🪙 Coins aangepast','fish.week.claim':'🐟 Visbeloning geclaimd','mission.claim':'🎯 Missiebeloning geclaimd',
  'application.dm.sent':'📨 Aannamebericht verstuurd','application.interview':'🗣️ Sollicitatiegesprek gestart','promotion.propose':'📈 Promotie voorgesteld','promotion.rejected':'❌ Promotie afgekeurd',
  'absence.exemption':'🌴 Vrijstelling gegeven','absence.exemption.revoke':'Vrijstelling ingetrokken','planning.absence.approved':'✅ Planningafmelding geregistreerd',
  'activitycheck.reconcile':'✅ Check-in-reacties hersteld','activitycheck.unavailable':'⚠️ Activiteitencheck niet beschikbaar','gangpot.remove':'💰 Betaling verwijderd','gangpot.void':'💰 Gangpotregistratie gecorrigeerd','gangpot.period.settings':'⚙️ Weekbijdrage aangepast','gangpot.schedule.migrate':'💰 Gangpottermijn bijgewerkt','warn.restore':'⚠️ Gangwarn hersteld',
  'case.create':'🎫 Ticket aangemaakt','case.open':'🎫 Ticket geopend','case.accepted':'✅ Sollicitatie aangenomen','case.rejected':'❌ Sollicitatie afgewezen','case.closed':'🔒 Ticket gesloten',
  'monthly.sent':'📊 Maandoverzicht verstuurd','weekly.sent':'📊 Weekoverzicht verstuurd','absence.exemption.recover':'✅ Bestaande afwezigheidsvrijstelling hersteld',
  'warn.appeal.submit':'📝 Bezwaar ingediend','warn.appeal.approved':'✅ Bezwaar goedgekeurd','warn.appeal.rejected':'❌ Bezwaar afgewezen','warn.appeal.cancelled':'✅ Bezwaar gesloten',
  'rank.change':'👑 Gangrang gewijzigd','probation.review_due':'🗓️ Proefperiode klaar voor beoordeling','probation.passed':'✅ Proefperiode geslaagd','probation.extended':'🕒 Proefperiode verlengd','probation.followup':'🟠 Proefperiode: opvolging nodig',
  'application.queued':'⏳ Sollicitant in wachtrij geplaatst','application.queue_dm_sent':'📨 Wachtrijbericht verstuurd','application.queue_dm_failed':'⚠️ Wachtrijbericht niet bezorgd','application.queue_retry_failed':'⚠️ Wachtrijherstel mislukt','application.queue_ticket_notice':'📨 Wachtrijbericht in ticket geplaatst'
};
const labels={week:'Week vanaf',month:'Maand',request:'Afmelding',source:'Bron',id:'Registratie',name:'Naam',interaction:'Interactie',action:'Uitgevoerde actie',route:'Uitgevoerd',error:'Foutcode',amount:'Bedrag',period:'Termijn',version:'Versie',role:'Rang',roleId:'Rang',member:'Lid',memberId:'Lid',user:'Lid',channel:'Kanaal',message:'Bericht',case:'Dossier',caseId:'Dossier',activity:'Planning',kind:'Soort',response:'Reactie',added:'Rang erbij',removed:'Rang eraf',approvers:'Goedgekeurd door',nicknameChanged:'Bijnaam gewijzigd',nameChanged:'Naam gewijzigd',permissionsChanged:'Rechten gewijzigd',files:'Bestanden',deadline:'Deadline',members:'Aantal leden',restored:'Hersteld',count:'Aantal',minutes:'Time-out (minuten)',incident:'Overtreding',urls:'Links',everyone:'Massatag',joins:'Nieuwe leden',windowSeconds:'Tijdvenster (seconden)',target:'Doel',notice:'Melding',status:'Status',permissions:'Ontbrekende botrechten',raidEnabled:'Raidcontrole',channels:'Kanalen',until:'Beschermmodus tot'};
function detailValue(key,value){
  if(value===null||value===undefined||value==='')return null;
  if(typeof value==='boolean')return value?'Ja':'Nee';
  if(Array.isArray(value))return value.map(item=>typeof item==='object'?'':key==='added'||key==='removed'?`<@&${item}>`:key==='approvers'?`<@${item}>`:key==='channels'?`<#${item}>`:String(item)).filter(Boolean).join(', ')||null;
  if(typeof value==='object')return null;
  if(['user','member','memberId'].includes(key)&&/^\d{17,20}$/.test(String(value)))return`<@${value}>`;
  if(key==='channel')return`<#${value}>`;
  if(['role','roleId'].includes(key)&&/^\d{17,20}$/.test(String(value)))return`<@&${value}>`;
  if(['deadline','until'].includes(key)&&typeof value==='number')return`<t:${Math.floor(value/1000)}:F>`;
  return safeText(String(value));
}
export function auditPresentation(item,snapshot=null){
  const details=cleanAudit(typeof item.details==='string'?JSON.parse(item.details):item.details||{}),message=item.event.startsWith('message.');
  const result={title:names[item.event]||item.event.split('.').map(word=>word.replaceAll('_',' ')).join(' · '),color:item.event.endsWith('.failed')||item.event.endsWith('_failed')||item.event==='security.unavailable'?0xEF4444:message?0xF59E0B:0x22C55E,fields:[],sections:[]};
  if(details.type==='command'&&item.event.startsWith('interaction.'))result.title=item.event.endsWith('.failed')?'❌ Command mislukt':'✅ Command uitgevoerd';
  if(message){
    result.fields.push({name:'Auteur',value:snapshot?.authorId?`<@${snapshot.authorId}> · ${safeText(snapshot.authorName)}`:details.user?`<@${details.user}>`:'Onbekend (bericht niet in cache)'});
    if(details.channel)result.fields.push({name:'Kanaal',value:`<#${details.channel}>`});
    if(details.message)result.fields.push({name:'Bericht-ID',value:String(details.message)});
    if(snapshot?.sentAt)result.fields.push({name:'Verstuurd',value:`<t:${Math.floor(snapshot.sentAt/1000)}:F>`});
    const sections=item.event==='message.edit'?[['Voor wijziging',snapshot?.before],['Na wijziging',snapshot?.after]]:[['Verwijderd bericht',snapshot?.after]];
    for(const [label,part] of sections){
      result.sections.push({label,text:part?.available?(part.text||'(Dit bericht bevatte geen tekst.)'):'De inhoud is niet beschikbaar: het bericht stond niet in de cache van de bot.'});
      for(const attachment of part?.attachments||[])result.fields.push({name:'Bijlage',value:attachment.url?`[${safeText(attachment.name)}](${attachment.url})`:safeText(attachment.name)});
    }
    return result;
  }
  if(item.actor_id)result.fields.push({name:'Door',value:`<@${item.actor_id}>`});
  for(const [key,value] of Object.entries(details)){if(!labels[key]||key==='interaction'||value==='[afgeschermd]')continue;const rendered=detailValue(key,value);if(rendered)result.fields.push({name:labels[key],value:rendered.slice(0,1000)});}
  if(!result.fields.length)result.fields.push({name:'Uitgevoerd door',value:'Bakarov / Discord'});
  return result;
}
const length=card=>{const data=card.toJSON();return(data.title?.length||0)+(data.description?.length||0)+(data.footer?.text?.length||0)+(data.fields||[]).reduce((n,item)=>n+item.name.length+item.value.length,0);};
export function auditPayloads(ctx,rows,jobId){
  const cards=[];
  for(const item of rows){
    const saved=ctx.store.db.prepare('SELECT snapshot FROM message_audit WHERE audit_id=?').get(item.id),presentation=auditPresentation(item,saved?JSON.parse(saved.snapshot):null);
    const make=continuation=>embed(ctx.config,presentation.title+(continuation?' (vervolg)':''),`<t:${Math.floor(item.created_at/1000)}:F>`).setColor(presentation.color).setTimestamp(item.created_at);
    let card=make(false);
    const append=(name,value)=>{if(length(card)+name.length+value.length>4900||(card.data.fields?.length||0)>=25){cards.push(card);card=make(true);}card.addFields({name,value});};
    for(const field of presentation.fields)append(field.name,field.value||'—');
    for(const section of presentation.sections){const text=section.text.replaceAll('`','`\u200b');for(let start=0;start<text.length;start+=990)append(section.label+(start?' (vervolg)':''),'```\n'+text.slice(start,start+990)+'\n```');}
    cards.push(card);
  }
  const groups=[];let group=[],size=0;
  for(const card of cards){if(group.length&&(group.length===10||size+length(card)+100>5800)){groups.push(group);group=[];size=0;}group.push(card);size+=length(card)+100;}
  if(group.length)groups.push(group);
  return groups.map((items,index)=>({embeds:items.map(card=>card.setFooter({text:`Bakarov • Log ${jobId} • ${index+1}/${groups.length}`}).toJSON())}));
}
export function dashboardAuditItem(ctx,guild,item){
  const saved=ctx.store.db.prepare('SELECT snapshot FROM message_audit WHERE audit_id=?').get(item.id),presentation=auditPresentation(item,saved?JSON.parse(saved.snapshot):null);
  const readable=text=>text.replace(/<@&(\d+)>/g,(_,id)=>'@'+(guild.roles.cache.get(id)?.name||id)).replace(/<@!?(\d+)>/g,(_,id)=>'@'+(guild.members.cache.get(id)?.displayName||id)).replace(/<#(\d+)>/g,(_,id)=>'#'+(guild.channels.cache.get(id)?.name||id));
  return{...item,actor_name:item.actor_id?guild.members.cache.get(item.actor_id)?.displayName||item.actor_id:'Systeem',details:cleanAudit(JSON.parse(item.details)),presentation:{...presentation,fields:presentation.fields.map(field=>({...field,value:readable(field.value)}))}};
}
