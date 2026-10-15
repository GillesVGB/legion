import {MessageFlags,PermissionFlagsBits as P} from 'discord.js';
import {assertUser} from './errors.mjs';
import {embed,safeText} from './ui.mjs';
import {quiet,requireStaff,warnLogChannel} from './service.mjs';
import {serializeCommunity} from './community-posts.mjs';
import {refreshMembers} from './members.mjs';
import {approvedAway} from './absence.mjs';
import {activityById,readPlanningReactions,requirePlanningGuild} from './activities.mjs';
import {queueFeatureNotice,deliverFeatureNotices} from './notices.mjs';

export async function checkActivity(ctx,guild,member,id,now=Date.now()){
  requirePlanningGuild(ctx);
  assertUser(guild.id===ctx.config.guildId,'Gebruik de Legion-hoofdserver.');
  const actor=await guild.members.fetch({user:member.id,force:true});
  requireStaff({member:actor,memberPermissions:actor.permissions},ctx.config);
  assertUser(!actor.user.bot,'Alleen de leiding kan activiteiten controleren.');
  return serializeCommunity(`${guild.id}:activity:${id}`,async()=>{
    const activity=activityById(ctx,id);
    assertUser(activity,'Deze planning bestaat niet in deze server.');
    assertUser(activity.status!=='cancelled','Deze planning is geannuleerd; er worden geen gangwarns gegeven.');
    assertUser(now>=activity.starts_at,'Controleer pas vanaf de geplande datum en starttijd.');
    assertUser(ctx.config.memberRoleId,'Stel eerst de Legion-ledenrol in.');
    // Pas na een volledige leden- én reactieverversing mag de check warns opslaan.
    const members=await refreshMembers(guild);
    const {votes}=await readPlanningReactions(ctx,guild,activity);
    const result={activity,total:0,responded:0,exempt:0,alreadyWarned:0,newWarnings:[]};
    ctx.store.transaction(()=>{
      for(const target of members.values()){
        if(target.user.bot||!target.roles.cache.has(ctx.config.memberRoleId)||target.joinedTimestamp>activity.starts_at)continue;
        result.total++;
        if(approvedAway(ctx,activity,target.id)){result.exempt++;continue;}
        if(votes.has(target.id)){result.responded++;continue;}
        if(ctx.store.db.prepare('SELECT 1 FROM activity_check_warnings WHERE activity_id=? AND user_id=?').get(id,target.id)){result.alreadyWarned++;continue;}
        const date=new Date(activity.starts_at).toLocaleString('nl-BE',{timeZone:'Europe/Brussels'});
        const reason=`Niet gereageerd op planning ${activity.title} (${date}, Belgische tijd). Planning-ID: ${id}.`;
        const warning=ctx.store.addWarnInside(target.id,guild.members.me.id,reason,now);
        ctx.store.db.prepare('INSERT INTO activity_check_warnings(activity_id,user_id,warn_id,created_at) VALUES(?,?,?,?)').run(id,target.id,warning.id,now);
        queueFeatureNotice(ctx,{key:`activity.warn:${id}:${target.id}`,kind:'activity.warn',user:target.id,now,payload:{embeds:[embed(ctx.config,'Legion — Gangwarn: planning',`${safeText(reason)}\n\nJe had bij deze controle geen van de vier aanwezigheidsreacties en geen goedgekeurde afmelding.\n**Actieve gangwarns:** ${warning.count}\n**Warn-ID:** \`${warning.id}\`\n[Planning bekijken](https://discord.com/channels/${guild.id}/${activity.channel_id}/${activity.message_id})\nNeem contact op met de leiding als deze waarschuwing niet klopt.`).setColor(0xEF4444)]}});
        result.newWarnings.push({user:target.id,id:warning.id});
      }
      ctx.store.audit('planning.check',actor.id,{activity:id,total:result.total,responded:result.responded,exempt:result.exempt,alreadyWarned:result.alreadyWarned,warnings:result.newWarnings});
    });
    return result;
  });
}

