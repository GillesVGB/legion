export const missions = [
  { id: 'fishing', kind: 'fish', title: 'Aan de waterkant', description: 'Ga vijf keer vissen met /fish.', target: 5, reward: 175 },
  { id: 'blackjack', kind: 'blackjack', title: 'Kaarten op tafel', description: 'Rond één blackjackspel af, ongeacht de uitslag.', target: 1, reward: 200 },
  { id: 'daily', kind: 'daily', title: 'Dagelijkse check-in', description: 'Claim je dagelijkse coins met /daily.', target: 1, reward: 100 }
];
export const missionDay = (now = Date.now()) => {
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Brussels', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(now)).map(part=>[part.type,part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
};
