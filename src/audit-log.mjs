import {randomBytes} from 'node:crypto';
import {embed,safeText} from './ui.mjs';
import {quiet,staffLogChannel} from './service.mjs';
import {communityChannel,serializeCommunity} from './community-posts.mjs';
import {operationSettings} from './feature-settings.mjs';
import {cleanAudit} from './audit-sanitize.mjs';
import {auditPayloads} from './audit-format.mjs';
export {cleanAudit} from './audit-sanitize.mjs';
function optionSummary(options){return(options||[]).map(option=>({name:option.name,...(option.options?{options:optionSummary(option.options)}:{value:typeof option.value==='string'?(option.type===3&&!/^\d{2}([-/:]\d{2}){1,2}$|^\d{4}-\d{2}-\d{2}$|^[a-f0-9]{12}$/.test(option.value)?'[tekst]':option.value):option.value})}));}
export function recordInteraction(ctx,interaction,phase,error){
  if(!ctx)return;
  const type=interaction.isChatInputCommand?.()?'command':interaction.isButton?.()?'button':interaction.isStringSelectMenu?.()?'select':'modal';
  let route=type==='command'?`/${interaction.commandName}`:String(interaction.customId||'').split(':').slice(0,2).join(':');
  if(type==='command'){let options=interaction.options?.data;for(let depth=0;depth<2;depth++){const sub=options?.find(item=>[1,2].includes(item.type));if(!sub)break;route+=` ${sub.name}`;options=sub.options;}}
  ctx.store.audit(`interaction.${phase}`,interaction.user.id,{interaction:interaction.id,type,route,channel:interaction.channelId,options:type==='command'?optionSummary(interaction.options?.data):[],error:error?String(error.code||error.name):null});
}
export async function auditedAction(ctx,actor,name,execute){
  ctx.store.audit('dashboard.action.started',actor,{action:name});
  try{const result=await execute();ctx.store.audit('dashboard.action.succeeded',actor,{action:name});return result;}
  catch(error){ctx.store.audit('dashboard.action.failed',actor,{action:name,error:String(error.code||error.name)});throw error;}
}
export async function flushAuditLogs(ctx,guild,now=Date.now()){
  if(!operationSettings(ctx).logs.enabled)return;
  return serializeCommunity(`${guild.id}:audit`,async()=>{
    const destination=ctx.config.botLogChannelId?await communityChannel(guild,ctx.config.botLogChannelId):await staffLogChannel(guild,ctx.config);
    for(let batch=0;batch<10;batch++){
      let job=ctx.store.db.prepare('SELECT * FROM audit_deliveries WHERE message_id IS NULL ORDER BY first_id LIMIT 1').get();
      if(job&&job.next_attempt>now)return;
      if(!job){const cursor=Number(ctx.store.setting('audit:cursor')||0),rows=ctx.store.db.prepare('SELECT * FROM audit WHERE id>? ORDER BY id LIMIT ?').all(cursor,operationSettings(ctx).logs.batchSize);if(!rows.length)return;
        const id=randomBytes(6).toString('hex');ctx.store.db.prepare('INSERT INTO audit_deliveries(id,first_id,last_id,channel_id) VALUES(?,?,?,?)').run(id,rows[0].id,rows.at(-1).id,destination.id);job=ctx.store.db.prepare('SELECT * FROM audit_deliveries WHERE id=?').get(id);
      }
      try{
        const rows=ctx.store.db.prepare('SELECT * FROM audit WHERE id>=? AND id<=? ORDER BY id').all(job.first_id,job.last_id).filter(item=>!item.event.endsWith('.started'));
        if(!rows.length){ctx.store.transaction(()=>{ctx.store.db.prepare("UPDATE audit_deliveries SET message_id='skipped' WHERE id=?").run(job.id);ctx.store.setSetting('audit:cursor',String(job.last_id));});continue;}
        let channel=job.channel_id===destination.id?destination:ctx.config.botLogChannelId?await communityChannel(guild,job.channel_id):await staffLogChannel(guild,{...ctx.config,logChannelId:job.channel_id});
        if(rows.some(item=>item.event.startsWith('message.'))){
          try{await staffLogChannel(guild,{...ctx.config,logChannelId:channel.id});}
          catch{channel=await staffLogChannel(guild,ctx.config);ctx.store.db.prepare('UPDATE audit_deliveries SET channel_id=? WHERE id=?').run(channel.id,job.id);}
        }
        let payloads=job.payloads?JSON.parse(job.payloads):null;
        if(!payloads){payloads=auditPayloads(ctx,rows,job.id);ctx.store.db.prepare('UPDATE audit_deliveries SET payloads=? WHERE id=?').run(JSON.stringify(payloads),job.id);}
        const delivered=JSON.parse(job.message_ids||'[]');
        const history=delivered.length<payloads.length?await channel.messages.fetch({limit:100}):null;
        for(let part=0;part<payloads.length;part++){
          if(delivered[part])continue;
          const marker=`Legion • Log ${job.id} • ${part+1}/${payloads.length}`,legacy=`Legion • Log ${job.id}`;
          let posted=[...(history?.values()||[])].find(item=>item.author.id===guild.members.me.id&&item.embeds?.some(card=>card.footer?.text===marker||(part===0&&card.footer?.text===legacy)));
          if(!posted)posted=await channel.send({...payloads[part],nonce:`al:${job.id}:${part}`,enforceNonce:true,allowedMentions:quiet});
          delivered[part]=posted.id;ctx.store.db.prepare('UPDATE audit_deliveries SET message_ids=?,last_error=NULL WHERE id=?').run(JSON.stringify(delivered),job.id);
        }
        ctx.store.transaction(()=>{ctx.store.db.prepare('UPDATE audit_deliveries SET message_id=?,last_error=NULL WHERE id=?').run(delivered[0],job.id);ctx.store.setSetting('audit:cursor',String(job.last_id));});
      }catch(error){ctx.store.db.prepare('UPDATE audit_deliveries SET next_attempt=?,last_error=? WHERE id=?').run(now+60000,String(error.code||error.name),job.id);return;}
    }
  });
}
