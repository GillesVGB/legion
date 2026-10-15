import {MessageFlags} from 'discord.js';
import {assertUser} from './errors.mjs';
import {embed,safeText} from './ui.mjs';
import {requireStaff,quiet} from './service.mjs';
export const overviewStatus={pending:'Wacht op reactie',responded:'✅ Bevestigd',exempt:'Goedgekeurd afwezig',left:'Niet meer verplicht',warned:'Gangwarn',approved:'Goedgekeurd',rejected:'Afgewezen',cancelled:'Geannuleerd'};
export function memberOverview(ctx,guild,user){
  assertUser(/^\d{17,20}$/.test(user),'Kies een geldig Legion-lid.');
  const db=ctx.store.db,member=guild.members.cache.get(user);
  const checks=db.prepare('SELECT m.*,c.deadline_at,c.status AS check_status,c.created_at FROM activity_check_members m JOIN activity_check_sessions c ON c.id=m.check_id WHERE m.user_id=? ORDER BY c.created_at DESC,c.id DESC LIMIT 12').all(user);
  return{user:{id:user,name:member?.displayName||user,rank:ctx.config.roster?.roleIds.map(id=>guild.roles.cache.get(id)).find(role=>role&&member?.roles.cache.has(role.id))?.name||null},activeWarnings:ctx.store.warnCount(user),checks,
    absences:db.prepare('SELECT a.*,p.title AS activity_title FROM absence_requests a LEFT JOIN activities p ON p.id=a.activity_id WHERE a.user_id=? ORDER BY a.created_at DESC,a.id DESC LIMIT 12').all(user),
    warnings:db.prepare('SELECT * FROM warnings WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 12').all(user)};
}
export async function handleMemberOverview(ctx,interaction){
  requireStaff(interaction,ctx.config);
  const user=interaction.options.getUser('lid',true),data=memberOverview(ctx,interaction.guild,user.id),lines=items=>items.join('\n').slice(0,1000)||'Nog geen gegevens.';
  const card=embed(ctx.config,'Legion — Ledenoverzicht',`**Lid:** <@${user.id}>\n**Rang:** ${safeText(data.user.rank||'Geen gangrang')}\n**Actieve gangwarns:** ${data.activeWarnings}`)
    .addFields({name:'Recente check-ins',value:lines(data.checks.map(item=>`• <t:${Math.floor(item.deadline_at/1000)}:d> · ${item.check_status==='cancelled'?'Geannuleerd':overviewStatus[item.status]||item.status}`))},
      {name:'Recente afmeldingen',value:lines(data.absences.slice(0,8).map(item=>`• ${safeText(item.activity_title||`${item.start_date} t/m ${item.end_date}`)} · ${overviewStatus[item.status]||item.status}`))},
      {name:'Recente gangwarns',value:lines(data.warnings.slice(0,5).map(item=>`• ${item.removed_at?'Ingetrokken':'Actief'} · \`${item.id}\` · ${safeText(item.reason).slice(0,110)}`))});
  return interaction.reply({flags:MessageFlags.Ephemeral,embeds:[card],allowedMentions:quiet});
}
