import { assertUser } from './errors.mjs';

const limits = { warnThreshold: [1,100], startingCoins: [0,1000000], dailyCoins: [1,10000], maxBet: [2,100000] };
const strings = { gangName: 40, serverName: 60, coinName: 40, tagline: 500, information: 3000, applicationIntro: 500, ticketIntro: 500 };
export function validateDashboardSettings(value) {
  assertUser(value && typeof value === 'object' && !Array.isArray(value), 'Ongeldige instellingen.');
  const allowed = [...Object.keys(limits), 'gamesMembersOnly', 'content'];
  assertUser(Object.keys(value).every(key => allowed.includes(key)), 'Een instelling in dit verzoek mag niet via het dashboard worden gewijzigd.');
  const result = {};
  for (const [key, [min,max]] of Object.entries(limits)) if (Object.hasOwn(value,key)) {
    assertUser(Number.isSafeInteger(value[key]) && value[key] >= min && value[key] <= max, `${key}: kies een geheel getal tussen ${min} en ${max}.`);
    result[key] = value[key];
  }
  if (Object.hasOwn(value, 'gamesMembersOnly')) { assertUser(typeof value.gamesMembersOnly === 'boolean', 'Kies een geldige speltoegang.'); result.gamesMembersOnly = value.gamesMembersOnly; }
  if (Object.hasOwn(value, 'content')) {
    assertUser(value.content && typeof value.content === 'object' && !Array.isArray(value.content), 'Ongeldige informatieteksten.');
    assertUser(Object.keys(value.content).every(key => Object.hasOwn(strings, key) || key === 'rules'), 'Onbekende informatietekst.');
    result.content = {};
    for (const [key,max] of Object.entries(strings)) if (Object.hasOwn(value.content,key)) {
      assertUser(typeof value.content[key] === 'string' && value.content[key].trim() && value.content[key].length <= max, `${key}: gebruik 1 tot ${max} tekens.`);
      result.content[key] = value.content[key].trim();
    }
    if (Object.hasOwn(value.content,'rules')) {
      assertUser(Array.isArray(value.content.rules) && value.content.rules.length >= 1 && value.content.rules.length <= 20 && value.content.rules.every(rule => typeof rule === 'string' && rule.trim() && rule.length <= 150), 'Gebruik 1 tot 20 regels, maximaal 150 tekens per regel.');
      result.content.rules = value.content.rules.map(rule => rule.trim());
    }
  }
  return result;
}
export function applyDashboardSettings(ctx, value) {
  const checked = validateDashboardSettings(value);
  const { content, ...settings } = checked;
  Object.assign(ctx.config, settings);
  if (content) ctx.config.content = { ...ctx.config.content, ...content };
  return checked;
}
export function loadDashboardSettings(ctx) {
  const saved = ctx.store.setting('dashboard-config');
  if (saved) applyDashboardSettings(ctx, JSON.parse(saved));
}
export function saveDashboardSettings(ctx, value, actor) {
  const previous = JSON.parse(ctx.store.setting('dashboard-config') || '{}');
  const checked = validateDashboardSettings(value);
  assertUser(!checked.gamesMembersOnly || ctx.config.memberRoleId, 'Stel eerst een ledenrol in voor deze guild.');
  const saved = { ...previous, ...checked, ...(checked.content ? { content: { ...previous.content, ...checked.content } } : {}) };
  applyDashboardSettings(ctx, checked);
  ctx.store.setSetting('dashboard-config', JSON.stringify(saved));
  ctx.store.audit('dashboard.settings', actor, { fields: Object.keys(checked) });
  return checked;
}
