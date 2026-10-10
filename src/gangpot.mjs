import {randomBytes} from 'node:crypto';
import {MessageFlags,ButtonStyle,PermissionFlagsBits as P} from 'discord.js';
import {assertUser} from './errors.mjs';
import {embed,row,button,safeText} from './ui.mjs';
import {quiet,requireStaff} from './service.mjs';
import {warnLogChannel} from './service.mjs';
import {communityChannel,serializeCommunity,updateCommunityPost} from './community-posts.mjs';
import {refreshMembers} from './members.mjs';
import {planningTime} from './activities.mjs';
import {missionDay} from './mission-definitions.mjs';

const uid=()=>randomBytes(6).toString('hex');
export const GANGPOT_LEAD_ROLE_ID='1555685630707769382';
export const gangpotMoney=amount=>`$${Number(amount).toLocaleString('nl-BE')}`;
export function requireGangPot(ctx){assertUser(ctx.config.guildId==='1555685630640652338'&&ctx.config.gangpot,'De gangpot wordt alleen in de Legion-hoofdserver beheerd.');}
const dayShift=(date,days)=>{const [y,m,d]=date.split('-').map(Number),value=new Date(Date.UTC(y,m-1,d+days,12));return`${value.getUTCFullYear()}-${String(value.getUTCMonth()+1).padStart(2,'0')}-${String(value.getUTCDate()).padStart(2,'0')}`;};
const weekdayOf=date=>{const [y,m,d]=date.split('-').map(Number);return new Date(Date.UTC(y,m-1,d,12)).getUTCDay();};
export const gangpotEligible=(ctx,member)=>Boolean(member&&!member.user.bot&&member.roles.cache.has(ctx.config.gangpot.memberRoleId));
export function gangpotWindow(config,now=Date.now()){
  const today=missionDay(now);if(today<config.startsOn)return null;
  const firstDeadline=dayShift(config.startsOn,((6-weekdayOf(config.startsOn)+7)%7)||7);
  const deadline=today<=firstDeadline?firstDeadline:dayShift(today,(6-weekdayOf(today)+7)%7);
  const sunday=dayShift(deadline,1),starts=deadline===firstDeadline?config.startsOn:dayShift(sunday,-7);
  return{id:deadline,starts_at:planningTime(starts,'00:00',now),ends_at:planningTime(sunday,'00:00',now),weekly_amount:config.weeklyAmount};
}
const currentPeriod=(ctx,now=Date.now())=>ctx.store.db.prepare('SELECT * FROM gangpot_periods WHERE starts_at<=? AND ends_at>? ORDER BY starts_at DESC LIMIT 1').get(now,now);
const periodById=(ctx,id)=>ctx.store.db.prepare('SELECT * FROM gangpot_periods WHERE id=?').get(id);
export function gangpotBalance(ctx){return Number(ctx.store.db.prepare("SELECT COALESCE(SUM(CASE WHEN kind='expense' THEN -amount ELSE amount END),0) AS balance FROM gangpot_entries WHERE voided_at IS NULL").get().balance);}
export function gangpotPaid(ctx,period,user){return ctx.store.db.prepare("SELECT COALESCE(SUM(amount),0) AS total,COALESCE(SUM(CASE WHEN paid_at<? THEN amount ELSE 0 END),0) AS on_time FROM gangpot_entries WHERE kind='payment' AND period_id=? AND user_id=? AND voided_at IS NULL").get(period.ends_at,period.id,user);}
export function gangpotMembers(ctx,period,now=Date.now()){
  if(!period)return[];
  return ctx.store.db.prepare('SELECT * FROM gangpot_dues WHERE period_id=? ORDER BY user_id').all(period.id).map(item=>{
    const paid=gangpotPaid(ctx,period,item.user_id),warning=item.warn_id?ctx.store.db.prepare('SELECT removed_at FROM warnings WHERE id=?').get(item.warn_id):null;
    const status=!item.active?'left':paid.on_time>=period.weekly_amount?'paid':warning&&warning.removed_at===null?'warned':paid.total>=period.weekly_amount?'late':paid.total?'partial':'unpaid';
    return{...item,paid:paid.total,onTime:paid.on_time,remaining:Math.max(0,period.weekly_amount-paid.total),status,overdue:now>=period.ends_at};
  });
}
function migrateOpenTerms(ctx,guild,now){
  const old=ctx.store.db.prepare("SELECT * FROM gangpot_periods WHERE status='open'").all().filter(period=>weekdayOf(period.id)===0);
  if(!old.length)return;
  ctx.store.transaction(()=>{
    for(const period of old){
      const window=gangpotWindow(ctx.config.gangpot,Math.max(period.starts_at,planningTime(ctx.config.gangpot.startsOn,'00:00',now)));
      ctx.store.db.prepare('INSERT OR IGNORE INTO gangpot_periods(id,starts_at,ends_at,weekly_amount) VALUES(?,?,?,?)').run(window.id,window.starts_at,window.ends_at,period.weekly_amount);
      for(const due of ctx.store.db.prepare('SELECT * FROM gangpot_dues WHERE period_id=?').all(period.id)){
        ctx.store.db.prepare(`INSERT INTO gangpot_dues(period_id,user_id,enrolled_at,active,warn_id,warn_cleared_by_payment) VALUES(?,?,?,?,?,?)
          ON CONFLICT(period_id,user_id) DO UPDATE SET enrolled_at=MIN(gangpot_dues.enrolled_at,excluded.enrolled_at),
          active=MAX(gangpot_dues.active,excluded.active),warn_id=COALESCE(gangpot_dues.warn_id,excluded.warn_id)`).run(window.id,due.user_id,due.enrolled_at,gangpotEligible(ctx,guild.members.cache.get(due.user_id))?due.active:0,due.warn_id,due.warn_cleared_by_payment);
      }
      // Eventuele twee open meldingen uit samengevoegde oude termijnen houden hun historie.
      for(const claim of ctx.store.db.prepare("SELECT * FROM gangpot_claims WHERE period_id=? AND status='pending'").all(period.id)){
        if(ctx.store.db.prepare("SELECT 1 FROM gangpot_claims WHERE period_id=? AND user_id=? AND status='pending'").get(window.id,claim.user_id)){
          ctx.store.db.prepare("UPDATE gangpot_claims SET status='rejected',reviewer_id=?,reviewed_at=?,note=?,dirty=1,next_attempt=0 WHERE id=?").run(guild.members.me.id,now,`${claim.note}\nDubbele open melding na het omzetten van de weektermijn; gebruik je andere melding.`.slice(0,500),claim.id);
        }
      }
      ctx.store.db.prepare('UPDATE gangpot_entries SET period_id=? WHERE period_id=?').run(window.id,period.id);
      ctx.store.db.prepare('UPDATE gangpot_claims SET period_id=?,dirty=1,next_attempt=0 WHERE period_id=?').run(window.id,period.id);
      ctx.store.db.prepare('UPDATE gangpot_notifications SET period_id=? WHERE period_id=?').run(window.id,period.id);
      ctx.store.db.prepare('DELETE FROM gangpot_dues WHERE period_id=?').run(period.id);
      ctx.store.db.prepare('DELETE FROM gangpot_periods WHERE id=?').run(period.id);
      ctx.store.audit('gangpot.schedule.migrate',guild.members.me.id,{from:period.id,to:window.id});
    }
  });
}
function ensurePeriod(ctx,guild,now){
  const window=gangpotWindow(ctx.config.gangpot,now);if(!window)return null;
  ctx.store.transaction(()=>{
    ctx.store.db.prepare('INSERT OR IGNORE INTO gangpot_periods(id,starts_at,ends_at,weekly_amount) VALUES(?,?,?,?)').run(window.id,window.starts_at,window.ends_at,window.weekly_amount);
    const humans=[...guild.members.cache.values()].filter(member=>gangpotEligible(ctx,member)),present=new Set(humans.map(member=>member.id));
    for(const member of humans)ctx.store.db.prepare('INSERT INTO gangpot_dues(period_id,user_id,enrolled_at) VALUES(?,?,?) ON CONFLICT(period_id,user_id) DO UPDATE SET active=1').run(window.id,member.id,now);
    for(const item of ctx.store.db.prepare('SELECT user_id FROM gangpot_dues WHERE period_id=? AND active=1').all(window.id))if(!present.has(item.user_id))ctx.store.db.prepare('UPDATE gangpot_dues SET active=0 WHERE period_id=? AND user_id=?').run(window.id,item.user_id);
  });
  return periodById(ctx,window.id);
}
function queueNotice(ctx,user,period,warn,kind,message){ctx.store.db.prepare('INSERT INTO gangpot_notifications(id,user_id,period_id,warn_id,kind,message) VALUES(?,?,?,?,?,?)').run(uid(),user,period.id,warn,kind,message);}
function reconcileDebt(ctx,period,user,actor,now){
  const debt=ctx.store.db.prepare('SELECT * FROM gangpot_dues WHERE period_id=? AND user_id=?').get(period.id,user);if(!debt)return;
  const paid=gangpotPaid(ctx,period,user);
  const warning=debt.warn_id?ctx.store.db.prepare('SELECT * FROM warnings WHERE id=?').get(debt.warn_id):null;
  if(paid.on_time>=period.weekly_amount){
    if(warning&&warning.removed_at===null){
      const reason=`Gangpot ${period.id}: tijdige betaling bevestigd door de leiding.`;
      ctx.store.db.prepare('UPDATE warnings SET removed_at=?,removed_by=?,removed_reason=? WHERE id=?').run(now,actor,reason,warning.id);
      ctx.store.db.prepare('UPDATE gangpot_dues SET warn_cleared_by_payment=1 WHERE period_id=? AND user_id=?').run(period.id,user);
      ctx.store.audit('warn.remove',actor,{id:warning.id,user,reason});
      queueNotice(ctx,user,period,warning.id,'revoke',`De gangpotwarn voor de termijn tot ${period.id} is ingetrokken: je betaling is als tijdig bevestigd.`);
    }
    return;
  }
  if(now<period.ends_at||!debt.active)return;
  if(warning){
    if(warning.removed_at!==null&&debt.warn_cleared_by_payment){
      ctx.store.db.prepare('UPDATE warnings SET removed_at=NULL,removed_by=NULL,removed_reason=NULL WHERE id=?').run(warning.id);
      ctx.store.db.prepare('UPDATE gangpot_dues SET warn_cleared_by_payment=0 WHERE period_id=? AND user_id=?').run(period.id,user);
      ctx.store.audit('warn.restore',actor,{id:warning.id,user,period:period.id});
      queueNotice(ctx,user,period,warning.id,'restore',`De betaling voor termijn ${period.id} is gecorrigeerd. De oorspronkelijke gangpotwarn is hersteld.`);
    }
    return; // Ook een handmatig ingetrokken warn wordt niet opnieuw aangemaakt.
  }
  const reason=`Gangpot t/m ${period.id}: geen volledige betaling met Lead-vinkje vóór de deadline. Weekbijdrage ${gangpotMoney(period.weekly_amount)}; tijdig goedgekeurd ${gangpotMoney(paid.on_time)}; tekort ${gangpotMoney(period.weekly_amount-paid.on_time)}. Deadline zaterdag 23:59, Belgische tijd.`;
  const result=ctx.store.addWarnInside(user,actor,reason,now);
  ctx.store.db.prepare('UPDATE gangpot_dues SET warn_id=?,warn_cleared_by_payment=0 WHERE period_id=? AND user_id=?').run(result.id,period.id,user);
  queueNotice(ctx,user,period,result.id,'issue',`Je hebt een automatische gangwarn ontvangen. ${reason}`);
}
function enforcePeriods(ctx,guild,now){
  ctx.store.transaction(()=>{
    for(const period of ctx.store.db.prepare('SELECT * FROM gangpot_periods WHERE ends_at<=?').all(now)){
      for(const debt of ctx.store.db.prepare('SELECT * FROM gangpot_dues WHERE period_id=? AND active=1').all(period.id)){
        const member=guild.members.cache.get(debt.user_id);
        if(!gangpotEligible(ctx,member)){ctx.store.db.prepare('UPDATE gangpot_dues SET active=0 WHERE period_id=? AND user_id=?').run(period.id,debt.user_id);continue;}
        reconcileDebt(ctx,period,debt.user_id,guild.members.me.id,now);
      }
      ctx.store.db.prepare("UPDATE gangpot_periods SET status='closed' WHERE id=?").run(period.id);
    }
  });
}
export function gangpotPeriodId(value){
  const timestamp=planningTime(String(value).trim(),'23:59'),date=missionDay(timestamp),[y,m,d]=date.split('-').map(Number);
  assertUser(new Date(Date.UTC(y,m-1,d,12)).getUTCDay()===6,'Vul de zaterdag van de gewenste termijn in, bijvoorbeeld 17-10-2026.');
  return date;
}
export function recordGangpotEntry(ctx,input,now=Date.now()){
  requireGangPot(ctx);
  assertUser(['payment','donation','expense'].includes(input.kind)&&Number.isSafeInteger(input.amount)&&input.amount>0&&input.amount<=100000000,'Gebruik een geldig positief bedrag van maximaal 100 miljoen in-game dollars.');
  assertUser(typeof input.requestId==='string'&&input.requestId.length>=8&&input.requestId.length<=100,'Ongeldige betalingsregistratie.');
  return ctx.store.transaction(()=>recordEntryInside(ctx,input,now));
}
function recordEntryInside(ctx,input,now){
    const existing=ctx.store.db.prepare('SELECT * FROM gangpot_entries WHERE request_id=?').get(input.requestId);
    if(existing){assertUser(existing.actor_id===input.actor&&existing.kind===input.kind&&existing.amount===input.amount&&existing.user_id===(input.userId||null)&&existing.period_id===(input.periodId||null),'Deze registratie is al gebruikt voor een andere transactie.');return existing;}
    const note=String(input.note||'').trim();assertUser(note.length<=500,'Gebruik een notitie van maximaal 500 tekens.');
    const paidAt=input.paidAt??now;assertUser(Number.isSafeInteger(paidAt)&&paidAt<=now,'Een bevestigde betaling kan niet in de toekomst liggen.');
    let period;
    if(input.kind==='payment'){
      period=periodById(ctx,input.periodId);assertUser(period,'Deze termijn bestaat nog niet. Gebruik de huidige termijn of een zaterdag uit het overzicht.');
      assertUser(ctx.store.db.prepare('SELECT 1 FROM gangpot_dues WHERE period_id=? AND user_id=?').get(period.id,input.userId),'Dit lid staat niet in het betaaloverzicht van deze termijn.');
      assertUser(paidAt>=period.starts_at,'De opgegeven betaaldatum ligt vóór deze termijn.');
      const remaining=period.weekly_amount-gangpotPaid(ctx,period,input.userId).total;
      assertUser(input.amount<=remaining,remaining<=0?'Deze weekbijdrage is al volledig bevestigd.':`Er staat nog ${gangpotMoney(remaining)} open. Registreer extra steun als donatie.`);
    }
    if(input.kind==='expense')assertUser(input.amount<=gangpotBalance(ctx),'Deze uitgave is groter dan het geregistreerde gangpotsaldo.');
    const id=uid();ctx.store.db.prepare('INSERT INTO gangpot_entries(id,request_id,kind,user_id,period_id,amount,actor_id,paid_at,created_at,note) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,input.requestId,input.kind,input.userId||null,input.periodId||null,input.amount,input.actor,paidAt,now,note);
    ctx.store.audit(`gangpot.${input.kind}`,input.actor,{id,user:input.userId,period:input.periodId,amount:input.amount,note});
    if(period)reconcileDebt(ctx,period,input.userId,input.actor,now);
    ctx.store.setSetting('gangpot:dirty','1');
    return ctx.store.db.prepare('SELECT * FROM gangpot_entries WHERE id=?').get(id);
}
export function voidGangpotEntry(ctx,id,actor,reason,now=Date.now()){
  requireGangPot(ctx);assertUser(typeof reason==='string'&&reason.trim()&&reason.length<=500,'Vul een reden van maximaal 500 tekens in.');
  return ctx.store.transaction(()=>{
    const entry=ctx.store.db.prepare('SELECT * FROM gangpot_entries WHERE id=?').get(id);assertUser(entry&&!entry.voided_at,'Deze registratie bestaat niet of is al gecorrigeerd.');
    assertUser(entry.kind==='expense'||gangpotBalance(ctx)>=entry.amount,'Corrigeer eerst de bijbehorende uitgaven, zodat het saldo niet negatief wordt.');
    ctx.store.db.prepare('UPDATE gangpot_entries SET voided_at=?,voided_by=?,void_reason=? WHERE id=?').run(now,actor,reason.trim(),id);
    ctx.store.db.prepare('UPDATE gangpot_claims SET withdrawn_at=?,withdrawn_by=?,withdraw_reason=?,dirty=1,next_attempt=0 WHERE payment_id=? AND withdrawn_at IS NULL').run(now,actor,reason.trim(),id);
    ctx.store.audit('gangpot.void',actor,{id,reason:reason.trim()});
    if(entry.period_id)reconcileDebt(ctx,periodById(ctx,entry.period_id),entry.user_id,actor,now);
    ctx.store.setSetting('gangpot:dirty','1');return entry;
  });
}
export function removeGangpotPayment(ctx,input,now=Date.now()){
  requireGangPot(ctx);
  assertUser(/^\d{17,20}$/.test(input.userId),'Kies een geldige gebruiker.');
  assertUser(typeof input.requestId==='string'&&input.requestId.length>=8&&input.requestId.length<=100,'Ongeldig verwijderverzoek.');
  const reason=String(input.reason||'Betaling verwijderd via /gangpot betaling-verwijderen.').trim();
  assertUser(reason&&reason.length<=500,'Gebruik een reden van maximaal 500 tekens.');
  return ctx.store.transaction(()=>{
    const existing=ctx.store.db.prepare('SELECT * FROM gangpot_removals WHERE request_id=?').get(input.requestId);
    if(existing){assertUser(existing.user_id===input.userId&&existing.period_id===input.periodId&&existing.actor_id===input.actor,'Dit verzoek is al voor een andere verwijdering gebruikt.');return existing;}
    const period=periodById(ctx,input.periodId);assertUser(period,'Deze termijn bestaat niet.');
    const entries=ctx.store.db.prepare("SELECT * FROM gangpot_entries WHERE kind='payment' AND user_id=? AND period_id=? AND voided_at IS NULL").all(input.userId,period.id);
    const claims=ctx.store.db.prepare("SELECT * FROM gangpot_claims WHERE user_id=? AND period_id=? AND withdrawn_at IS NULL AND (status='pending' OR payment_id IN (SELECT id FROM gangpot_entries WHERE voided_at IS NULL))").all(input.userId,period.id);
    assertUser(entries.length||claims.length,'Deze gebruiker heeft geen actieve betaling of open betaalmelding voor deze termijn.');
    const amount=entries.reduce((sum,item)=>sum+item.amount,0);
    assertUser(amount<=gangpotBalance(ctx),'Corrigeer eerst de bijbehorende uitgaven, zodat het saldo niet negatief wordt.');
    for(const entry of entries){
      ctx.store.db.prepare('UPDATE gangpot_entries SET voided_at=?,voided_by=?,void_reason=? WHERE id=?').run(now,input.actor,reason,entry.id);
      ctx.store.audit('gangpot.void',input.actor,{id:entry.id,reason});
    }
    for(const claim of claims)ctx.store.db.prepare("UPDATE gangpot_claims SET withdrawn_at=?,withdrawn_by=?,withdraw_reason=?,status=CASE WHEN status='pending' THEN 'rejected' ELSE status END,dirty=1,next_attempt=0 WHERE id=?").run(now,input.actor,reason,claim.id);
    reconcileDebt(ctx,period,input.userId,input.actor,now);
    const id=uid();ctx.store.db.prepare('INSERT INTO gangpot_removals(id,request_id,user_id,period_id,actor_id,amount,claim_count,reason,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id,input.requestId,input.userId,period.id,input.actor,amount,claims.length,reason,now);
    ctx.store.audit('gangpot.remove',input.actor,{id,user:input.userId,period:period.id,amount,entries:entries.map(item=>item.id),claims:claims.map(item=>item.id),reason});
    ctx.store.setSetting('gangpot:dirty','1');
    return ctx.store.db.prepare('SELECT * FROM gangpot_removals WHERE id=?').get(id);
  });
}
export function gangpotSummary(ctx,guild,now=Date.now()){
  if(!ctx.config.gangpot)return null;
  const period=currentPeriod(ctx,now),members=gangpotMembers(ctx,period,now).map(item=>({...item,name:guild.members.cache.get(item.user_id)?.displayName||item.user_id}));
  const claims=ctx.store.db.prepare('SELECT * FROM gangpot_claims ORDER BY reported_at DESC LIMIT 200').all().map(item=>({...item,status:item.withdrawn_at?'revoked':item.status,userName:guild.members.cache.get(item.user_id)?.displayName||item.user_id,reviewerName:guild.members.cache.get(item.withdrawn_by||item.reviewer_id)?.displayName||(item.withdrawn_by||item.reviewer_id),url:item.message_id?`https://discord.com/channels/${guild.id}/${ctx.config.gangpot.paymentsChannelId}/${item.message_id}`:null}));
  return{balance:gangpotBalance(ctx),weeklyAmount:ctx.config.gangpot.weeklyAmount,period,members,claims,periods:ctx.store.db.prepare('SELECT * FROM gangpot_periods ORDER BY starts_at DESC LIMIT 16').all(),entries:ctx.store.db.prepare('SELECT * FROM gangpot_entries ORDER BY created_at DESC LIMIT 100').all().map(item=>({...item,userName:guild.members.cache.get(item.user_id)?.displayName||item.user_id,actorName:guild.members.cache.get(item.actor_id)?.displayName||item.actor_id})),infoChannelId:ctx.config.gangpot.infoChannelId,memberRoleId:ctx.config.gangpot.memberRoleId,paymentsChannelId:ctx.config.gangpot.paymentsChannelId,totalChannelId:ctx.config.gangpot.totalChannelId};
}
export function reportGangpotPayment(ctx,input,now=Date.now()){
  requireGangPot(ctx);
  assertUser(typeof input.requestId==='string'&&input.requestId.length>=8&&input.requestId.length<=100,'Ongeldige betaalmelding.');
  assertUser(/^\d{17,20}$/.test(input.userId)&&Number.isSafeInteger(input.amount)&&input.amount>0&&input.amount<=100000000,'Vul een geldig betaald bedrag in.');
  const note=String(input.note||'').trim();assertUser(note.length<=500,'Gebruik een notitie van maximaal 500 tekens.');
  return ctx.store.transaction(()=>{
    const existing=ctx.store.db.prepare('SELECT * FROM gangpot_claims WHERE request_id=?').get(input.requestId);
    if(existing){assertUser(existing.user_id===input.userId&&existing.amount===input.amount&&existing.period_id===input.periodId,'Deze betaalmelding is al gebruikt.');return existing;}
    const period=periodById(ctx,input.periodId);assertUser(period&&period.starts_at<=now,'Deze termijn bestaat nog niet.');
    const due=ctx.store.db.prepare('SELECT * FROM gangpot_dues WHERE period_id=? AND user_id=?').get(period.id,input.userId);
    assertUser(due?.active,'Je staat niet in het betaaloverzicht van deze termijn.');
    assertUser(!ctx.store.db.prepare("SELECT 1 FROM gangpot_claims WHERE period_id=? AND user_id=? AND status='pending'").get(period.id,input.userId),'Je hebt al een betaalmelding voor deze termijn die op een Lead-vinkje wacht.');
    const remaining=period.weekly_amount-gangpotPaid(ctx,period,input.userId).total;
    assertUser(input.amount<=remaining,remaining<=0?'Deze weekbijdrage is al volledig goedgekeurd.':`Er staat nog ${gangpotMoney(remaining)} open. Meld maximaal dat bedrag.`);
    const id=uid();ctx.store.db.prepare('INSERT INTO gangpot_claims(id,request_id,period_id,user_id,amount,reported_at,note) VALUES(?,?,?,?,?,?,?)').run(id,input.requestId,period.id,input.userId,input.amount,now,note);
    ctx.store.audit('gangpot.report',input.userId,{id,period:period.id,amount:input.amount});
    return ctx.store.db.prepare('SELECT * FROM gangpot_claims WHERE id=?').get(id);
  });
}
export async function reviewGangpotPayment(ctx,guild,member,id,decision,clock=Date.now){
  requireGangPot(ctx);assertUser(guild.id===ctx.config.guildId,'Deze betaalmelding hoort bij de Legion-hoofdserver.');assertUser(['approve','reject'].includes(decision),'Kies goedkeuren of afkeuren.');
  return serializeCommunity(`${ctx.config.guildId}:gangpot`,async()=>{
    const reviewer=await guild.members.fetch({user:member.id,force:true});
    assertUser(!reviewer.user.bot&&reviewer.roles.cache.has(GANGPOT_LEAD_ROLE_ID),'Alleen de Lead-rol kan betalingen goedkeuren of afkeuren.');
    return ctx.store.transaction(()=>{
      const now=clock(),claim=ctx.store.db.prepare('SELECT * FROM gangpot_claims WHERE id=?').get(id);
      assertUser(claim,'Deze betaalmelding bestaat niet.');
      assertUser(!claim.withdrawn_at,'Deze betaling of betaalmelding is verwijderd. Het lid moet een nieuwe melding maken.');
      if(claim.status!=='pending')return claim; // Een tweede klik telt nooit nog een betaling.
      assertUser(claim.reported_at<=now,'Deze betaalmelding kan nog niet worden beoordeeld.');
      let payment;
      if(decision==='approve'){
        // Het moment van het Lead-vinkje telt; een melding zonder vinkje geeft geen uitstel.
        payment=recordEntryInside(ctx,{kind:'payment',amount:claim.amount,userId:claim.user_id,periodId:claim.period_id,requestId:`claim:${claim.id}`,actor:reviewer.id,note:claim.note,paidAt:now},now);
      }
      ctx.store.db.prepare('UPDATE gangpot_claims SET status=?,reviewer_id=?,reviewed_at=?,payment_id=?,dirty=1,next_attempt=0 WHERE id=?').run(decision==='approve'?'approved':'rejected',reviewer.id,now,payment?.id||null,id);
      ctx.store.audit(`gangpot.${decision}`,reviewer.id,{id,user:claim.user_id,period:claim.period_id});
      if(decision==='reject')reconcileDebt(ctx,periodById(ctx,claim.period_id),claim.user_id,reviewer.id,now);
      return ctx.store.db.prepare('SELECT * FROM gangpot_claims WHERE id=?').get(id);
    });
  });
}
export function gangpotClaimMessage(ctx,claim){
  if(claim.withdrawn_at)return{embeds:[embed(ctx.config,'Legion — Betaling verwijderd',`**Lid:** <@${claim.user_id}>\n**Termijn:** t/m ${claim.period_id}\n**Bedrag:** ${gangpotMoney(claim.amount)}\n**Status:** ⚪ Verwijderd\n**Door:** <@${claim.withdrawn_by}>\n**Reden:** ${safeText(claim.withdraw_reason||'Registratie gecorrigeerd.')}\n\nDeze betaling telt niet meer mee. Het lid kan opnieuw /gangpot betaling gebruiken. De oorspronkelijke deadline blijft gelden.`).setColor(0x64748B).setFooter({text:`Legion • Gangpotmelding ${claim.id}`})],components:[],allowedMentions:quiet};
  const pending=claim.status==='pending',approved=claim.status==='approved';
  const card=embed(ctx.config,'Legion — Betaalmelding',`**Lid:** <@${claim.user_id}>\n**Termijn:** t/m ${claim.period_id}\n**Gemeld bedrag:** ${gangpotMoney(claim.amount)}\n**Status:** ${pending?'🟠 Wacht op Lead-vinkje':approved?'✅ Goedgekeurd':'❌ Afgekeurd'}${claim.reviewer_id?`\n**Beoordeeld door:** <@${claim.reviewer_id}>`:''}${claim.note?`\n\n**Toelichting:** ${safeText(claim.note)}`:''}\n\n${pending?'Lead: controleer of het bedrag werkelijk in-game is ontvangen. Zonder volledige goedkeuring vóór zaterdag 23:59 volgt automatisch een gangwarn.':approved?'Het bedrag is toegevoegd aan de gangpot. Een vinkje na de deadline verwijdert een gangwarn niet.':'Er is geen bedrag toegevoegd. Meld je betaling opnieuw zodra deze klopt; de deadline blijft gelden.'}`).setColor(pending?0xF59E0B:approved?0x22C55E:0xEF4444).setFooter({text:`Legion • Gangpotmelding ${claim.id}`});
  return{embeds:[card],components:[row(button(`gangpot:approve:${claim.id}`,'✅ Goedkeuren',ButtonStyle.Success).setDisabled(!pending),button(`gangpot:reject:${claim.id}`,'❌ Afkeuren',ButtonStyle.Danger).setDisabled(!pending))],allowedMentions:quiet};
}
async function publishClaims(ctx,guild,now){
  for(const claim of ctx.store.db.prepare('SELECT * FROM gangpot_claims WHERE dirty=1 AND next_attempt<=? ORDER BY reported_at LIMIT 30').all(now)){
    try{await updateCommunityPost(ctx,guild,'gangpot_claims',{...claim,channel_id:ctx.config.gangpot.paymentsChannelId},gangpotClaimMessage(ctx,claim),`Legion • Gangpotmelding ${claim.id}`);}
    catch(error){ctx.store.db.prepare('UPDATE gangpot_claims SET next_attempt=?,last_error=? WHERE id=?').run(now+60000,String(error.code||error.name),claim.id);}
  }
}
export async function handleGangpotReview(ctx,interaction){
  requireGangPot(ctx);const [,decision,id]=interaction.customId.split(':');
  await interaction.deferReply({flags:MessageFlags.Ephemeral});
  const claim=ctx.store.db.prepare('SELECT * FROM gangpot_claims WHERE id=?').get(id);
  assertUser(claim&&interaction.channelId===ctx.config.gangpot.paymentsChannelId&&interaction.message.id===claim.message_id,'Deze knop hoort niet bij de betaalmelding.');
  await syncGangpot(ctx,interaction.client);
  const result=await reviewGangpotPayment(ctx,interaction.guild,interaction.member,id,decision);
  await syncGangpot(ctx,interaction.client);
  return interaction.editReply({content:result.status==='approved'?'✅ Betaling goedgekeurd en aan de gangpot toegevoegd.':'❌ Betaalmelding afgekeurd.',allowedMentions:quiet});
}
function dueLines(items){return items.length?items.slice(0,22).map(item=>`${item.status==='paid'?'🟢':item.status==='warned'?'🔴':'🟠'} <@${item.user_id}> · ${gangpotMoney(item.paid)}/${gangpotMoney(item.expected)}`).join('\n')+(items.length>22?`\n… en ${items.length-22} andere leden. Bekijk /gangpot status voor je eigen termijn.`:''):'Nog geen leden geregistreerd.';}
export function gangpotPaymentMessage(ctx,guild,now=Date.now()){
  const settings=ctx.config.gangpot;
  const description=`Samen bouwen we een gangpot op om Legion te steunen. **Leden met rol <@&${settings.memberRoleId}> betalen ${gangpotMoney(settings.weeklyAmount)} per week.** Zonder deze rol hoef je geen bijdrage te melden en ontvang je geen automatische gangpotwarn.\n\n**Termijn: zaterdag–zaterdag.**\n**Deadline: iedere zaterdag om 23:59, Belgische tijd.**\n\n**Zo werkt het**\n1. Betaal je bijdrage in-game aan de verantwoordelijke leiding.\n2. Meld zelf je betaling met **/gangpot betaling**. Je melding verschijnt in <#${settings.paymentsChannelId}>.\n3. Lead controleert je melding en kiest **✅ Goedkeuren** of **❌ Afkeuren**. Alleen goedgekeurde bedragen tellen mee.\n\n**Geen melding, geen vinkje of geen volledige goedkeuring vóór de deadline? Dan volgt automatisch één gangwarn voor die week.** Ook een melding die nog op controle wacht geeft geen uitstel. Een vinkje na de deadline verwijdert de warn niet. Zorg dus dat je op tijd betaalt én goedkeuring krijgt.\n\nHet totaal en wie betaald heeft vind je in <#${settings.totalChannelId}>. Gebruik **/gangpot status** voor je eigen betaalstatus en deadline. Dit gaat om FiveM-geld. Vragen of opmerkingen? Bespreek het met de leiding in de chat.`;
  const card=embed(ctx.config,'Legion — Gangpotinformatie',description).setColor(0xF59E0B).setFooter({text:'Legion • Gangpotinformatie'});
  return{embeds:[card],components:[row(button('gangpot:status','Mijn betaalstatus'))],allowedMentions:quiet};
}
export function gangpotTotalMessage(ctx,guild,now=Date.now()){
  const data=gangpotSummary(ctx,guild,now),period=data.period,active=data.members.filter(item=>item.active);
  const paid=active.filter(item=>item.paid>=period.weekly_amount);
  const card=embed(ctx.config,'Legion — Totaal gangpot & betalingen',`## ${gangpotMoney(data.balance)}\nBevestigd in-game saldo: goedgekeurde betalingen en donaties, min uitgaven.${period?`\n\n**Termijn:** t/m zaterdag ${period.id}\n**Deadline:** <t:${Math.floor((period.ends_at-60000)/1000)}:F>\n**Deze week betaald:** ${paid.length}/${active.length} leden met <@&${ctx.config.gangpot.memberRoleId}>.`:''}`).setColor(0x22C55E).setFooter({text:'Legion • Totaal gangpot'});
  let lines=[];let length=0,shown=0;
  for(const item of paid){const line=`${item.onTime>=period.weekly_amount?'✅':'🕒'} <@${item.user_id}> · ${gangpotMoney(item.paid)}`;if(length+line.length>3300)break;lines.push(line);length+=line.length+1;shown++;}
  if(!lines.length)lines=['Nog geen volledige weekbijdragen goedgekeurd.'];
  if(shown<paid.length)lines.push(`… en ${paid.length-shown} andere leden. De volledige lijst staat in het dashboard.`);
  let chunk='';const chunks=[];for(const line of lines){if(chunk.length+line.length+1>1000){chunks.push(chunk);chunk='';}chunk+=(chunk?'\n':'')+line;}if(chunk)chunks.push(chunk);
  chunks.forEach((value,index)=>card.addFields({name:index?'Betaald (vervolg)':'Wie heeft deze week betaald?',value}));
  if(paid.some(item=>item.onTime<period.weekly_amount))card.addFields({name:'🕒 Te laat goedgekeurd',value:'Het bedrag telt mee voor het saldo. Een bestaande gangwarn blijft staan.'});
  return{embeds:[card],components:[row(button('gangpot:status','Mijn betaalstatus'))],allowedMentions:quiet};
}
async function upsertGangpotPost(ctx,guild,channelId,key,payload,marker){
  const channel=await communityChannel(guild,channelId);assertUser(channel.permissionsFor(guild.members.me)?.has(P.EmbedLinks),'De bot heeft Links insluiten nodig in de gangpotkanalen.');
  const saved=ctx.store.setting(key);let message=saved?await channel.messages.fetch(saved).catch(error=>{if(error.code===10008)return null;throw error;}):null;
  const markers=marker==='Legion • Gangpotinformatie'?['Legion • Gangpotinformatie','Legion • Totaal gangpot']:[marker];
  if(!message||message.author.id!==guild.members.me.id){const history=await channel.messages.fetch({limit:100});message=[...history.values()].find(item=>item.author.id===guild.members.me.id&&item.embeds?.some(card=>markers.includes(card.footer?.text)));}
  const posted=message?.author.id===guild.members.me.id?await message.edit(payload):await channel.send({...payload,nonce:`${marker==='Legion • Gangpotinformatie'?'gi':'gt'}:${channelId}`,enforceNonce:true});
  ctx.store.setSetting(key,posted.id);
}
export async function publishGangpot(ctx,guild,now=Date.now()){
  const settings=ctx.config.gangpot,infoKey=`gangpot:info:message:${settings.infoChannelId}`,layout=`${settings.infoChannelId}:${settings.totalChannelId}`;
  if(ctx.store.setting('gangpot:layout')!==layout){
    // Hergebruik de oude totaal-embed in het informatiekanaal, met behoud van het bericht-ID.
    if(!ctx.store.setting(infoKey)&&settings.infoChannelId==='1555685634515927050'&&ctx.store.setting('gangpot:total:message'))ctx.store.setSetting(infoKey,ctx.store.setting('gangpot:total:message'));
    await upsertGangpotPost(ctx,guild,settings.infoChannelId,infoKey,gangpotPaymentMessage(ctx,guild,now),'Legion • Gangpotinformatie');
    const payments=await communityChannel(guild,settings.paymentsChannelId),history=await payments.messages.fetch({limit:100});
    const owned=[...history.values()].filter(message=>message.author.id===guild.members.me.id&&message.embeds?.some(card=>card.footer?.text==='Legion • Gangpotbetalingen'));
    const oldId=ctx.store.setting('gangpot:payments:message');
    if(oldId&&!owned.some(message=>message.id===oldId)){const saved=await payments.messages.fetch(oldId).catch(error=>{if(error.code===10008)return null;throw error;});if(saved?.author.id===guild.members.me.id&&saved.embeds?.some(card=>card.footer?.text==='Legion • Gangpotbetalingen'))owned.push(saved);}
    for(const message of owned)await message.delete().catch(error=>{if(error.code!==10008)throw error;});
    ctx.store.db.prepare("DELETE FROM settings WHERE key IN ('gangpot:payments:message','gangpot:total:message')").run();
    ctx.store.setSetting('gangpot:layout',layout);
  }else await upsertGangpotPost(ctx,guild,settings.infoChannelId,infoKey,gangpotPaymentMessage(ctx,guild,now),'Legion • Gangpotinformatie');
  await upsertGangpotPost(ctx,guild,settings.totalChannelId,`gangpot:total:message:${settings.totalChannelId}`,gangpotTotalMessage(ctx,guild,now),'Legion • Totaal gangpot');
  ctx.store.setSetting('gangpot:dirty','0');
}
async function deliverNotices(ctx,guild,client,now){
  for(const item of ctx.store.db.prepare('SELECT * FROM gangpot_notifications WHERE (log_id IS NULL OR (dm_id IS NULL AND dm_blocked=0)) AND next_attempt<=? ORDER BY rowid LIMIT 10').all(now)){
    try{
      const title=item.kind==='revoke'?'Legion — Gangpotwarn ingetrokken':item.kind==='restore'?'Legion — Gangpotwarn hersteld':'Legion — Automatische gangpotwarn';
      const color=item.kind==='revoke'?0x22C55E:0xEF4444,count=ctx.store.warnCount(item.user_id);
      const card=embed(ctx.config,title,`${item.message}\n\n**Lid:** <@${item.user_id}>\n**Warn-ID:** \`${item.warn_id}\`\n**Actieve gangwarns:** ${count}${count>=ctx.config.warnThreshold?'\nDe warn-drempel is bereikt. De leiding beoordeelt dit.':''}`).setColor(color);
      if(!item.log_id){const channel=await warnLogChannel(guild,ctx.config),message=await channel.send({embeds:[card],nonce:`gp-log:${item.id}`,enforceNonce:true,allowedMentions:quiet});ctx.store.db.prepare('UPDATE gangpot_notifications SET log_id=? WHERE id=?').run(message.id,item.id);}
      if(!item.dm_id&&!item.dm_blocked){
        const user=guild.members.cache.get(item.user_id)?.user||await client.users.fetch(item.user_id);
        try{const dm=await user.send({embeds:[card],nonce:`gp-dm:${item.id}`,enforceNonce:true,allowedMentions:quiet});ctx.store.db.prepare('UPDATE gangpot_notifications SET dm_id=? WHERE id=?').run(dm.id,item.id);}
        catch(error){if(error.code===50007)ctx.store.db.prepare('UPDATE gangpot_notifications SET dm_blocked=1,last_error=? WHERE id=?').run('DM_BLOCKED',item.id);else throw error;}
      }
    }catch(error){ctx.store.db.prepare('UPDATE gangpot_notifications SET next_attempt=?,last_error=? WHERE id=?').run(now+60000,String(error.code||error.name),item.id);}
  }
}
export async function syncGangpot(ctx,client,now=Date.now()){
  if(!ctx.config.gangpot)return;
  return serializeCommunity(`${ctx.config.guildId}:gangpot`,async()=>{
    const guild=client.guilds.cache.get(ctx.config.guildId);assertUser(guild,'De gangpot-hoofdserver is niet bereikbaar.');
    // Geen automatische straf op basis van een lege of verouderde ledencache.
    await refreshMembers(guild);migrateOpenTerms(ctx,guild,now);ensurePeriod(ctx,guild,now);enforcePeriods(ctx,guild,now);
    await deliverNotices(ctx,guild,client,now);
    await publishClaims(ctx,guild,now);
    await publishGangpot(ctx,guild,now);
  });
}
function selectPeriod(ctx,value,now){const period=value?periodById(ctx,gangpotPeriodId(value)):currentPeriod(ctx,now);assertUser(period,'De gangpottermijn wordt nog gestart. Probeer over een minuut opnieuw.');return period;}
export function gangpotStatusMessage(ctx,user,now=Date.now()){
  const period=currentPeriod(ctx,now);assertUser(period,'De gangpottermijn wordt nog gestart. Probeer over een minuut opnieuw.');
  const item=gangpotMembers(ctx,period,now).find(item=>item.user_id===user);assertUser(item,'Je staat nog niet in het betaaloverzicht. Probeer over een minuut opnieuw.');
  const pending=ctx.store.db.prepare("SELECT amount FROM gangpot_claims WHERE period_id=? AND user_id=? AND status='pending'").get(period.id,user);
  return{embeds:[embed(ctx.config,'Legion — Jouw gangpotbijdrage',`**Termijn:** t/m ${period.id}\n**Weekbijdrage:** ${gangpotMoney(period.weekly_amount)}\n**Goedgekeurd:** ${gangpotMoney(item.paid)}\n**Nog open:** ${gangpotMoney(item.remaining)}${pending?`\n**Wacht op Lead-vinkje:** ${gangpotMoney(pending.amount)}`:''}\n**Deadline:** zaterdag 23:59 · <t:${Math.floor((period.ends_at-60000)/1000)}:R>\n\n${item.status==='paid'?'🟢 Je weekbijdrage is tijdig goedgekeurd.':'🟠 Gebruik /gangpot betaling en zorg dat Lead vóór de deadline goedkeurt. Zonder volledige goedkeuring volgt automatisch een gangwarn.'}`).setColor(item.status==='paid'?0x22C55E:0xF59E0B)],allowedMentions:quiet};
}
export async function handleGangpotStatus(ctx,interaction){requireGangPot(ctx);await interaction.deferReply({flags:MessageFlags.Ephemeral});await syncGangpot(ctx,interaction.client);assertUser(gangpotEligible(ctx,interaction.guild.members.cache.get(interaction.user.id)),`Zonder rol <@&${ctx.config.gangpot.memberRoleId}> hoef je geen gangpotbijdrage te betalen.`);await interaction.editReply(gangpotStatusMessage(ctx,interaction.user.id));}
export async function handleGangpotCommand(ctx,interaction){
  requireGangPot(ctx);const action=interaction.options.getSubcommand();
  if(action==='status')return handleGangpotStatus(ctx,interaction);
  if(action!=='betaling')requireStaff(interaction,ctx.config);
  await interaction.deferReply({flags:MessageFlags.Ephemeral});
  const submittedAt=interaction.createdTimestamp??Date.now();
  await syncGangpot(ctx,interaction.client,submittedAt);
  if(action==='refresh')return interaction.editReply({content:'Gangpotinformatie, totaal en betaaloverzicht zijn bijgewerkt.',allowedMentions:quiet});
  if(action==='betaling-verwijderen'){
    const period=selectPeriod(ctx,interaction.options.getString('termijn'),submittedAt);
    const result=removeGangpotPayment(ctx,{userId:interaction.options.getUser('gebruiker',true).id,periodId:period.id,actor:interaction.user.id,requestId:interaction.id,reason:interaction.options.getString('reden')},Date.now());
    await syncGangpot(ctx,interaction.client);
    return interaction.editReply({content:`Betaling van <@${result.user_id}> voor **${result.period_id}** verwijderd. **${gangpotMoney(result.amount)}** uit het totaal gehaald; **${result.claim_count}** melding(en) ingetrokken. De historie blijft bewaard. Gangpotsaldo: **${gangpotMoney(gangpotBalance(ctx))}**.`,allowedMentions:quiet});
  }
  if(action==='overzicht'){const period=selectPeriod(ctx,interaction.options.getString('termijn'),submittedAt),items=gangpotMembers(ctx,period);return interaction.editReply({embeds:[embed(ctx.config,`Legion — Gangpot t/m ${period.id}`,dueLines(items.map(item=>({...item,expected:period.weekly_amount}))))],allowedMentions:quiet});}
  if(action==='betaling'){
    assertUser(gangpotEligible(ctx,interaction.guild.members.cache.get(interaction.user.id)),`Alleen leden met rol <@&${ctx.config.gangpot.memberRoleId}> moeten een gangpotbetaling melden.`);
    const period=selectPeriod(ctx,interaction.options.getString('termijn'),submittedAt);
    const claim=reportGangpotPayment(ctx,{userId:interaction.user.id,periodId:period.id,amount:interaction.options.getInteger('bedrag')??ctx.config.gangpot.weeklyAmount,requestId:interaction.id,note:interaction.options.getString('notitie')||''},submittedAt);
    await syncGangpot(ctx,interaction.client);
    return interaction.editReply({content:`Je betaalmelding van **${gangpotMoney(claim.amount)}** voor **${period.id}** is opgeslagen in <#${ctx.config.gangpot.paymentsChannelId}>. Lead moet vóór zaterdag 23:59 goedkeuren. Zonder volledige goedkeuring krijg je automatisch een gangwarn.`,allowedMentions:quiet});
  }
  let result;
  if(action==='correctie')result=voidGangpotEntry(ctx,interaction.options.getString('id',true),interaction.user.id,interaction.options.getString('reden',true));
  else{
    result=recordGangpotEntry(ctx,{kind:{donatie:'donation',uitgave:'expense'}[action],amount:interaction.options.getInteger('bedrag',true),actor:interaction.user.id,requestId:interaction.id,note:interaction.options.getString('notitie')||interaction.options.getString('reden')||'',paidAt:submittedAt});
  }
  await syncGangpot(ctx,interaction.client);
  return interaction.editReply({content:`${action==='correctie'?'Registratie gecorrigeerd':'Registratie bevestigd'}: **${gangpotMoney(result.amount)}**. ID: \`${result.id}\`. Gangpotsaldo: **${gangpotMoney(gangpotBalance(ctx))}**.`,allowedMentions:quiet});
}