export async function syncActivityWarnings(ctx,guild,now=Date.now()){
  return serializeCommunity(`${guild.id}:activity-warn-notices`,async()=>{
    const db=ctx.store.db;
    for(const item of db.prepare(`SELECT c.*,w.reason,w.removed_at FROM activity_check_warnings c JOIN warnings w ON w.id=c.warn_id
      WHERE c.log_id IS NULL AND c.next_attempt<=? ORDER BY c.created_at LIMIT 30`).all(now)){
      try{
        if(item.removed_at!==null){db.prepare("UPDATE activity_check_warnings SET log_id='skipped',last_error=NULL WHERE warn_id=?").run(item.warn_id);continue;}
        const channel=await warnLogChannel(guild,ctx.config),marker=`Legion • Activiteitencheck ${item.warn_id}`;
        let message;
        if(channel.permissionsFor(guild.members.me)?.has(P.ReadMessageHistory)){
          const history=await channel.messages.fetch({limit:100});
          message=[...history.values()].find(value=>value.author.id===guild.members.me.id&&value.embeds?.some(card=>card.footer?.text===marker));
        }
        const count=ctx.store.warnCount(item.user_id),threshold=count>=ctx.config.warnThreshold?`\n⚠️ Drempel bereikt: ${count}/${ctx.config.warnThreshold}. De leiding moet dit beoordelen.`:'';
        message??=await channel.send({embeds:[embed(ctx.config,'Legion — Automatische gangwarn: planning',`**Lid:** <@${item.user_id}>\n**Reden:** ${safeText(item.reason)}\n**Warn-ID:** \`${item.warn_id}\`\n**Actieve warns:** ${count}${threshold}`).setColor(0xEF4444).setFooter({text:marker})],nonce:`ac:${item.warn_id}`,enforceNonce:true,allowedMentions:quiet});
        db.prepare('UPDATE activity_check_warnings SET log_id=?,last_error=NULL WHERE warn_id=?').run(message.id,item.warn_id);
      }catch(error){db.prepare('UPDATE activity_check_warnings SET next_attempt=?,last_error=? WHERE warn_id=?').run(now+60000,String(error.code||error.name),item.warn_id);}
    }
    await deliverFeatureNotices(ctx,guild,now,item=>{
      const warning=db.prepare("SELECT w.removed_at FROM activity_check_warnings c JOIN warnings w ON w.id=c.warn_id WHERE c.user_id=? AND ? = 'activity.warn:' || c.activity_id || ':' || c.user_id").get(item.user_id,item.notice_key);
      return Boolean(warning&&warning.removed_at===null);
    },['activity.warn']);
  });
}

export async function handleActivitiesCheck(ctx,interaction){
  requireStaff(interaction,ctx.config);
  await interaction.deferReply({flags:MessageFlags.Ephemeral});
  const result=await checkActivity(ctx,interaction.guild,interaction.member,interaction.options.getString('planning',true));
  await syncActivityWarnings(ctx,interaction.guild);
  let content=`## Legion — Activiteitencheck\n**Planning:** ${safeText(result.activity.title)}\n**Gecontroleerde leden:** ${result.total}\n**Gereageerd:** ${result.responded}\n**Goedgekeurd afwezig:** ${result.exempt}\n**Nieuwe gangwarns:** ${result.newWarnings.length}\n**Eerder gewaarschuwd:** ${result.alreadyWarned}\n`;
  for(const item of result.newWarnings){const line=`\n• <@${item.user}> — \`${item.id}\``;if(content.length+line.length>1750){content+='\nDe volledige lijst staat in het gangwarnkanaal en de botlogs.';break;}content+=line;}
  content+='\n\nAlleen Legion-leden worden gecontroleerd. Een van de vier emoji’s telt als reactie. Opnieuw controleren geeft geen dubbele gangwarn.';
  return interaction.editReply({content,allowedMentions:quiet});
}
