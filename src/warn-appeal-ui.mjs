import {ActionRowBuilder,ButtonBuilder,ButtonStyle} from 'discord.js';
const appealButton=(guild,id,label='Bezwaar maken')=>new ButtonBuilder().setCustomId(`warnappeal:start:${guild}:${id}`).setLabel(label).setStyle(ButtonStyle.Secondary);
export const warnAppealRow=(guild,id)=>new ActionRowBuilder().addComponents(appealButton(guild,id));
export function warnAppealRows(guild,warnings){
  const active=warnings.filter(item=>item.removed_at===null).slice(0,25),rows=[];
  for(let i=0;i<active.length;i+=5)rows.push(new ActionRowBuilder().addComponents(active.slice(i,i+5).map(item=>appealButton(guild,item.id,`Bezwaar · ${item.id}`))));
  return rows;
}
