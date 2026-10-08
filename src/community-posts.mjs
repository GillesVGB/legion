import { ChannelType,PermissionFlagsBits as P } from 'discord.js';
import { assertUser } from './errors.mjs';
import { quiet } from './service.mjs';

const jobs=new Map();
export async function serializeCommunity(key,action) {
  const previous=jobs.get(key)||Promise.resolve();
  const job=previous.catch(()=>{}).then(action); jobs.set(key,job);
  try{return await job;}finally{if(jobs.get(key)===job)jobs.delete(key);}
}
export async function communityChannel(guild,id) {
  const channel=await guild.channels.fetch(id);
  assertUser(channel?.guildId===guild.id&&channel.type===ChannelType.GuildText,'Kies een tekstkanaal in deze server.');
  assertUser(channel.permissionsFor(guild.members.me)?.has([P.ViewChannel,P.SendMessages,P.ReadMessageHistory]),'De bot heeft Kanaal bekijken, Berichten versturen en Berichtgeschiedenis lezen nodig.');
  return channel;
}
export async function updateCommunityPost(ctx,guild,table,item,payload,marker) {
  assertUser(['activities','promotions'].includes(table),'Onbekend onderdeel.');
  const channel=await communityChannel(guild,item.channel_id);
  let message=item.message_id?await channel.messages.fetch(item.message_id).catch(error=>{if(error.code===10008)return null;throw error;}):null;
  if(!message&&!item.message_id) {
    // Herstel een verstuurd bericht als de bot vóór het bewaren van het ID herstartte.
    let before;
    for(let page=0;page<10;page++) {
      const history=await channel.messages.fetch({limit:100,...(before?{before}:{})});
      message=[...history.values()].find(message=>message.author.id===guild.members.me.id&&
        (message.content?.includes(marker)||message.embeds?.some(card=>card.footer?.text===marker)));
      if(message||history.size<100)break;
      before=history.last().id;
    }
  }
  if(item.message_id&&!message) {
    ctx.store.db.prepare(`UPDATE ${table} SET dirty=0,last_error='MESSAGE_DELETED' WHERE id=?`).run(item.id);
    return null; // Een bewust verwijderd bericht wordt niet opnieuw geplaatst.
  }
  assertUser(!message||message.author.id===guild.members.me.id,'Dit bericht hoort niet bij de Legion-bot.');
  const posted=message?await message.edit({...payload,allowedMentions:quiet}):await channel.send({...payload,nonce:`${table}:${item.id}`,enforceNonce:true,allowedMentions:quiet});
  ctx.store.db.prepare(`UPDATE ${table} SET message_id=?,dirty=0,next_attempt=0,last_error=NULL WHERE id=?`).run(posted.id,item.id);
  return posted;
}
