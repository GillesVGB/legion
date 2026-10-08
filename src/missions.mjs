import { ButtonStyle } from 'discord.js';
import { embed, row, button } from './ui.mjs';
import { assertUser } from './errors.mjs';
import { quiet } from './service.mjs';

export function missionMessage(ctx,user,now=Date.now()) {
  const status=ctx.store.missionStatus(user,now);
  const card=embed(ctx.config,'Legion — Dagelijkse fun-missies',`<@${user}>, speel mee en verdien extra **${ctx.config.content.coinName}**.\nNieuwe missies starten iedere dag om **00:00, Belgische tijd**. Je voortgang wordt automatisch bijgehouden.`).setColor(0x5865F2);
  for(const mission of status.missions)card.addFields({name:`${mission.claimed?'✅':mission.progress>=mission.target?'🎁':'🎯'} ${mission.title}`,value:`${mission.description}\n**Voortgang:** ${mission.progress}/${mission.target} · **Beloning:** ${mission.reward} coins${mission.claimed?'\nBeloning ontvangen.':''}`});
  const claimable=status.missions.some(mission=>mission.progress>=mission.target&&!mission.claimed);
  return {embeds:[card],components:[row(button(`mission:claim:${user}:${status.day}`,'Beloningen claimen',ButtonStyle.Success).setDisabled(!claimable))],allowedMentions:quiet};
}
export async function handleMissionButton(ctx,interaction) {
  const [,action,user,day]=interaction.customId.split(':');
  assertUser(action==='claim'&&user===interaction.user.id,'Deze missiekaart is van iemand anders. Gebruik /missies voor je eigen voortgang.');
  await interaction.deferReply();
  const result=ctx.store.claimMissions(user,day);
  await interaction.message.edit(missionMessage(ctx,user)).catch(()=>{});
  await interaction.editReply({content:`Je hebt **${result.reward} ${ctx.config.content.coinName}** ontvangen. Je nieuwe saldo is **${result.balance}**.`,allowedMentions:quiet});
}
