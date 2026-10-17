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
