const json=value=>value?.toJSON?value.toJSON():value;
function normalize(value){
  value=json(value);
  if(Array.isArray(value))return value.map(normalize);
  if(!value||typeof value!=='object')return value;
  return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).filter(([key,item])=>
    item!==null&&item!==undefined&&!(Array.isArray(item)&&!item.length)&&
    !(item===false&&['inline','disabled','animated','default'].includes(key))&&
    !(key==='type'&&item==='rich')&&!(key==='id'&&typeof item==='number'&&value.type!==undefined)&&
    !['proxy_url','proxy_icon_url','width','height','timestamp'].includes(key)
  ).map(([key,item])=>[key,normalize(item)]));
}
export function messageMatchesPayload(message,payload){
  if(Object.keys(payload).some(key=>!['content','embeds','components','allowedMentions'].includes(key)))return false;
  const current={content:message.content||'',embeds:message.embeds||[],components:message.components||[]};
  const desired={content:payload.content??current.content,embeds:payload.embeds??current.embeds,components:payload.components??current.components};
  return JSON.stringify(normalize(current))===JSON.stringify(normalize(desired));
}
export async function editIfChanged(message,payload){return messageMatchesPayload(message,payload)?message:message.edit(payload);}
