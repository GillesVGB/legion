import { assertUser } from './errors.mjs';
import {validateOperations,applyOperations,WEEKLY_CHECK_CHANNEL_ID} from './feature-settings.mjs';
import {migrateBrandSettings} from './branding.mjs';

const limits = { warnThreshold: [1,100], startingCoins: [0,1000000], dailyCoins: [1,10000], maxBet: [2,100000] };
const strings = { gangName: 40, serverName: 60, coinName: 40, tagline: 500, information: 3000, applicationIntro: 500, ticketIntro: 500 };
export function validateDashboardSettings(value) {
  assertUser(value && typeof value === 'object' && !Array.isArray(value), 'Ongeldige instellingen.');
  const allowed = [...Object.keys(limits), 'gamesMembersOnly', 'content','operations','channels','color'];
  assertUser(Object.keys(value).every(key => allowed.includes(key)), 'Een instelling in dit verzoek mag niet via het dashboard worden gewijzigd.');
  const result = {};
  if(Object.hasOwn(value,'color')){assertUser(typeof value.color==='string'&&/^#[a-f0-9]{6}$/i.test(value.color),'Gebruik een geldige embedkleur.');result.color=value.color;}
  if(Object.hasOwn(value,'channels')){assertUser(value.channels&&typeof value.channels==='object'&&!Array.isArray(value.channels),'Ongeldige kanalen.');result.channels={};for(const [key,id] of Object.entries(value.channels)){assertUser(['logChannelId','botLogChannelId','updateChannelId','absencePanelChannelId','planningChannelId','warnLogChannelId','panelChannelId','gangpotInfo','gangpotPayments','gangpotTotal','monthlyReportChannelId','weeklyReportChannelId'].includes(key)&&typeof id==='string'&&/^\d{17,20}$/.test(id),'Kies een geldig ingesteld kanaal.');result.channels[key]=id;}}
  if(Object.hasOwn(value,'operations'))result.operations=validateOperations(value.operations);
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
  const { content,operations,channels,color, ...settings } = checked;
  assertUser(!Object.keys(channels||{}).some(key=>key.startsWith('gangpot'))||ctx.config.gangpot,'Gangpotkanalen zijn alleen in de hoofdserver instelbaar.');
  if(operations)applyOperations(ctx,operations);
  if(color)ctx.config.color=Number.parseInt(color.slice(1),16);
  for(const [key,id] of Object.entries(channels||{})){if(key.startsWith('gangpot')){assertUser(ctx.config.gangpot,'Gangpotkanalen zijn alleen in de hoofdserver instelbaar.');ctx.config.gangpot[{gangpotInfo:'infoChannelId',gangpotPayments:'paymentsChannelId',gangpotTotal:'totalChannelId'}[key]]=id;}else ctx.config[key]=id;}
  Object.assign(ctx.config, settings);
  if (content) ctx.config.content = { ...ctx.config.content, ...content };
  return checked;
}
export function loadDashboardSettings(ctx) {
  const saved = ctx.store.setting('dashboard-config');
  const migrated=migrateBrandSettings(ctx,JSON.parse(saved||'{}'));
  if(ctx.config.guildId==='1555685630640652338'&&!ctx.store.setting('activitycheck:interval-config:2')){
    migrated.operations??={};const settings=migrated.operations.activityCheck??={};
    settings.weeklyIntervalWeeks??=2;
    if(settings.weeklyReason==='Wekelijkse activiteitencheck')settings.weeklyReason='Tweewekelijkse activiteitencheck';
    ctx.store.transaction(()=>{ctx.store.setSetting('dashboard-config',JSON.stringify(migrated));ctx.store.setSetting('activitycheck:interval-config:2','1');});
  }
  if(ctx.config.guildId==='1555685630640652338'&&!ctx.store.setting('activitycheck:weekly-config:1')){
    migrated.operations??={};migrated.operations.activityCheck={...migrated.operations.activityCheck,weeklyEnabled:true,weeklyStartDate:'2026-10-23',weeklyIntervalWeeks:2,weeklyTime:'07:30',weeklyReason:'Tweewekelijkse activiteitencheck',weeklyChannelId:WEEKLY_CHECK_CHANNEL_ID};
    // Persist once; later dashboard changes, including disabling, survive restarts.
    ctx.store.transaction(()=>{ctx.store.setSetting('dashboard-config',JSON.stringify(migrated));ctx.store.setSetting('activitycheck:weekly-config:1','1');});
  }
  if(ctx.config.guildId==='1555685630640652338'&&!ctx.store.setting('activitycheck:weekly-channel:2')){
    migrated.operations??={};const settings=migrated.operations.activityCheck??={};
    if(!settings.weeklyChannelId||[ctx.config.planningChannelId,'1555685633266163793'].includes(settings.weeklyChannelId))settings.weeklyChannelId=WEEKLY_CHECK_CHANNEL_ID;
    ctx.store.transaction(()=>{ctx.store.setSetting('dashboard-config',JSON.stringify(migrated));ctx.store.setSetting('activitycheck:weekly-channel:2','1');});
  }
  let weeklyMigrated=false;
  if(migrated.operations?.monthlyReports&&!migrated.operations.weeklyReports){migrated.operations.weeklyReports={...migrated.operations.monthlyReports};weeklyMigrated=true;}
  if(migrated.channels?.monthlyReportChannelId&&!migrated.channels.weeklyReportChannelId){migrated.channels.weeklyReportChannelId=migrated.channels.monthlyReportChannelId;weeklyMigrated=true;}
  applyDashboardSettings(ctx,migrated);
  if(weeklyMigrated)ctx.store.setSetting('dashboard-config',JSON.stringify(migrated));
  if(ctx.store.setting('branding:version')!=='bakarov-1')ctx.store.transaction(()=>{
    if(saved)ctx.store.setSetting('dashboard-config',JSON.stringify(migrated));
    for(const table of ['activities','promotions','absence_requests','gangpot_claims','activity_check_sessions']){
      ctx.store.db.prepare(`UPDATE ${table} SET dirty=1,next_attempt=0 WHERE status IN ('open','pending','approving')`).run();
    }
    ctx.store.setSetting('branding:version','bakarov-1');
  });
}
export function saveDashboardSettings(ctx, value, actor) {
  const previous = JSON.parse(ctx.store.setting('dashboard-config') || '{}');
  const checked = validateDashboardSettings(value);
  assertUser(!checked.gamesMembersOnly || ctx.config.memberRoleId, 'Stel eerst een ledenrol in voor deze guild.');
  const operations={...previous.operations};for(const [group,settings] of Object.entries(checked.operations||{}))operations[group]={...operations[group],...settings};
  const saved = { ...previous, ...checked, ...(checked.channels?{channels:{...previous.channels,...checked.channels}}:{}),...(checked.operations?{operations}:{}),...(checked.content ? { content: { ...previous.content, ...checked.content } } : {}) };
  applyDashboardSettings(ctx, checked);
  ctx.store.setSetting('dashboard-config', JSON.stringify(saved));
  ctx.store.audit('dashboard.settings', actor, { fields: Object.keys(checked) });
  return checked;
}
