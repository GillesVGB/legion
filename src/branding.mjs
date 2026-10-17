import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

export const BRAND_NAME='Bakarov';
export const BRAND_COLOR=0xD6A51A;
export const logo=readFileSync(new URL('./branding-assets/logo.webp',import.meta.url));
export const logoDataURI=`data:image/webp;base64,${logo.toString('base64')}`;
const avatar=readFileSync(new URL('./branding-assets/avatar.png',import.meta.url));
const avatarDigest=createHash('sha256').update(avatar).digest('hex');

// Only use on bot-owned labels/markers, never on messages written by members.
export const canonicalBrandText=value=>String(value??'').replace(/\bLEGION\b/g,'BAKAROV').replace(/\bLegion\b/g,BRAND_NAME);
export function brandLogoURL(config){
  if(config.brandLogoURL)return config.brandLogoURL;
  const origin=config.dashboardPublicURL||config.transcriptSiteURL;
  try{const url=new URL(origin);return url.protocol==='https:'?new URL('/dashboard/logo.webp',url.origin).href:undefined;}catch{return undefined;}
}

export function migrateBrandSettings(ctx,saved){
  if(ctx.store.setting('branding:version')==='bakarov-1')return saved;
  const migrated=structuredClone(saved);
  if(migrated.content)for(const [key,value] of Object.entries(migrated.content)){
    if(typeof value==='string')migrated.content[key]=canonicalBrandText(value);
    else if(Array.isArray(value))migrated.content[key]=value.map(item=>typeof item==='string'?canonicalBrandText(item):item);
  }
  if(migrated.operations?.planning)for(const key of ['title','preparation']){
    if(typeof migrated.operations.planning[key]==='string')migrated.operations.planning[key]=canonicalBrandText(migrated.operations.planning[key]);
  }
  if(/^#b91c1c$/i.test(migrated.color||''))migrated.color='#D6A51A';
  return migrated;
}

// One profile update per changed asset; successful uploads survive restarts.
export async function syncBotBranding(client,contexts){
  const ctx=contexts.values().next().value;
  if(!ctx)return;
  const user=client.user,key=`branding:avatar:${user.id}`;
  const saved=ctx.store.setting(key),expected=`${avatarDigest}:${user.avatar}`;
  const update={};
  if(user.username!==BRAND_NAME)update.username=BRAND_NAME;
  if(!user.avatar||saved!==expected)update.avatar=`data:image/png;base64,${avatar.toString('base64')}`;
  if(Object.keys(update).length){
    const updated=await user.edit(update);
    if(update.avatar)ctx.store.setSetting(key,`${avatarDigest}:${updated.avatar}`);
  }
  const url=user.displayAvatarURL({extension:'png',size:256});
  for(const entry of contexts.values())entry.config.brandLogoURL=url;
}
