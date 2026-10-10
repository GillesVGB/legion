import {readFileSync} from 'node:fs';
import {embed} from './ui.mjs';
import {quiet} from './service.mjs';
import {communityChannel,serializeCommunity} from './community-posts.mjs';
export const releaseVersion=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;
export const releaseNotes=JSON.parse(readFileSync(new URL('./release-notes.json',import.meta.url),'utf8'));
export async function announceRelease(ctx,guild,version=releaseVersion,notes=releaseNotes[version]){
  if(!ctx.config.updateChannelId)return;
  return serializeCommunity(`${guild.id}:release`,async()=>{
    if(ctx.store.db.prepare('SELECT message_id FROM release_announcements WHERE version=?').get(version)?.message_id)return;
    ctx.store.db.prepare('INSERT OR IGNORE INTO release_announcements(version) VALUES(?)').run(version);
    try{const channel=await communityChannel(guild,ctx.config.updateChannelId),marker=`Legion • Botupdate ${version}`,history=await channel.messages.fetch({limit:100});let message=[...history.values()].find(item=>item.author.id===guild.members.me.id&&item.embeds?.some(card=>card.footer?.text===marker));
      if(!message)message=await channel.send({embeds:[embed(ctx.config,`Legion — Botupdate ${version}`,`De bot is bijgewerkt.\n\n${(notes||['Onderhoud en verbeteringen.']).map(item=>`• ${item}`).join('\n')}`).setColor(0x22C55E).setFooter({text:marker})],nonce:`up:${version}`,enforceNonce:true,allowedMentions:quiet});
      ctx.store.db.prepare('UPDATE release_announcements SET message_id=?,last_error=NULL WHERE version=?').run(message.id,version);ctx.store.audit('bot.update',guild.members.me.id,{version});
    }catch(error){ctx.store.db.prepare('UPDATE release_announcements SET last_error=? WHERE version=?').run(String(error.code||error.name),version);}
  });
}
