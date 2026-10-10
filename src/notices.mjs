import {randomBytes} from 'node:crypto';
import {staffLogChannel,quiet} from './service.mjs';
export function queueFeatureNotice(ctx,{key,kind,user=null,period=null,payload,now=Date.now()}){
  ctx.store.db.prepare('INSERT OR IGNORE INTO feature_notices(id,notice_key,kind,user_id,period_id,payload,created_at) VALUES(?,?,?,?,?,?,?)').run(randomBytes(6).toString('hex'),key,kind,user,period,JSON.stringify(payload),now);
}
export async function deliverFeatureNotices(ctx,guild,now=Date.now(),eligible=()=>true,kinds=[]){
  const filter=kinds.length?` AND kind IN (${kinds.map(()=>'?').join(',')})`:'';
  for(const item of ctx.store.db.prepare(`SELECT * FROM feature_notices WHERE status='pending' AND next_attempt<=?${filter} ORDER BY CASE WHEN user_id IS NULL THEN 0 ELSE 1 END,created_at LIMIT 30`).all(now,...kinds)){
    const allowed=eligible(item);if(allowed===null)continue;
    if(!allowed){ctx.store.db.prepare("UPDATE feature_notices SET status='skipped' WHERE id=?").run(item.id);continue;}
    try{
      const destination=item.user_id?guild.members.cache.get(item.user_id)?.user:await staffLogChannel(guild,ctx.config);
      if(!destination){ctx.store.db.prepare("UPDATE feature_notices SET status='skipped' WHERE id=?").run(item.id);continue;}
      const message=await destination.send({...JSON.parse(item.payload),nonce:`fn:${item.id}`,enforceNonce:true,allowedMentions:quiet});
      ctx.store.db.prepare("UPDATE feature_notices SET status='sent',message_id=?,last_error=NULL WHERE id=?").run(message.id,item.id);
      ctx.store.audit('notice.sent',guild.members.me.id,{kind:item.kind,user:item.user_id,period:item.period_id});
    }catch(error){ctx.store.db.prepare('UPDATE feature_notices SET status=?,next_attempt=?,last_error=? WHERE id=?').run(error.code===50007?'blocked':'pending',now+60000,String(error.code||error.name),item.id);}
  }
}
