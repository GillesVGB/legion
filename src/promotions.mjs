import { randomBytes } from 'node:crypto';
import { ButtonStyle,MessageFlags,PermissionFlagsBits as P } from 'discord.js';
import { assertUser,UserError } from './errors.mjs';
import { embed,row,button,safeText } from './ui.mjs';
import { quiet,isStaff } from './service.mjs';
import { communityChannel,serializeCommunity,updateCommunityPost } from './community-posts.mjs';

export const PROMOTION_LEAD_ROLE_ID='1555685630707769382';
export const PROMOTION_MINIMUM_VOTES=3;
export const promotionById=(ctx,id)=>ctx.store.db.prepare('SELECT * FROM promotions WHERE id=?').get(id);
export function promotionVotes(ctx,id) {
  const votes=ctx.store.db.prepare('SELECT voter_id,response FROM promotion_votes WHERE proposal_id=? ORDER BY updated_at,voter_id').all(id);
  const approve=votes.filter(vote=>vote.response==='approve').length,reject=votes.length-approve;
  return {approve,reject,total:votes.length,remaining:Math.max(0,PROMOTION_MINIMUM_VOTES-votes.length),votes};
}
export function promotionMessage(ctx,proposal) {
  const labels={pending:'Stemming open',approving:'Meerderheid voor — promotie wordt uitgevoerd',approved:'Goedgekeurd door de meerderheid',rejected:'Afgekeurd door de meerderheid'};
  const count=promotionVotes(ctx,proposal.id);
  const progress=count.total<3?`Nog **${count.remaining}** unieke Lead-stem${count.remaining===1?'':'men'} nodig.`:count.approve===count.reject?'De stemmen zijn gelijk. Een extra Lead-stem is nodig.':'';
  const card=embed(ctx.config,'Legion — Promotievoorstel',`**Lid:** <@${proposal.member_id}>\n**Voorgestelde rang:** <@&${proposal.role_id}>\n**Voorgesteld door:** <@${proposal.proposer_id}>\n\n**Motivatie**\n${safeText(proposal.reason)}\n\n**Stemmen:** 🟢 ${count.approve} goedkeuren · 🔴 ${count.reject} afkeuren\n${progress}\n**Status:** ${labels[proposal.status]||proposal.status}\n\nAlleen leden met de Lead-rol kunnen stemmen. Elk lid heeft één stem. Vanaf drie Lead-stemmen bepaalt de meerderheid de uitslag.${proposal.status==='approving'&&proposal.last_error?`\n\nDe uitslag staat vast. Uitvoeren wordt opnieuw geprobeerd: ${safeText(proposal.last_error)}.`:''}`).setColor(proposal.status==='approved'?0x22C55E:proposal.status==='rejected'?0xEF4444:0xF59E0B).setFooter({text:`Legion • Promotie ${proposal.id}`});
  return {embeds:[card],components:proposal.status==='pending'?[row(button(`promotion:approve:${proposal.id}`,'Goedkeuren',ButtonStyle.Success),button(`promotion:reject:${proposal.id}`,'Afkeuren',ButtonStyle.Danger))]:[],allowedMentions:quiet};
}
async function validatePromotion(ctx,guild,memberId,roleId,resuming=false) {
  const ranks=ctx.config.roster?.roleIds;
  assertUser(ranks?.includes(roleId),'Kies een gangrang in de hoofdserver van Legion.');
  await Promise.all([guild.roles.fetch(),guild.members.fetchMe({force:true})]);
  const role=guild.roles.cache.get(roleId),member=await guild.members.fetch({user:memberId,force:true});
  assertUser(member&&!member.user.bot&&member.roles.cache.has(ctx.config.memberRoleId),'Kies een echt Legion-lid met de ledenrol.');
  assertUser(role&&!role.managed&&!role.permissions.has(P.Administrator),'Deze rol is niet geschikt als promotierang.');
  const current=ranks.findIndex(id=>member.roles.cache.has(id)),target=ranks.indexOf(roleId);
  assertUser(resuming||!member.roles.cache.has(roleId),'Dit lid heeft de gekozen gangrang al. Kies een hogere rang.');
  assertUser(current<0||target<current||(resuming&&current===target),'Kies een hogere rang dan de huidige hoogste gangrang.');
  const bot=guild.members.me;
  assertUser(bot.permissions.has(P.ManageRoles),'De bot mist Rollen beheren. Geef deze permissie aan de botrol.');
  assertUser(bot.roles.highest.comparePositionTo(role)>0,`Plaats de botrol ${safeText(bot.roles.highest.name)} boven de gangrang ${safeText(role.name)}.`);
  for(const id of ranks.filter(id=>id!==roleId&&member.roles.cache.has(id))) {
    const old=guild.roles.cache.get(id);
    assertUser(old&&!old.managed&&bot.roles.highest.comparePositionTo(old)>0,`De huidige gangrang ${safeText(old?.name||id)} kan niet worden verwijderd. Plaats de botrol daarboven.`);
  }
  return {member,role};
}
async function applyGangRank(ctx,guild,proposal) {
  const {member}=await validatePromotion(ctx,guild,proposal.member_id,proposal.role_id,true);
  const previous=ctx.config.roster.roleIds.filter(id=>id!==proposal.role_id&&member.roles.cache.has(id));
  // Alleen de bedoelde gangrollen worden aangepast via idempotente role-endpoints.
  if(!member.roles.cache.has(proposal.role_id))await member.roles.add(proposal.role_id,`Legion promotie ${proposal.id}: meerderheid van minstens drie Lead-leden`);
  for(const id of previous)await member.roles.remove(id,`Legion promotie ${proposal.id}: oude gangrang vervangen`);
}
async function eligibleVotes(ctx,guild,id) {
  for(const vote of promotionVotes(ctx,id).votes) {
    const member=await guild.members.fetch({user:vote.voter_id,force:true}).catch(error=>{if(error.code===10007)return null;throw error;});
    if(!member||member.user.bot||!member.roles.cache.has(PROMOTION_LEAD_ROLE_ID))ctx.store.db.prepare('DELETE FROM promotion_votes WHERE proposal_id=? AND voter_id=?').run(id,vote.voter_id);
  }
  return promotionVotes(ctx,id);
}
async function finishApproved(ctx,guild,id,now=Date.now()) {
  const proposal=promotionById(ctx,id),count=promotionVotes(ctx,id);
  if(count.total<3||count.approve<=count.reject){
    ctx.store.db.prepare("UPDATE promotions SET status='pending',approver_id=NULL,dirty=1,next_attempt=0 WHERE id=?").run(id);
    return promotionById(ctx,id);
  }
  try {
    await applyGangRank(ctx,guild,proposal);
    ctx.store.transaction(()=>{
      ctx.store.db.prepare("UPDATE promotions SET status='approved',closed_at=?,dirty=1,next_attempt=0,last_error=NULL WHERE id=?").run(now,id);
      ctx.store.audit('promotion.approved',proposal.approver_id,{id,member:proposal.member_id,role:proposal.role_id,approve:count.approve,reject:count.reject,voters:count.votes.map(vote=>vote.voter_id)});
    });
  }catch(error){
    const reason=error instanceof UserError?error.message:String(error.code||error.name);
    ctx.store.db.prepare('UPDATE promotions SET dirty=1,next_attempt=?,last_error=? WHERE id=?').run(now+60000,reason,id);
  }
  return promotionById(ctx,id);
}
async function resolvePending(ctx,guild,id,actor,now=Date.now()) {
  const count=await eligibleVotes(ctx,guild,id);
  if(count.total<3||count.approve===count.reject)return promotionById(ctx,id);
  if(count.reject>count.approve) {
    ctx.store.transaction(()=>{
      ctx.store.db.prepare("UPDATE promotions SET status='rejected',approver_id=?,closed_at=?,dirty=1,next_attempt=0,last_error=NULL WHERE id=?").run(actor,now,id);
      ctx.store.audit('promotion.rejected',actor,{id,approve:count.approve,reject:count.reject,voters:count.votes.map(vote=>vote.voter_id)});
    });
    return promotionById(ctx,id);
  }
  ctx.store.db.prepare("UPDATE promotions SET status='approving',approver_id=?,dirty=1,next_attempt=0 WHERE id=?").run(actor,id);
  return finishApproved(ctx,guild,id,now);
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
  assertUser(['approve','reject'].includes(decision),'Kies goedkeuren of afkeuren.');
  const voter=await guild.members.fetch({user:actor.id,force:true});
  assertUser(!voter.user.bot&&voter.roles.cache.has(PROMOTION_LEAD_ROLE_ID),'Alleen leden met de Lead-rol kunnen stemmen. Ook administrators moeten deze rol hebben.');
  return serializeCommunity(`${guild.id}:promotion:${id}`,async()=>{
    const proposal=promotionById(ctx,id);assertUser(proposal?.status==='pending','Dit voorstel is al beoordeeld of wordt al uitgevoerd.');
    if(source)assertUser(source.channelId===proposal.channel_id&&source.messageId===proposal.message_id,'Gebruik de knoppen onder het oorspronkelijke promotievoorstel.');
    ctx.store.transaction(()=>{
      const previous=ctx.store.db.prepare('SELECT response FROM promotion_votes WHERE proposal_id=? AND voter_id=?').get(id,voter.id);
      ctx.store.db.prepare('INSERT INTO promotion_votes(proposal_id,voter_id,response,updated_at) VALUES(?,?,?,?) ON CONFLICT(proposal_id,voter_id) DO UPDATE SET response=excluded.response,updated_at=excluded.updated_at').run(id,voter.id,decision,Date.now());
      ctx.store.db.prepare('UPDATE promotions SET dirty=1,next_attempt=0 WHERE id=?').run(id);
      if(previous?.response!==decision)ctx.store.audit('promotion.vote',voter.id,{id,response:decision});
    });
    const result=await resolvePending(ctx,guild,id,voter.id);
    await updateCommunityPost(ctx,guild,'promotions',result,promotionMessage(ctx,result),`Legion • Promotie ${id}`).catch(()=>{});
    return {...result,voting:promotionVotes(ctx,id)};
  });
}
export function promotionVoteReply(result) {
  const count=result.voting;
  if(result.status==='approved')return `De meerderheid keurt de promotie goed (${count.approve} voor, ${count.reject} tegen). De gangrang is aangepast.`;
  if(result.status==='rejected')return `De meerderheid keurt de promotie af (${count.approve} voor, ${count.reject} tegen). De huidige rang blijft behouden.`;
  if(result.status==='approving')return `De meerderheid keurt de promotie goed. Uitvoeren wordt automatisch opnieuw geprobeerd${result.last_error?`: ${result.last_error}`:'.'}`;
  return `Je stem is opgeslagen: **${count.approve} goedkeuren**, **${count.reject} afkeuren**.${count.remaining?` Nog **${count.remaining}** unieke Lead-stem${count.remaining===1?'':'men'} nodig.`:' De stemmen zijn gelijk; een extra Lead-stem is nodig.'}`;
}
export async function handlePromotionButton(ctx,interaction) {
  await interaction.deferReply({flags:MessageFlags.Ephemeral});
  const [,decision,id]=interaction.customId.split(':');
  const result=await decidePromotion(ctx,interaction.guild,interaction.user,id,decision,{channelId:interaction.channelId,messageId:interaction.message.id});
  return interaction.editReply({content:promotionVoteReply(result),allowedMentions:quiet});
}
export async function handlePromotionCommand(ctx,interaction) {
  await interaction.deferReply({flags:MessageFlags.Ephemeral});
  const result=await createPromotion(ctx,interaction,{memberId:interaction.options.getUser('lid',true).id,roleId:interaction.options.getRole('rang',true).id,reason:interaction.options.getString('motivatie',true)});
  return interaction.editReply({content:`Promotievoorstel \`${result.id}\` is opgeslagen.${result.posted?' Vanaf drie unieke Lead-stemmen bepaalt de meerderheid de uitslag.':' Het voorstel wordt automatisch geplaatst zodra het kanaal bereikbaar is.'}`,allowedMentions:quiet});
}
export async function syncPromotions(ctx,guild,now=Date.now()) {
  const pending=ctx.store.db.prepare("SELECT * FROM promotions WHERE status IN ('pending','approving') AND next_attempt<=? AND (status='approving' OR EXISTS(SELECT 1 FROM promotion_votes WHERE proposal_id=promotions.id)) LIMIT 10").all(now);
  for(const item of pending){
    await serializeCommunity(`${guild.id}:promotion:${item.id}`,async()=>{
      const current=promotionById(ctx,item.id);if(!['pending','approving'].includes(current.status))return;
      try {
        if(current.status==='approving')await finishApproved(ctx,guild,item.id,now);
        else {const votes=promotionVotes(ctx,item.id);await resolvePending(ctx,guild,item.id,votes.votes.at(-1)?.voter_id||item.proposer_id,now);ctx.store.db.prepare('UPDATE promotions SET dirty=1 WHERE id=?').run(item.id);}
      }catch(error){ctx.store.db.prepare('UPDATE promotions SET next_attempt=?,last_error=? WHERE id=?').run(now+60000,String(error.code||error.name),item.id);}
    });
  }
  for(const item of ctx.store.db.prepare('SELECT id FROM promotions WHERE dirty=1 AND next_attempt<=? LIMIT 10').all(now)){
    try{await publishPromotion(ctx,guild,item.id);}catch(error){ctx.store.db.prepare('UPDATE promotions SET last_error=?,next_attempt=? WHERE id=?').run(String(error.code||error.name),now+60000,item.id);}
  }
}
