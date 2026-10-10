import {embed} from './ui.mjs';
import {gangpotMembers,gangpotMoney,gangpotEligible} from './gangpot.mjs';
import {planningTime} from './activities.mjs';
import {missionDay} from './mission-definitions.mjs';
import {operationSettings} from './feature-settings.mjs';
import {queueFeatureNotice,deliverFeatureNotices} from './notices.mjs';
const shift=(date,days)=>missionDay(Date.parse(date+'T12:00:00Z')+days*86400000);
export async function syncGangpotReminders(ctx,guild,now=Date.now()){
  const period=ctx.store.db.prepare('SELECT * FROM gangpot_periods WHERE starts_at<=? AND ends_at>? ORDER BY starts_at DESC LIMIT 1').get(now,now);if(!period)return;
  const settings=operationSettings(ctx).gangpot,day=missionDay(now),members=gangpotMembers(ctx,period,now);
  const shouldSend=(date,time)=>day===date&&now>=planningTime(date,time,now)&&now<period.ends_at;
  if(settings.remindersEnabled)for(const [slot,date,time] of [['friday',shift(period.id,-1),settings.fridayTime],['saturday',period.id,settings.saturdayTime]]){
    if(!shouldSend(date,time))continue;
    for(const member of members.filter(item=>item.active&&!item.exempt&&item.onTime<period.weekly_amount))queueFeatureNotice(ctx,{key:`gangpot:${period.id}:${slot}:${member.user_id}`,kind:'gangpot.member',user:member.user_id,period:period.id,now,payload:{embeds:[embed(ctx.config,'Legion — Gangpotherinnering',`Je bijdrage voor de week t/m **${period.id}** heeft nog geen volledige Lead-goedkeuring.\n**Nog open:** ${gangpotMoney(member.remaining)}\n**Deadline:** <t:${Math.floor((period.ends_at-60000)/1000)}:F>\n\nBetaal in-game, gebruik /gangpot betaling en zorg dat Lead op tijd het vinkje zet. Een melding die nog op controle wacht geeft geen uitstel.`).setColor(0xF59E0B)]}});
  }
  if(settings.leadReminderEnabled&&shouldSend(period.id,settings.leadTime)){
    const pending=ctx.store.db.prepare("SELECT * FROM gangpot_claims WHERE period_id=? AND status='pending' AND withdrawn_at IS NULL ORDER BY reported_at").all(period.id).filter(item=>gangpotEligible(ctx,guild.members.cache.get(item.user_id))&&!members.find(member=>member.user_id===item.user_id)?.exempt);
    const lines=pending.slice(0,18).map(item=>`• <@${item.user_id}> · ${gangpotMoney(item.amount)}${item.message_id?` · [Controleer melding](https://discord.com/channels/${guild.id}/${ctx.config.gangpot.paymentsChannelId}/${item.message_id})`:''}`);
    queueFeatureNotice(ctx,{key:`gangpot:${period.id}:lead`,kind:'gangpot.lead',period:period.id,now,payload:{embeds:[embed(ctx.config,'Legion — Betalingen wachten op Lead',`**Termijn:** ${period.id}\n**Deadline:** <t:${Math.floor((period.ends_at-60000)/1000)}:F>\n**Open meldingen:** ${pending.length}\n\n${lines.join('\n')||'Geen betalingen die nog op controle wachten.'}\n\nControleer de ontvangen bedragen en keur ze vóór de deadline goed. Vrijgestelde leden ontvangen geen betaalherinnering.`).setColor(0xF59E0B)]}});
  }
  await deliverFeatureNotices(ctx,guild,now,item=>{
    if(!item.kind.startsWith('gangpot.'))return null;
    if(item.period_id!==period.id||now>=period.ends_at)return false;
    if(item.kind==='gangpot.lead')return settings.leadReminderEnabled;
    const slot=item.notice_key.split(':')[2];if(slot==='friday'&&day!==shift(period.id,-1))return false;if(slot==='saturday'&&day!==period.id)return false;
    const member=members.find(member=>member.user_id===item.user_id);
    return Boolean(settings.remindersEnabled&&gangpotEligible(ctx,guild.members.cache.get(item.user_id))&&member&&!member.exempt&&member.onTime<period.weekly_amount);
  },['gangpot.member','gangpot.lead']);
}
