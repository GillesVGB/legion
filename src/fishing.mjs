import {missionDay} from './mission-definitions.mjs';
export function fishWeek(now=Date.now()){const day=missionDay(now),date=new Date(day+'T12:00:00Z'),offset=(date.getUTCDay()+6)%7;return missionDay(date.getTime()-offset*86400000);}
export const catches = [
  { weight: 25, kind: 'good', icon: '🐟', title: 'Een mooie vangst!', text: 'Je haalt een dikke zalm uit het water. De barbecue van Legion is geregeld!' },
  { weight: 15, kind: 'good', icon: '🦞', title: 'Kreeft gevangen!', text: 'Je vangt een kreeft en houdt hem nét ver genoeg van je vingers. Lekker voor het avondeten.' },
  { weight: 10, kind: 'good', icon: '💍', title: 'Schat gevonden!', text: 'Tussen het zeewier vind je een glimmende ring. Vandaag heb jij geluk!' },
  { weight: 5, kind: 'good', icon: '🏆', title: 'Legendarische vangst!', text: 'Je vist een kist met een gouden Legion-trofee op. De hele gang wil met je op de foto.' },
  { weight: 5, kind: 'good', icon: '🐠', title: 'Bijzondere vis!', text: 'Een kleurrijke vis springt aan je haak. Je maakt een foto en laat hem weer vrij.' },
  { weight: 15, kind: 'bad', icon: '🦞', title: 'AUW! Een kreeft!', text: 'Een kreeft beet je in je vinger! Je laat je hengel vallen en de kreeft loopt er met je aas vandoor.' },
  { weight: 10, kind: 'bad', icon: '🥾', title: 'Een oude laars...', text: 'Je dacht dat je beet had, maar vist een stinkende laars op. Zelfs de vissen lachen je uit.' },
  { weight: 5, kind: 'bad', icon: '🦈', title: 'Hengel kwijt!', text: 'Een haai grijpt je aas en trekt je hengel het water in. Tijd voor een nieuwe hobby?' },
  { weight: 5, kind: 'bad', icon: '🪼', title: 'Kwallenalarm!', text: 'Je vangt een kwal. Die prikt je voordat je hem teruggooit. Geen vangst, wel een zere hand.' },
  { weight: 5, kind: 'neutral', icon: '🌊', title: 'Geen beet', text: 'Je dobber blijft stil. Wel een mooi uitzicht en vijf minuten rust van de gang.' }
];
const rewards = [25, 55, 150, 500, 100, -40, -20, -100, -50, 0];
const rarities = ['Gewoon', 'Ongewoon', 'Zeldzaam', 'Legendarisch', 'Zeldzaam', 'Slecht', 'Slecht', 'Slecht', 'Slecht', 'Geen vangst'];
catches.forEach((item, index) => { item.coins = rewards[index]; item.rarity = rarities[index];item.id=['salmon','lobster','ring','trophy','colorfish','bite','boot','shark','jellyfish','empty'][index]; });
export function fishCatch(roll) {
  if (!Number.isInteger(roll) || roll < 0 || roll >= 100) throw new RangeError('Kies een vangstworp van 0 tot 99.');
  let boundary = 0;
  return catches.find(item => { boundary += item.weight; return roll < boundary; });
}
