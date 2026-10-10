export function cleanAudit(value,key=''){
  if(/token|secret|password|cookie|csrf|invite|url|payload|answers|content|reason|motivation|vraag|notitie/i.test(key))return'[afgeschermd]';
  if(Array.isArray(value))return value.slice(0,30).map(item=>cleanAudit(item,key));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).slice(0,30).map(([name,item])=>[name,cleanAudit(item,name)]));
  if(typeof value==='string')return value.replace(/[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}|https?:\/\/\S+/g,'[afgeschermd]').slice(0,200);
  return value===null||['boolean','number'].includes(typeof value)?value:null;
}
