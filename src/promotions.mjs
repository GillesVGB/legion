import { randomBytes } from 'node:crypto';
import { ButtonStyle,MessageFlags,PermissionFlagsBits as P } from 'discord.js';
import { assertUser,UserError } from './errors.mjs';
import { embed,row,button,safeText } from './ui.mjs';
import { quiet,isStaff,requireStaff } from './service.mjs';
import { communityChannel,serializeCommunity,updateCommunityPost } from './community-posts.mjs';

export const promotionById=(ctx,id)=>ctx.store.db.prepare('SELECT * FROM promotions WHERE id=?').get(id);
export function promotionMessage(ctx,proposal) {
  const labels={pending:'Wacht op goedkeuring',approving:'Wordt uitgevoerd',approved:'Goedgekeurd',rejected:'Afgewezen'};
  const card=embed(ctx.config,'Legion — Promotievoorstel',`**Lid:** <@${proposal.member_id}>\n**Voorgestelde rang:** <@&${proposal.role_id}>\n**Voorgesteld door:** <@${proposal.proposer_id}>\n\n**Motivatie**\n${safeText(proposal.reason)}\n\n**Status:** ${labels[proposal.status]||proposal.status}${proposal.approver_id?`\n**Beoordeeld door:** <@${proposal.approver_id}>`:''}`).setColor(proposal.status==='approved'?0x22C55E:proposal.status==='rejected'?0xEF4444:0xF59E0B).setFooter({text:`Legion • Promotie ${proposal.id}`});
  return {embeds:[card],components:proposal.status==='pending'?[row(button(`promotion:approve:${proposal.id}`,'Goedkeuren',ButtonStyle.Success),button(`promotion:reject:${proposal.id}`,'Afwijzen',ButtonStyle.Danger))]:[],allowedMentions:quiet};
}
async function validatePromotion(ctx,guild,memberId,roleId,actor,resuming=false) {
  const ranks=ctx.config.roster?.roleIds;
  assertUser(ranks?.includes(roleId),'Kies een gangrang in de hoofdserver van Legion.');
  const role=await guild.roles.fetch(roleId),member=await guild.members.fetch({user:memberId,force:true});
  assertUser(member&&!member.user.bot&&member.roles.cache.has(ctx.config.memberRoleId),'Kies een echt Legion-lid met de ledenrol.');
  assertUser(role&&!role.managed&&!role.permissions.has(P.Administrator),'Deze rol is niet geschikt als promotierang.');
  assertUser(guild.members.me.permissions.has(P.ManageRoles)&&guild.members.me.roles.highest.comparePositionTo(role)>0&&guild.members.me.roles.highest.comparePositionTo(member.roles.highest)>0,'De bot kan deze rang niet aanpassen. Controleer Rollen beheren en de rolvolgorde.');
  const current=ranks.findIndex(id=>member.roles.cache.has(id)),target=ranks.indexOf(roleId);
  assertUser((resuming&&member.roles.cache.has(roleId))||current<0||target<current,'Kies een hogere rang dan de huidige hoogste gangrang.');
  if(actor&&!actor.permissions.has(P.Administrator)) {
    assertUser(!member.permissions.has(P.Administrator)&&actor.roles.highest.comparePositionTo(member.roles.highest)>0&&actor.roles.highest.comparePositionTo(role)>0,'Je kunt alleen een lid en rang onder jouw eigen rol beheren.');
  }
  return {member,role};
}
export async function publishPromotion(ctx,guild,id) {
  return serializeCommunity(`${guild.id}:promotion:${id}`,async()=>{
    const proposal=promotionById(ctx,id);assertUser(proposal,'Dit promotievoorstel bestaat niet.');
    return updateCommunityPost(ctx,guild,'promotions',proposal,promotionMessage(ctx,proposal),`Legion • Promotie ${id}`);
  });
}
export async function createPromotion(ctx,interaction,input) {
  const staff=isStaff(interaction,ctx.config);
  assertUser(staff||interaction.member.roles.cache.has(ctx.config.memberRoleId),'Alleen Legion-leden en de leiding kunnen een promotie voorstellen.');
  assertUser(staff||input.memberId===interaction.user.id,'Je kunt alleen voor jezelf een promotie aanvragen. De leiding kan voorstellen voor andere leden maken.');
  const reason=input.reason?.trim();assertUser(reason&&reason.length<=500,'Geef een duidelijke motivatie van maximaal 500 tekens.');
  await validatePromotion(ctx,interaction.guild,input.memberId,input.roleId);
  const channel=await communityChannel(interaction.guild,input.channelId||interaction.channelId);
  assertUser(channel.permissionsFor(interaction.guild.members.me)?.has(P.EmbedLinks),'De bot heeft Links insluiten nodig in dit kanaal.');
  const id=randomBytes(6).toString('hex');
  ctx.store.transaction(()=>{
    assertUser(!ctx.store.db.prepare("SELECT id FROM promotions WHERE member_id=? AND status IN ('pending','approving')").get(input.memberId),'Er staat al een open promotievoorstel voor dit lid.');
    ctx.store.db.prepare('INSERT INTO promotions(id,member_id,role_id,proposer_id,reason,created_at,channel_id) VALUES(?,?,?,?,?,?,?)').run(id,input.memberId,input.roleId,interaction.user.id,reason,Date.now(),channel.id);
    ctx.store.audit('promotion.propose',interaction.user.id,{id,member:input.memberId,role:input.roleId});
  });
  const posted=await publishPromotion(ctx,interaction.guild,id).catch(error=>{ctx.store.db.prepare('UPDATE promotions SET last_error=?,next_attempt=? WHERE id=?').run(String(error.code||error.name),Date.now()+60000,id);return null;});
  return {id,posted};
}
export async function decidePromotion(ctx,guild,actor,id,decision,source) {
  requireStaff({member:actor,memberPermissions:actor.permissions},ctx.config);
  assertUser(['approve','reject'].includes(decision),'Kies goedkeuren of afwijzen.');
  return serializeCommunity(`${guild.id}:promotion:${id}`,async()=>{
    const proposal=promotionById(ctx,id);assertUser(proposal?.status==='pending','Dit voorstel is al beoordeeld of wordt al uitgevoerd.');
    if(source)assertUser(source.channelId===proposal.channel_id&&source.messageId===proposal.message_id,'Gebruik de knoppen onder het oorspronkelijke promotievoorstel.');
    assertUser(proposal.proposer_id!==actor.id||actor.permissions.has(P.Administrator),'Laat een ander leidinglid je voorstel beoordelen. Een administrator kan dit zelf afhandelen.');
    if(decision==='approve') {
      const {member}=await validatePromotion(ctx,guild,proposal.member_id,proposal.role_id,actor);
      ctx.store.db.prepare("UPDATE promotions SET status='approving',approver_id=?,dirty=1,next_attempt=0 WHERE id=?").run(actor.id,id);
      try { await member.roles.set([...member.roles.cache.keys()].filter(roleId=>roleId!==guild.id&&!ctx.config.roster.roleIds.includes(roleId)).concat(proposal.role_id),`Legion promotie ${id}: goedgekeurd door ${actor.id}`); }
      catch(error){
        const knownFailure=[50013,50001,10007,10011].includes(error.code);
        if(knownFailure)ctx.store.db.prepare("UPDATE promotions SET status='pending',approver_id=NULL,last_error=? WHERE id=?").run(String(error.code||error.name),id);
        else ctx.store.db.prepare('UPDATE promotions SET next_attempt=?,last_error=? WHERE id=?').run(Date.now()+60000,String(error.code||error.name),id);
        if(knownFailure)throw error;
        return promotionById(ctx,id);
      }
    }
    ctx.store.transaction(()=>{
      ctx.store.db.prepare('UPDATE promotions SET status=?,approver_id=?,closed_at=?,dirty=1,next_attempt=0 WHERE id=?').run(decision==='approve'?'approved':'rejected',actor.id,Date.now(),id);
      ctx.store.audit(`promotion.${decision==='approve'?'approved':'rejected'}`,actor.id,{id,member:proposal.member_id,role:proposal.role_id});
    });
    const finished=promotionById(ctx,id);
    await updateCommunityPost(ctx,guild,'promotions',finished,promotionMessage(ctx,finished),`Legion • Promotie ${id}`).catch(()=>{});
    return finished;
  });
}
export async function handlePromotionButton(ctx,interaction) {
  requireStaff(interaction,ctx.config);await interaction.deferReply({flags:MessageFlags.Ephemeral});
  const [,decision,id]=interaction.customId.split(':');
  const actor=await interaction.guild.members.fetch({user:interaction.user.id,force:true});
  const result=await decidePromotion(ctx,interaction.guild,actor,id,decision,{channelId:interaction.channelId,messageId:interaction.message.id});
  return interaction.editReply({content:result.status==='approved'?'De promotie is goedgekeurd en de gangrang is aangepast. De ledenlijst werkt automatisch bij.':result.status==='approving'?'Het voorstel wordt verwerkt. De bot controleert de rang automatisch opnieuw zodra Discord bereikbaar is.':'Het promotievoorstel is afgewezen. De huidige rang blijft behouden.',allowedMentions:quiet});
}
export async function handlePromotionCommand(ctx,interaction) {
  await interaction.deferReply({flags:MessageFlags.Ephemeral});
  const result=await createPromotion(ctx,interaction,{memberId:interaction.options.getUser('lid',true).id,roleId:interaction.options.getRole('rang',true).id,reason:interaction.options.getString('motivatie',true),channelId:interaction.options.getChannel('kanaal')?.id});
  return interaction.editReply({content:`Promotievoorstel \`${result.id}\` is opgeslagen.${result.posted?' De leiding kan het met de knoppen beoordelen.':' Het voorstel wordt automatisch geplaatst zodra het kanaal bereikbaar is.'}`,allowedMentions:quiet});
}
export async function syncPromotions(ctx,guild,now=Date.now()) {
  for(const item of ctx.store.db.prepare("SELECT * FROM promotions WHERE status='approving' AND next_attempt<=? LIMIT 10").all(now)){
    await serializeCommunity(`${guild.id}:promotion:${item.id}`,async()=>{
      try {
        const current=promotionById(ctx,item.id);if(current.status!=='approving')return;
        const actor=await guild.members.fetch({user:item.approver_id,force:true});
        requireStaff({member:actor,memberPermissions:actor.permissions},ctx.config);
        const {member}=await validatePromotion(ctx,guild,item.member_id,item.role_id,actor,true);
        await member.roles.set([...member.roles.cache.keys()].filter(roleId=>roleId!==guild.id&&!ctx.config.roster.roleIds.includes(roleId)).concat(item.role_id),`Legion promotie ${item.id}: herstel na herstart`);
        ctx.store.transaction(()=>{ctx.store.db.prepare("UPDATE promotions SET status='approved',closed_at=?,dirty=1,next_attempt=0 WHERE id=?").run(now,item.id);ctx.store.audit('promotion.approved',item.approver_id,{id:item.id,recovered:true});});
      }catch(error){
        if(error instanceof UserError||[50013,50001,10007,10011].includes(error.code))ctx.store.db.prepare("UPDATE promotions SET status='pending',approver_id=NULL,dirty=1,last_error=? WHERE id=?").run(String(error.code||error.name),item.id);
        else ctx.store.db.prepare('UPDATE promotions SET next_attempt=?,last_error=? WHERE id=?').run(now+60000,String(error.code||error.name),item.id);
      }
    });
  }
  for(const item of ctx.store.db.prepare('SELECT id FROM promotions WHERE dirty=1 AND next_attempt<=? LIMIT 10').all(now)){
    try{await publishPromotion(ctx,guild,item.id);}catch(error){ctx.store.db.prepare('UPDATE promotions SET last_error=?,next_attempt=? WHERE id=?').run(String(error.code||error.name),now+60000,item.id);}
  }
}
