import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const snowflake = /^\d{17,20}$/;
export function cloudflaredExecutable(env = process.env) {
  if (env.CLOUDFLARED_PATH?.trim()) return env.CLOUDFLARED_PATH.trim();
  const bundled = resolve(ROOT, 'bin', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  return existsSync(bundled) ? bundled : 'cloudflared';
}

export function loadConfig(env = process.env, requireDiscord = true) {
  const errors = [];
  const integer = (name, fallback, min, max) => {
    const value = env[name] === undefined || env[name] === '' ? fallback : Number(env[name]);
    if (!Number.isSafeInteger(value) || value < min || value > max) errors.push(`${name}: kies een geheel getal tussen ${min} en ${max}.`);
    return value;
  };
  const token = (env.DISCORD_TOKEN ?? '').trim();
  if (requireDiscord && (!token || token.includes('VUL_HIER'))) errors.push('DISCORD_TOKEN: vul je eigen bot-token in je lokale .env in.');
  const color = env.EMBED_COLOR || '#B91C1C';
  if (!/^#[\da-f]{6}$/i.test(color)) errors.push('EMBED_COLOR: gebruik bijvoorbeeld #B91C1C.');
  const hostingPath = resolve(ROOT, 'hosting.json');
  const hosting = existsSync(hostingPath) ? JSON.parse(readFileSync(hostingPath, 'utf8')) : {};
  const hostedURL = String(env.SERVER_PORT || '') === String(hosting.port) ? hosting.dashboardURL : '';
  const publicURL = (env.DASHBOARD_PUBLIC_URL ?? hostedURL ?? '').trim();
  const config = {
    token, clientId: (env.CLIENT_ID ?? '').trim(),
    transcriptViewerMode: (env.TRANSCRIPT_VIEWER_MODE || 'local').trim(),
    dashboardPublicURL: publicURL,
    transcriptPort: integer(publicURL && env.SERVER_PORT ? 'SERVER_PORT' : 'TRANSCRIPT_PORT', 8793, 1024, 65535),
    cloudflaredPath: cloudflaredExecutable(env),
    cloudflaredProtocol: (env.CLOUDFLARED_PROTOCOL || 'auto').trim(),
    cloudflaredIPVersion: (env.CLOUDFLARED_EDGE_IP_VERSION || '4').trim(),
    transcriptSiteURL: (env.TRANSCRIPT_SITE_URL ?? '').trim(),
    transcriptSiteToken: (env.TRANSCRIPT_SITE_TOKEN ?? '').trim(),
    transcriptUploadSecret: (env.TRANSCRIPT_UPLOAD_SECRET ?? '').trim(),
    guilds: JSON.parse(readFileSync(resolve(ROOT, 'guilds.json'), 'utf8')),
    color: Number.parseInt(color.slice(1), 16),
    warnThreshold: integer('WARN_THRESHOLD', 3, 1, 100),
    startingCoins: integer('STARTING_COINS', 1000, 0, 1000000),
    dailyCoins: integer('DAILY_COINS', 250, 1, 10000),
    maxBet: integer('MAX_BET', 500, 2, 100000),
    blackjackTimeoutMs: integer('BLACKJACK_TIMEOUT_MINUTES', 10, 1, 60) * 60000,
    gamesMembersOnly: env.GAMES_MEMBERS_ONLY === 'true',
    dataDir: resolve(ROOT, env.DATA_DIR || 'data'),
    content: JSON.parse(readFileSync(resolve(ROOT, 'content.json'), 'utf8'))
  };
  if (!['files', 'local', 'remote'].includes(config.transcriptViewerMode)) errors.push('TRANSCRIPT_VIEWER_MODE: kies files, local of remote.');
  if (!['auto', 'http2', 'quic'].includes(config.cloudflaredProtocol)) errors.push('CLOUDFLARED_PROTOCOL: kies auto, http2 of quic.');
  if (!['auto', '4', '6'].includes(config.cloudflaredIPVersion)) errors.push('CLOUDFLARED_EDGE_IP_VERSION: kies auto, 4 of 6.');
  if (config.dashboardPublicURL) {
    try {
      const url = new URL(config.dashboardPublicURL);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error();
      config.dashboardPublicURL = url.origin;
    } catch { errors.push('DASHBOARD_PUBLIC_URL: vul alleen het HTTPS-basisadres uit het hostingpaneel in.'); }
  }
  if (env.GAMES_MEMBERS_ONLY && !['true', 'false'].includes(env.GAMES_MEMBERS_ONLY)) errors.push('GAMES_MEMBERS_ONLY: gebruik true of false.');
  if (requireDiscord && !snowflake.test(config.clientId)) errors.push('CLIENT_ID: vul een geldig Application-ID in.');
  if (!Array.isArray(config.guilds) || !config.guilds.length) errors.push('guilds.json: voeg minimaal een guild toe.');
  else {
    const seen = new Set();
    for (const guild of config.guilds) {
      if (typeof guild.guildId !== 'string' || !snowflake.test(guild.guildId) || seen.has(guild.guildId)) errors.push('guilds.json: elk guildId moet geldig en uniek zijn.');
      seen.add(guild.guildId);
      if (typeof guild.ticketsEnabled !== 'boolean') errors.push(`Guild ${guild.guildId}: ticketsEnabled moet true of false zijn.`);
      for (const key of ['panelChannelId', 'planningChannelId', 'memberRoleId', 'ticketCategoryId', 'applicationCategoryId', 'logChannelId', 'gameChannelId', 'warnLogChannelId', 'applicationTranscriptChannelId', 'ticketTranscriptChannelId']) {
        if (typeof guild[key] !== 'string' || (guild[key] && !snowflake.test(guild[key]))) errors.push(`Guild ${guild.guildId}: ${key} moet leeg of een geldig Discord-ID zijn.`);
      }
      for(const key of ['botLogChannelId','updateChannelId','absencePanelChannelId'])if(guild[key]!==undefined&&(typeof guild[key]!=='string'||!snowflake.test(guild[key])))errors.push(`Guild ${guild.guildId}: ${key} moet een geldig kanaal-ID zijn.`);
      if (!Array.isArray(guild.staffRoleIds) || guild.staffRoleIds.some(x => typeof x !== 'string' || !snowflake.test(x) || x === guild.guildId)) errors.push(`Guild ${guild.guildId}: staffRoleIds moet een lijst met staffrol-ID's zijn; @everyone is niet toegestaan.`);
      if (guild.staffRoleIds?.includes(guild.memberRoleId) && guild.memberRoleId) errors.push(`Guild ${guild.guildId}: de ledenrol mag geen staffrol zijn.`);
      if (config.gamesMembersOnly && !guild.memberRoleId) errors.push(`Guild ${guild.guildId}: GAMES_MEMBERS_ONLY vereist memberRoleId.`);
      if (guild.recruitment) {
        const r = guild.recruitment;
        if (!Number.isInteger(r.capacity) || r.capacity < 1 || !Number.isInteger(r.limitedAt) || r.limitedAt < 1 || r.limitedAt >= r.capacity || !Number.isInteger(r.minimumAge) || r.minimumAge < 1 || !guild.memberRoleId) errors.push(`Guild ${guild.guildId}: controleer recruitment en de ledenrol.`);
      }
      if(guild.gangpot&&(![guild.gangpot.infoChannelId,guild.gangpot.paymentsChannelId,guild.gangpot.totalChannelId,guild.gangpot.memberRoleId].every(value=>typeof value==='string'&&snowflake.test(value))||guild.guildId!=='1555685630640652338'||!Number.isSafeInteger(guild.gangpot.weeklyAmount)||guild.gangpot.weeklyAmount<1||!/^\d{4}-\d{2}-\d{2}$/.test(guild.gangpot.startsOn)))errors.push(`Guild ${guild.guildId}: controleer de gangpotkanalen, ledenrol, weekbijdrage en startdatum.`);
      if (guild.roster && (!snowflake.test(guild.roster.channelId) || !Array.isArray(guild.roster.roleIds) || !guild.roster.roleIds.length || new Set(guild.roster.roleIds).size !== guild.roster.roleIds.length || guild.roster.roleIds.some(id => !snowflake.test(id)))) errors.push(`Guild ${guild.guildId}: controleer de ledenlijstconfiguratie.`);
      if (guild.admission && (!snowflake.test(guild.admission.targetGuildId) || !snowflake.test(guild.admission.inviteChannelId) || (guild.admission.targetRoleId && !snowflake.test(guild.admission.targetRoleId)) || !Number.isInteger(guild.admission.inviteMaxAgeSeconds) || guild.admission.inviteMaxAgeSeconds < 300 || guild.admission.inviteMaxAgeSeconds > 604800)) errors.push(`Guild ${guild.guildId}: controleer de persoonlijke uitnodigingen.`);
    }
  }
  const content = config.content;
  for (const [key, max] of [['gangName', 40], ['serverName', 60], ['coinName', 40]]) {
    if (typeof content[key] === 'string' && content[key].length > max) errors.push(`content.json: ${key} mag maximaal ${max} tekens bevatten.`);
  }
  for (const key of ['gangName', 'serverName', 'tagline', 'information', 'applicationIntro', 'ticketIntro', 'coinName']) {
    if (typeof content[key] !== 'string' || !content[key].trim() || content[key].length > (key === 'information' ? 3000 : 500)) errors.push(`content.json: ${key} moet een korte, niet-lege tekst zijn.`);
  }
  for (const key of ['rules', 'ranks', 'eightBallAnswers']) {
    if (!Array.isArray(content[key]) || content[key].length < 1 || content[key].length > 20 || content[key].some(x => typeof x !== 'string' || !x.trim() || x.length > 150)) errors.push(`content.json: ${key} moet 1-20 korte teksten bevatten (maximaal 150 tekens per tekst).`);
  }
  if (errors.length) throw new Error(`Configuratie klopt nog niet:\n- ${errors.join('\n- ')}`);
  return config;
}
