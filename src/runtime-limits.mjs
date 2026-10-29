import {Options} from 'discord.js';

export const runtimeLimits=Object.freeze({messagesPerChannel:25,totalMessages:500,reactionUsers:25,users:512,messageLifetimeSeconds:900});

// Keep member, role and channel caches intact: attendance and gangpot decisions use them.
export function createRuntimeClientOptions(){
  return{
    makeCache:Options.cacheWithLimits({
      ...Options.DefaultMakeCacheSettings,
      MessageManager:runtimeLimits.messagesPerChannel,
      ReactionUserManager:runtimeLimits.reactionUsers,
      UserManager:{maxSize:runtimeLimits.users,keepOverLimit:user=>user.id===user.client?.user?.id},
      GuildBanManager:0,
      GuildInviteManager:0,
      GuildScheduledEventManager:0
    }),
    sweepers:{...Options.DefaultSweeperSettings,messages:{interval:60,lifetime:runtimeLimits.messageLifetimeSeconds}},
    rest:{handlerSweepInterval:60000,hashSweepInterval:300000,hashLifetime:3600000}
  };
}

// Per-channel limits alone still grow with the number of channels. Apply a global budget too.
export function pruneRuntimeCaches(client,{maxMessages=runtimeLimits.totalMessages}={}){
  if(!Number.isSafeInteger(maxMessages)||maxMessages<0)throw new RangeError('maxMessages moet een positief geheel getal of nul zijn.');
  const messages=[];
  for(const channel of client.channels.cache.values()){
    const cache=channel.messages?.cache;
    if(!cache)continue;
    for(const [id,message]of cache)messages.push({cache,id,timestamp:message.editedTimestamp??message.createdTimestamp??0});
  }
  if(messages.length<=maxMessages)return 0;
  messages.sort((a,b)=>a.timestamp-b.timestamp);
  let removed=0;
  for(let index=0;index<messages.length-maxMessages;index++){
    const {cache,id}=messages[index];
    if(cache.delete(id))removed++;
  }
  return removed;
}

export function startRuntimeCacheMaintenance(client){
  const timer=setInterval(()=>pruneRuntimeCaches(client),60000);
  timer.unref();
  return()=>clearInterval(timer);
}
