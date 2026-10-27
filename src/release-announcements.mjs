import {canonicalBrandText} from './branding.mjs';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {EmbedBuilder} from 'discord.js';
import {embed} from './ui.mjs';
import {quiet} from './service.mjs';
import {communityChannel,serializeCommunity} from './community-posts.mjs';
import {editIfChanged} from './message-updates.mjs';
export const releaseVersion=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;
export const releaseNotes=JSON.parse(readFileSync(new URL('./release-notes.json',import.meta.url),'utf8'));
export const renamedVersions={'1.9.0':'2.0.0','1.10.0':'2.1.0','1.10.1':'2.1.1','1.11.0':'2.2.0','1.11.1':'2.2.1','1.12.0':'2.3.0'};
async function renumberAnnouncements(ctx,guild){
  if(ctx.store.setting('release:renumbered:2')==='1')return;
  const channel=await communityChannel(guild,ctx.config.updateChannelId),history=await channel.messages.fetch({limit:100});
  for(const [oldVersion,version]of Object.entries(renamedVersions)){
    const marker=`Bakarov • Botupdate ${oldVersion}`,saved=ctx.store.db.prepare('SELECT message_id FROM release_announcements WHERE version=?').get(oldVersion)?.message_id;
    let message=[...history.values()].find(item=>item.author.id===guild.members.me.id&&item.embeds?.some(card=>canonicalBrandText(card.footer?.text)===marker));
    if(!message&&saved)message=await channel.messages.fetch(saved).catch(error=>{if(error.code===10008)return null;throw error;});
    if(!message||message.author.id!==guild.members.me.id)continue;
    const index=message.embeds.findIndex(card=>[marker,`Bakarov • Botupdate ${version}`].includes(canonicalBrandText(card.footer?.text)));if(index<0)continue;
    if(canonicalBrandText(message.embeds[index].footer?.text)===marker){
      const cards=message.embeds.map(card=>EmbedBuilder.from(card.toJSON?.()||card));
      cards[index].setTitle(`Bakarov — Botupdate ${version}`).setFooter({text:`Bakarov • Botupdate ${version}`});
      await message.edit({embeds:cards,allowedMentions:quiet});
    }
    ctx.store.db.prepare('INSERT INTO release_announcements(version,message_id) VALUES(?,?) ON CONFLICT(version) DO UPDATE SET message_id=COALESCE(release_announcements.message_id,excluded.message_id)').run(version,message.id);
  }
  ctx.store.setSetting('release:renumbered:2','1');ctx.store.db.prepare("DELETE FROM settings WHERE key='release:renumber:error'").run();
}
export async function announceRelease(ctx,guild,version=releaseVersion,notes=releaseNotes[version]){
  if(!ctx.config.updateChannelId)return;
  return serializeCommunity(`${guild.id}:release`,async()=>{
    try{await renumberAnnouncements(ctx,guild);}catch(error){ctx.store.setSetting('release:renumber:error',String(error.code||error.name));}
    const description=`De bot is bijgewerkt.\n\n${(notes||['Onderhoud en verbeteringen.']).map(item=>`• ${item}`).join('\n\n')}`;
    const contentKey=`release:content:${version}`,contentHash=createHash('sha256').update(JSON.stringify([ctx.config.updateChannelId,version,description])).digest('hex');
    const saved=ctx.store.db.prepare('SELECT message_id FROM release_announcements WHERE version=?').get(version)?.message_id;
    if(saved&&ctx.store.setting(contentKey)===contentHash)return;
    ctx.store.db.prepare('INSERT OR IGNORE INTO release_announcements(version) VALUES(?)').run(version);
    try{const channel=await communityChannel(guild,ctx.config.updateChannelId),marker=`Bakarov • Botupdate ${version}`;
      let message=saved?await channel.messages.fetch(saved).catch(error=>{if(error.code===10008)return null;throw error;}):null;
      if(saved&&!message){ctx.store.db.prepare("UPDATE release_announcements SET last_error='MESSAGE_DELETED' WHERE version=?").run(version);ctx.store.setSetting(contentKey,contentHash);return;}
      if(!message){const history=await channel.messages.fetch({limit:100});message=[...history.values()].find(item=>item.author.id===guild.members.me.id&&item.embeds?.some(card=>canonicalBrandText(card.footer?.text)===marker));}
      if(message&&(message.author.id!==guild.members.me.id||!message.embeds?.some(card=>canonicalBrandText(card.footer?.text)===marker)))throw Object.assign(new Error('Het opgeslagen bericht hoort niet bij deze botupdate.'),{code:'RELEASE_MESSAGE_MISMATCH'});
      const payload={embeds:[embed(ctx.config,`Bakarov — Botupdate ${version}`,description).setColor(0x22C55E).setFooter({text:marker})],allowedMentions:quiet};
      message=message?await editIfChanged(message,payload):await channel.send({...payload,nonce:`up:${version}`,enforceNonce:true});
      ctx.store.db.prepare('UPDATE release_announcements SET message_id=?,last_error=NULL WHERE version=?').run(message.id,version);ctx.store.setSetting(contentKey,contentHash);ctx.store.audit('bot.update',guild.members.me.id,{version});
    }catch(error){ctx.store.db.prepare('UPDATE release_announcements SET last_error=? WHERE version=?').run(String(error.code||error.name),version);}
  });
}
