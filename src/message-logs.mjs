import {operationSettings} from './feature-settings.mjs';
export function redactMessageText(value,config={}){
  let text=String(value??'');
  if(config.token)text=text.split(config.token).join('[token afgeschermd]');
  return text.replace(/[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/g,'[token afgeschermd]')
    .replace(/((?:DISCORD_TOKEN|password|wachtwoord|secret|api[_-]?key)\s*[:=]\s*)\S+/gi,'$1[afgeschermd]')
    .replace(/([#?&](?:login|token|key|k|code)=)[^\s&#]+/gi,'$1[afgeschermd]')
    .replace(/https?:\/\/(?:discord\.gg|discord(?:app)?\.com\/invite)\/[^\s]+/gi,'[uitnodiging afgeschermd]');
}
function snapshot(message,config){
  const available=Boolean(message&&!message.partial&&typeof message.content==='string');
  const attachments=[];
  for(const file of message?.attachments?.values?.()||[]){
    let url;try{const parsed=new URL(file.url);if(parsed.protocol==='https:'&&['cdn.discordapp.com','media.discordapp.net'].includes(parsed.hostname))url=parsed.href;}catch{}
    attachments.push({name:redactMessageText(file.name||'Bijlage',config).slice(0,200),url:url||null,size:file.size||0});
    if(attachments.length===10)break;
  }
  return{available,text:available?redactMessageText(message.content,config).slice(0,8000):null,attachments};
}
export function recordMessageEvent(ctx,event,message,before=null,{bulk=false}={}){
  const author=message.author||before?.author;
  if(!ctx||message.guild?.id!==ctx.config.guildId||author?.bot||!['message.delete','message.edit'].includes(event))return;
  if(event==='message.edit'&&before&&!before.partial&&before.content===message.content)return;
  return ctx.store.transaction(()=>{
    const id=ctx.store.audit(event,'',{message:message.id,channel:message.channelId,user:author?.id||null,bulk});
    if(operationSettings(ctx).logs.enabled)ctx.store.db.prepare('INSERT INTO message_audit(audit_id,snapshot) VALUES(?,?)').run(id,JSON.stringify({authorId:author?.id||null,authorName:redactMessageText(message.member?.displayName||author?.globalName||author?.username||'Onbekend',ctx.config).slice(0,100),sentAt:message.createdTimestamp||before?.createdTimestamp||null,before:event==='message.edit'?snapshot(before,ctx.config):null,after:snapshot(message,ctx.config)}));
    return id;
  });
}
