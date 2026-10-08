import { MessageFlags } from 'discord.js';
import { assertUser } from './errors.mjs';
import { embed } from './ui.mjs';
import { quiet,isStaff } from './service.mjs';
import { applicationWaitingNotice } from './recruitment.mjs';

export function applicationQueue(store) {
  const rows=store.db.prepare("SELECT id FROM cases WHERE kind='application' AND status='open' ORDER BY created_at,id").all();
  return new Map(rows.map((item,index)=>[item.id,{position:index+1,total:rows.length,stage:store.interview(item.id)?'Gesprek ingepland':'Wacht op beoordeling'}]));
}
export function applicationStatusMessage(ctx,dossier) {
  const labels={accepted:'Aangenomen',rejected:'Afgewezen',closed:'Gesloten',failed:'Niet afgerond',creating:'Wordt aangemaakt'};
  const queue=applicationQueue(ctx.store).get(dossier.id);
  const stage=queue?.stage||labels[dossier.status]||'Ontvangen';
  let text=`**Status:** ${stage}\n**Ontvangen:** <t:${Math.floor(dossier.created_at/1000)}:F>`;
  if(queue)text+=`\n**Binnenkomstvolgorde:** plek ${queue.position} van ${queue.total} open sollicitaties.\nDe leiding bepaalt de volgorde van beoordeling.${applicationWaitingNotice(ctx.recruitment)?`\n\n⏳ ${applicationWaitingNotice(ctx.recruitment)}`:''}`;
  if(dossier.status==='accepted')text+='\nJe bent aangenomen! Bekijk je DM of gebruik /uitnodiging voor toegang tot de gangserver.';
  const color=dossier.status==='accepted'?0x22C55E:['rejected','closed','failed'].includes(dossier.status)?0xEF4444:ctx.recruitment?.color??0xF59E0B;
  return {embeds:[embed(ctx.config,'Legion — Jouw sollicitatie',text).setColor(color)],allowedMentions:quiet};
}
export async function showApplicationStatus(ctx,interaction,id) {
  const dossier=id?ctx.store.caseById(id):ctx.store.decodeCase(ctx.store.db.prepare("SELECT * FROM cases WHERE kind='application' AND owner_id=? ORDER BY (status='open') DESC,created_at DESC LIMIT 1").get(interaction.user.id));
  assertUser(dossier?.kind==='application','Je hebt in deze server nog geen sollicitatie ingediend. Gebruik /solliciteren om een ticket te openen.');
  assertUser(dossier.owner_id===interaction.user.id||isStaff(interaction,ctx.config),'Deze sollicitatiestatus is alleen voor de sollicitant en de leiding.');
  await interaction.reply({...applicationStatusMessage(ctx,dossier),flags:MessageFlags.Ephemeral});
}
