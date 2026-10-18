const eligible=(ctx,member)=>Boolean(member&&!member.user.bot&&member.roles.cache.has(ctx.config.gangpot.memberRoleId));
export function gangpotIntroduction(ctx,user,period){
  if(!period)return null;
  const membership=ctx.store.db.prepare('SELECT * FROM gangpot_memberships WHERE user_id=?').get(user);
  return membership&&period.starts_at<membership.required_from?membership:null;
}
function firstRequired(ctx,started,windowAt){
  const period=ctx.store.db.prepare('SELECT * FROM gangpot_periods WHERE starts_at<=? AND ends_at>? ORDER BY starts_at DESC LIMIT 1').get(started,started)||windowAt(started);
  return period?(started<=period.starts_at?period.starts_at:period.ends_at):started;
}
function remember(ctx,user,started,source,windowAt){
  const required=started===null?0:firstRequired(ctx,started,windowAt);
  const inserted=ctx.store.db.prepare('INSERT OR IGNORE INTO gangpot_memberships(user_id,started_at,required_from,source) VALUES(?,?,?,?)').run(user,started,required,source);
  if(inserted.changes&&required>0)ctx.store.db.prepare('UPDATE gangpot_claims SET dirty=1,next_attempt=0 WHERE user_id=? AND period_id IN (SELECT id FROM gangpot_periods WHERE starts_at<?)').run(user,required);
}
// Receiving the gang role is the joining event, even for someone already in Discord.
// Keep the first record when a role is removed/re-added: that must not restart grace.
export function recordGangpotMembership(ctx,before,after,windowAt,now=Date.now()){
  if(!ctx?.config.gangpot||!eligible(ctx,after)||eligible(ctx,before))return;
  const previous=ctx.store.db.prepare('SELECT MIN(enrolled_at) AS time FROM gangpot_dues WHERE user_id=?').get(after.id).time;
  const established=previous!==null&&previous<=now;
  remember(ctx,after.id,established?null:now,established?'existing':'role',windowAt);
}
export function syncGangpotMemberships(ctx,guild,windowAt,now=Date.now()){
  const initialized=ctx.store.setting('gangpot:membership-initialized')==='1';
  ctx.store.transaction(()=>{
    for(const member of guild.members.cache.values()){
      if(!eligible(ctx,member)||ctx.store.db.prepare('SELECT 1 FROM gangpot_memberships WHERE user_id=?').get(member.id))continue;
      // Discord does not expose when a role was assigned. Use a recorded role grant
      // or server join as evidence; first observing an existing member is not proof.
      const grant=ctx.store.db.prepare(`SELECT MIN(a.created_at) AS time FROM audit a
        WHERE a.event='member.update' AND json_valid(a.details) AND json_extract(a.details,'$.user')=?
        AND EXISTS(SELECT 1 FROM json_each(a.details,'$.added') r WHERE r.value=?)`).get(member.id,ctx.config.gangpot.memberRoleId).time;
      const joined=Number.isSafeInteger(member.joinedTimestamp)&&member.joinedTimestamp>0&&member.joinedTimestamp<=now?member.joinedTimestamp:null;
      const evidence=[grant,joined].filter(time=>Number.isSafeInteger(time)&&time>0&&time<=now);
      const previous=ctx.store.db.prepare('SELECT MIN(enrolled_at) AS time FROM gangpot_dues WHERE user_id=?').get(member.id).time;
      let started=initialized&&previous===null&&grant===null?now:evidence.length?Math.max(...evidence):initialized?now:null;
      // Earlier records prove membership predates a later join/role re-assignment.
      if(previous!==null&&(started===null||previous<started))started=null;
      remember(ctx,member.id,started,started===null?'existing':grant===started?'audit':joined===started?'join':'observed',windowAt);
    }
    ctx.store.setSetting('gangpot:membership-initialized','1');
  });
}

// Accepted community applications are additional proof for older members whose
// role-grant event was missed. Read both stores; only mutate the main guild store.
export function recoverAcceptedMemberships(ctx,guild,contexts,windowAt,now=Date.now()){
  const accepted=new Map(),affected=new Set();
  for(const source of contexts.values()){
    if(source.config.guildId===ctx.config.guildId||source.config.admission?.targetGuildId!==ctx.config.guildId)continue;
    const rows=source.store.db.prepare(`SELECT c.owner_id,MIN(c.closed_at) AS accepted_at FROM cases c
      JOIN acceptance_notifications n ON n.case_id=c.id AND n.owner_id=c.owner_id AND n.target_guild_id=?
      WHERE c.kind='application' AND c.status='accepted' AND c.closed_at IS NOT NULL AND c.closed_at<=? GROUP BY c.owner_id`).all(ctx.config.guildId,now);
    for(const row of rows)accepted.set(row.owner_id,Math.min(accepted.get(row.owner_id)??Infinity,row.accepted_at));
  }
  ctx.store.transaction(()=>{
    for(const [user,at]of accepted){
      const member=guild.members.cache.get(user);if(!eligible(ctx,member))continue;
      const window=ctx.store.db.prepare('SELECT * FROM gangpot_periods WHERE starts_at<=? AND ends_at>? ORDER BY starts_at DESC LIMIT 1').get(at,at)||windowAt(at);
      if(!window)continue;
      const previous=ctx.store.db.prepare(`SELECT 1 FROM gangpot_dues d JOIN gangpot_periods p ON p.id=d.period_id
        WHERE d.user_id=? AND p.starts_at<? AND d.enrolled_at<? LIMIT 1`).get(user,window.starts_at,at);
      const existing=ctx.store.db.prepare('SELECT * FROM gangpot_memberships WHERE user_id=?').get(user);
      if(previous||(existing&&['role','audit'].includes(existing.source)&&existing.started_at<window.starts_at))continue;
      const joined=Number.isSafeInteger(member.joinedTimestamp)&&member.joinedTimestamp<=now?member.joinedTimestamp:0;
      const roleAt=existing&&['role','audit'].includes(existing.source)?existing.started_at||0:0;
      const started=Math.max(at,joined,roleAt),required=Math.max(existing?.required_from||0,firstRequired(ctx,started,windowAt));
      if(!existing||required>existing.required_from){
        ctx.store.db.prepare(`INSERT INTO gangpot_memberships(user_id,started_at,required_from,source) VALUES(?,?,?,'admission')
          ON CONFLICT(user_id) DO UPDATE SET started_at=excluded.started_at,required_from=excluded.required_from,source='admission'`).run(user,started,required);
        ctx.store.db.prepare('UPDATE gangpot_claims SET dirty=1,next_attempt=0 WHERE user_id=? AND period_id IN (SELECT id FROM gangpot_periods WHERE starts_at<?)').run(user,required);
        ctx.store.audit('gangpot.membership.accepted',guild.members.me.id,{user,acceptedAt:at,requiredFrom:required});
      }
      affected.add(user);
    }
  });
  return affected;
}
