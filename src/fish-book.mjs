import {ButtonStyle} from 'discord.js';
import {catches} from './fishing.mjs';
import {embed,row,button} from './ui.mjs';
import {assertUser} from './errors.mjs';
import {operationSettings} from './feature-settings.mjs';
import {quiet} from './service.mjs';
export function fishBookMessage(ctx,user,now=Date.now()){
  const book=ctx.store.fishBook(user,now),settings=operationSettings(ctx).fishing;
  const card=embed(ctx.config,'Legion — Vangstenboek',`<@${user}> · Week vanaf ${book.week}\nVis met /fish om je verzameling en weekchallenges uit te breiden. Nieuwe challenges starten maandag om 00:00 Belgische tijd. De beloningen zijn fictieve Discord-coins.`);
  if(settings.collectionEnabled)for(const caught of catches.filter(item=>item.kind==='good')){const item=book.collection.find(item=>item.catch_id===caught.id);card.addFields({name:`${caught.icon} ${caught.title}`,value:`${caught.rarity} · ${item?`${item.amount}× gevangen`:'Nog niet gevonden'}`});}
  if(settings.weeklyEnabled){card.addFields({name:'🎣 Weekchallenge',value:`${book.progress.total}/${book.settings.target} goede vangsten · ${book.settings.reward} coins${book.claimed.includes('total')?' · ✅ ontvangen':''}`},{name:'💎 Zeldzame vangsten',value:`${book.progress.rare}/${book.settings.rare_target} zeldzame/legendarische vangsten · ${book.settings.rare_reward} coins${book.claimed.includes('rare')?' · ✅ ontvangen':''}`});}
  const available=settings.weeklyEnabled&&((book.progress.total>=book.settings.target&&!book.claimed.includes('total'))||(book.progress.rare>=book.settings.rare_target&&!book.claimed.includes('rare')));
  return{embeds:[card],components:settings.weeklyEnabled?[row(button(`fishbook:claim:${user}:${book.week}`,'Weekbeloning claimen',ButtonStyle.Success).setDisabled(!available))]:[],allowedMentions:quiet};
}
export async function handleFishBookButton(ctx,interaction){const [,action,user,week]=interaction.customId.split(':');assertUser(action==='claim'&&user===interaction.user.id,'Gebruik /vangstenboek voor je eigen verzameling.');await interaction.deferReply();const result=ctx.store.claimFishWeek(user,week);await interaction.message.edit(fishBookMessage(ctx,user)).catch(()=>{});return interaction.editReply({content:`Je ontvangt **${result.reward} coins**. Saldo: **${result.balance}**.`,allowedMentions:quiet});}
