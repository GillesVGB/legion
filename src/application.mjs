export const applicationIntro = 'Leuk dat je interesse hebt in Legion! We willen graag wat meer over jou weten. Vul de vragen zo volledig en eerlijk mogelijk in.';
export const applicationThanks = 'Bedankt voor je tijd en moeite. We nemen je sollicitatie zo snel mogelijk door.';
export const applicationGuidance = minimumAge => [
  '**Hoe vergroot je je kans?**',
  `Minimale leeftijd: ${minimumAge} jaar`,
  'Beantwoord alle vragen duidelijk en uitgebreid.',
  'Gebruik volledige zinnen en houd het serieus.',
  'Laat zien dat je actief, gemotiveerd en betrokken bent.',
  'Leg uit wat jij kunt bijdragen aan Legion.',
  'Ervaring met gangs/roleplay is een pluspunt.',
  '',
  'We kijken niet alleen naar je huidige niveau, maar vooral naar jouw motivatie, inzet en toegevoegde waarde.'
].join('\n');
export const applicationSteps = [
  [
    { id: 'name', label: 'Naam', max: 100, placeholder: 'Naam van je RP-personage' },
    { id: 'age', label: 'Leeftijd', max: 40, placeholder: 'Jouw leeftijd' },
    { id: 'playtime', label: 'Playtime', max: 100, placeholder: 'Je speeltijd in FiveM / Future RP' },
    { id: 'vehicles', label: 'Voertuigen', max: 300, paragraph: true, placeholder: 'Welke voertuigen bezit je in RP?' },
    { id: 'money', label: 'Geld', max: 100, placeholder: 'Hoeveel geld bezit je in RP?' }
  ],
  [
    { id: 'weapons', label: 'Wapens', max: 300, paragraph: true, placeholder: 'Welke wapens bezit je in RP?' },
    { id: 'owExperience', label: 'OW-ervaring', max: 500, paragraph: true, placeholder: 'Vertel over jouw OW-ervaring.' },
    { id: 'motivation', label: 'Motivatie', max: 600, paragraph: true, placeholder: 'Wat is je motivatie?' },
    { id: 'goodTraits', label: '3 goede eigenschappen', max: 350, paragraph: true, placeholder: '1.\n2.\n3.' },
    { id: 'badTraits', label: '3 minder goede eigenschappen', max: 350, paragraph: true, placeholder: '1.\n2.\n3.' }
  ],
  [
    { id: 'whyLegion', label: 'Waarom kies je voor Legion?', max: 600, paragraph: true, placeholder: 'Waarom juist Legion?' },
    { id: 'expectations', label: 'Wat kunnen wij van jou verwachten?', max: 600, paragraph: true, placeholder: 'Wat breng jij mee naar de gang?' }
  ]
];
export const applicationFields = applicationSteps.flat();

export const applicationTemplate = `## Legion — Sollicitatie

${applicationIntro}

**Naam:**
**Leeftijd:**
**Playtime:**
**Voertuigen:**
**Geld:**
**Wapens:**
**OW-ervaring:**
**Motivatie:**
**3 goede eigenschappen:**
1.
2.
3.
**3 minder goede eigenschappen:**
1.
2.
3.
**Waarom kies je voor Legion?**
**Wat kunnen wij van jou verwachten?**

${applicationThanks}`;

export function validateApplicationStep(step, answers, minimumAge = 16) {
  const fields = applicationSteps[step];
  if (!fields) return 'Onbekende sollicitatiestap.';
  for (const field of fields) {
    if (typeof answers[field.id] !== 'string' || !answers[field.id].trim() || answers[field.id].length > field.max) return `Vul ${field.label} in (maximaal ${field.max} tekens).`;
  }
  if (step === 0) {
    const age = parseAge(answers.age);
    if (age === null) return 'Vul je leeftijd in hele jaren in, bijvoorbeeld 18.';
    if (age < minimumAge) return `De minimale leeftijd voor Legion is ${minimumAge} jaar.`;
  }
  return null;
}

export function parseAge(value) {
  const match = /^\s*(\d{1,3})\s*(?:jaar|jr)?\s*$/i.exec(String(value ?? ''));
  return match && Number(match[1]) >= 1 && Number(match[1]) <= 120 ? Number(match[1]) : null;
}

export function applicationText(answers, escape = value => String(value)) {
  const body = applicationFields.map(field => `**${field.label}:**\n${escape(answers[field.id] ?? 'Niet ingevuld')}`).join('\n\n');
  return `## Legion — Sollicitatie\n\n${applicationIntro}\n\n${body}\n\n${applicationThanks}`;
}
