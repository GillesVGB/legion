import {exemptionRemovalTime} from './gangpot-policy.mjs';
import {PermissionFlagsBits as P} from 'discord.js';
import {missionDay} from './mission-definitions.mjs';
import {embed} from './ui.mjs';
import {warnLogChannel,quiet} from './service.mjs';
import {queueFeatureNotice,deliverFeatureNotices} from './notices.mjs';
import {serializeCommunity} from './community-posts.mjs';
import {assertUser} from './errors.mjs';

function approvalTime(db,item){
  if(Number.isSafeInteger(item.reviewed_at))return item.reviewed_at;
  // Older records can lack reviewed_at; an actual approval audit is evidence, creation alone is not.
  return db.prepare("SELECT MIN(created_at) AS at FROM audit WHERE event='absence.approve' AND json_valid(details) AND json_extract(details,'$.id')=?").get(item.id)?.at??null;
}
const covers=(item,date)=>item.kind==='range'&&item.start_date<=date&&item.end_date>=date;
function coversWeek(item,period){
  let weeks;try{weeks=JSON.parse(item.weeks);}catch{return false;}
  if(!Array.isArray(weeks))return false;
  return weeks.length?weeks.includes(period.id):item.start_date<=missionDay(period.ends_at-1)&&item.end_date>=missionDay(period.starts_at);
}
export function repairApprovedAbsenceWarnings(ctx,guild,now=Date.now()){
  if(ctx.config.guildId!=='1555685630640652338')return[];
  assertUser(guild.id===ctx.config.guildId,'Deze warncorrectie hoort bij een andere server.');
  const db=ctx.store.db,actor=guild.members.me.id;
  return ctx.store.transaction(()=>{
    const approved=db.prepare("SELECT * FROM absence_requests WHERE status='approved'").all().map(item=>({...item,approvedAt:approvalTime(db,item)})).filter(item=>item.approvedAt!==null&&item.approvedAt>=item.created_at&&item.approvedAt<=now);
    const corrected=[];
    const remove=(warning,request,source)=>{
      const reason=`Automatische ${source==='gangpot'?'gangpotwarn':source==='planning'?'planningwarn':'check-in-warn'} ingetrokken: de bijbehorende afwezigheid was al vóór deze warn goedgekeurd.`;
      db.prepare('UPDATE warnings SET removed_at=?,removed_by=?,removed_reason=? WHERE id=? AND removed_at IS NULL').run(now,actor,reason,warning.id);
      db.prepare('INSERT INTO absence_warn_corrections(warn_id,user_id,request_id,source,corrected_at) VALUES(?,?,?,?,?)').run(warning.id,warning.user_id,request?.id||null,source,now);
      ctx.store.audit('warn.remove',actor,{id:warning.id,user:warning.user_id,reason,request:request?.id||null,source});
      const payload={embeds:[embed(ctx.config,'Bakarov — Gangwarn ingetrokken',`${reason}\n\n**Lid:** <@${warning.user_id}>\n**Warn-ID:** \`${warning.id}\`\n**Actieve gangwarns:** ${ctx.store.warnCount(warning.user_id)}\nDe oorspronkelijke warn blijft als ingetrokken in de historie staan.`).setColor(0x22C55E)]};
      queueFeatureNotice(ctx,{key:`absence.warn.corrected:${warning.id}`,kind:'absence.warn.corrected',user:warning.user_id,payload,now});
      corrected.push(warning.id);
    };
    const checks=db.prepare(`SELECT w.*,c.id AS check_id,c.deadline_at,a.id AS planning_id,a.starts_at FROM activity_check_warnings cw
      JOIN warnings w ON w.id=cw.warn_id AND w.user_id=cw.user_id
      LEFT JOIN activity_check_sessions c ON c.id=cw.activity_id LEFT JOIN activities a ON a.id=cw.activity_id
      WHERE w.removed_at IS NULL AND w.actor_id=? AND NOT EXISTS(SELECT 1 FROM absence_warn_corrections x WHERE x.warn_id=w.id)`).all(actor);
    for(const warning of checks){
      const at=warning.check_id?warning.deadline_at:warning.starts_at;if(!Number.isSafeInteger(at))continue;
      const date=missionDay(at),request=approved.find(item=>item.user_id===warning.user_id&&item.approvedAt<=warning.created_at&&(covers(item,date)||(!warning.check_id&&item.kind==='planning'&&item.activity_id===warning.planning_id)));
      if(!request)continue;
      remove(warning,request,warning.check_id?'checkin':'planning');
      if(warning.check_id){db.prepare("UPDATE activity_check_members SET status='exempt' WHERE check_id=? AND user_id=? AND warn_id=?").run(warning.check_id,warning.user_id,warning.id);db.prepare('UPDATE activity_check_sessions SET dirty=1,next_attempt=0 WHERE id=?').run(warning.check_id);}
    }
    const debts=db.prepare(`SELECT w.*,d.period_id,p.starts_at,p.ends_at FROM gangpot_dues d JOIN warnings w ON w.id=d.warn_id AND w.user_id=d.user_id
      JOIN gangpot_periods p ON p.id=d.period_id WHERE w.removed_at IS NULL AND w.actor_id=?
      AND NOT EXISTS(SELECT 1 FROM absence_warn_corrections x WHERE x.warn_id=w.id)`).all(actor);
    for(const warning of debts){
      if(warning.ends_at>exemptionRemovalTime(ctx))continue;
      const exemption=db.prepare('SELECT * FROM gangpot_exemptions WHERE user_id=? AND period_id=? AND revoked_at IS NULL').get(warning.user_id,warning.period_id);
      if(!exemption||exemption.created_at>warning.created_at)continue;
      const request=approved.find(item=>item.id===exemption.request_id&&item.approvedAt<=warning.created_at);
      if(exemption.request_id&&!request)continue;
      remove(warning,request,'gangpot');db.prepare('UPDATE gangpot_dues SET warn_cleared_by_payment=1 WHERE period_id=? AND user_id=?').run(warning.period_id,warning.user_id);
      // Do not deliver an old red warning after its green correction.
      db.prepare("UPDATE gangpot_notifications SET log_id=COALESCE(log_id,'skipped'),dm_id=COALESCE(dm_id,'skipped'),last_error=NULL WHERE warn_id=? AND kind IN ('issue','restore')").run(warning.id);
    }
    return corrected;
  });
}
export async function syncAbsenceCorrections(ctx,guild,now=Date.now()){
  if(ctx.config.guildId!=='1555685630640652338')return;
  return serializeCommunity(`${guild.id}:absence-warn-corrections`,async()=>{
    const corrected=repairApprovedAbsenceWarnings(ctx,guild,now);
    for(const item of ctx.store.db.prepare('SELECT * FROM absence_warn_corrections WHERE log_id IS NULL AND next_attempt<=? LIMIT 20').all(now)){
      try{
        const channel=await warnLogChannel(guild,ctx.config),marker=`Bakarov • Warncorrectie ${item.warn_id}`;
        let message;if(channel.permissionsFor(guild.members.me)?.has(P.ReadMessageHistory)){const history=await channel.messages.fetch({limit:100});message=[...history.values()].find(post=>post.author.id===guild.members.me.id&&post.embeds?.some(card=>card.footer?.text===marker));}
        message??=await channel.send({embeds:[embed(ctx.config,'Bakarov — Gangwarn ingetrokken',`**Lid:** <@${item.user_id}>\n**Warn-ID:** \`${item.warn_id}\`\n**Soort:** ${item.source==='gangpot'?'Gangpot':item.source==='planning'?'Planning':'Activiteitencheck'}\n**Reden:** de bijbehorende afwezigheid was al goedgekeurd voordat de automatische warn werd gegeven.\n**Actieve gangwarns:** ${ctx.store.warnCount(item.user_id)}\n\nDe warn is ingetrokken en blijft in de historie bewaard.`).setColor(0x22C55E).setFooter({text:marker})],nonce:`wc:${item.warn_id}`,enforceNonce:true,allowedMentions:quiet});
        ctx.store.db.prepare('UPDATE absence_warn_corrections SET log_id=?,last_error=NULL WHERE warn_id=?').run(message.id,item.warn_id);
      }catch(error){ctx.store.db.prepare('UPDATE absence_warn_corrections SET next_attempt=?,last_error=? WHERE warn_id=?').run(now+60000,String(error.code||error.name),item.warn_id);}
    }
    await deliverFeatureNotices(ctx,guild,now,item=>Boolean(ctx.store.db.prepare('SELECT 1 FROM warnings WHERE id=? AND removed_at IS NOT NULL').get(item.notice_key.slice('absence.warn.corrected:'.length))),['absence.warn.corrected']);
    return corrected;
  });
}
