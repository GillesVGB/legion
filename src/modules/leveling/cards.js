import { fileURLToPath } from 'node:url';
import { UserError } from '../../common/errors.js';
import { levelProgress } from './profiles.js';

const fontFiles = ['Barlow-Regular.ttf', 'Barlow-SemiBold.ttf'].map((name) =>
  fileURLToPath(new URL(`../../ui/assets/fonts/${name}`, import.meta.url)),
);
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
let renderTail = Promise.resolve(),
  queued = 0;

const cleanText = (value, limit) => {
  const text = String(value || '')
    .toWellFormed()
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, '')
    .trim();
  const letters = Array.from(text);
  return letters.length > limit ? letters.slice(0, limit - 1).join('') + '…' : text;
};
const xml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char],
  );
const number = (value) => Number(value).toLocaleString('nl-BE');

// Only small PNGs from Discord's CDN are embedded; never resolve arbitrary SVG image URLs.
async function avatarImage(member) {
  try {
    const address =
      member.displayAvatarURL?.({ extension: 'png', size: 128, forceStatic: true }) ||
      member.user?.displayAvatarURL?.({ extension: 'png', size: 128, forceStatic: true });
    if (!address) return '';
    const url = new URL(address);
    if (
      url.protocol !== 'https:' ||
      !['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname)
    )
      return '';
    const response = await fetch(url, { signal: AbortSignal.timeout(3000), redirect: 'error' });
    if (!response.ok || !response.body) return '';
    const reader = response.body.getReader(),
      parts = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 300_000) return '';
        parts.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const bytes = Buffer.concat(parts);
    if (!bytes.subarray(0, 8).equals(pngSignature) || bytes.length < 24) return '';
    // Bound decoded image memory as well as the downloaded byte count.
    if (bytes.readUInt32BE(16) > 256 || bytes.readUInt32BE(20) > 256) return '';
    return `data:image/png;base64,${bytes.toString('base64')}`;
  } catch {
    return '';
  }
}

export function levelCardSvg({ name, xp, rank, levelUp = false, avatar = '' }) {
  const progress = levelProgress(xp),
    ratio = progress.current / progress.required;
  const displayName = cleanText(name, 29) || 'Bakarov-lid';
  const initials = Array.from(
    displayName
      .replace(/[^\p{L}\p{N}\s]/gu, '')
      .split(/\s+/)
      .map((word) => Array.from(word)[0] || '')
      .join(''),
  )
    .slice(0, 2)
    .join('')
    .toUpperCase();
  const nameUnits = Array.from(displayName).reduce(
    (sum, char) => sum + (/[MW@]/.test(char) ? 0.95 : /[iljI .|]/.test(char) ? 0.3 : 0.65),
    0,
  );
  const nameSize = Math.min(34, 550 / Math.max(1, nameUnits)).toFixed(1);
  const accent = levelUp ? '#67e8a5' : '#f3c969';
  // Avatar data comes only from the checked downloader above, never from user-supplied markup.
  const picture = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(avatar)
    ? `<image href="${avatar}" x="52" y="107" width="128" height="128" clip-path="url(#avatar)"/>`
    : `<text x="116" y="188" text-anchor="middle" fill="${accent}" font-size="46" font-weight="600">${xml(initials)}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="320" viewBox="0 0 1000 320">
  <defs>
    <linearGradient id="background" x2="1" y2="1"><stop stop-color="#191b23"/><stop offset="1" stop-color="#0d0f15"/></linearGradient>
    <linearGradient id="progress"><stop stop-color="${levelUp ? '#28ba7b' : '#c28a2b'}"/><stop offset="1" stop-color="${accent}"/></linearGradient>
    <clipPath id="avatar"><circle cx="116" cy="171" r="64"/></clipPath>
    <clipPath id="name"><rect x="224" y="80" width="560" height="55"/></clipPath>
    <clipPath id="bar"><rect x="224" y="195" width="710" height="18" rx="9"/></clipPath>
  </defs>
  <g font-family="Barlow" font-weight="400">
    <rect width="1000" height="320" rx="24" fill="url(#background)"/>
    <rect x="1" y="1" width="998" height="318" rx="23" fill="none" stroke="#30323c"/>
    <path d="M760 0L1000 240M820 0L1000 180M880 0L1000 120" stroke="${accent}" stroke-opacity=".07" stroke-width="18"/>
    <rect x="35" y="28" width="5" height="20" rx="2" fill="${accent}"/>
    <text x="52" y="45" fill="${accent}" font-size="20" letter-spacing="4" font-weight="600">BAKAROV</text>
    <text x="934" y="44" text-anchor="end" fill="${levelUp ? accent : '#8c909f'}" font-size="17" letter-spacing="2" font-weight="600">${levelUp ? 'LEVEL OMHOOG' : 'ACTIVITEITSPROFIEL'}</text>
    <path d="M36 64H964" stroke="#2b2e38"/>
    <circle cx="116" cy="171" r="72" fill="none" stroke="${accent}" stroke-width="3"/>
    <circle cx="116" cy="171" r="65" fill="#242731"/>
    ${picture}
    <text x="224" y="119" fill="#f6f7fa" font-size="${nameSize}" font-weight="600" clip-path="url(#name)">${xml(displayName)}</text>
    <text x="224" y="152" fill="#a0a4b4" font-size="19">${levelUp ? 'Je activiteit wordt beloond. Goed bezig!' : `${rank ? `RANG #${Number(rank)}   ·   ` : ''}BERICHTEN &amp; SPRAAK`}</text>
    <text x="934" y="101" text-anchor="end" fill="#a0a4b4" font-size="15" letter-spacing="2">LEVEL</text>
    <text x="936" y="159" text-anchor="end" fill="${accent}" font-size="58" font-weight="600">${progress.level}</text>
    <rect x="224" y="195" width="710" height="18" rx="9" fill="#30333f"/>
    <rect x="224" y="195" width="${(710 * ratio).toFixed(2)}" height="18" fill="url(#progress)" clip-path="url(#bar)"/>
    <text x="224" y="246" fill="#e2e4ed" font-size="22" font-weight="600">${number(progress.current)} / ${number(progress.required)} XP</text>
    <text x="934" y="246" text-anchor="end" fill="${accent}" font-size="22" font-weight="600">NOG ${number(progress.remaining)} XP</text>
    <text x="224" y="282" fill="#8c909f" font-size="17">${number(progress.xp)} XP in totaal</text>
    <text x="934" y="282" text-anchor="end" fill="#8c909f" font-size="17">Op weg naar level ${progress.level + 1}</text>
  </g></svg>`;
}

export async function renderLevelCard(member, options) {
  if (queued >= 4)
    throw new UserError('De rankkaarten worden even druk gebruikt. Probeer het zo opnieuw.');
  queued++;
  const task = renderTail
    .catch(() => {})
    .then(async () => {
      const { renderAsync } = await import('@resvg/resvg-js');
      const svg = levelCardSvg({
        ...options,
        name: member.displayName || member.user?.username || member.username,
        avatar: await avatarImage(member),
      });
      const result = await renderAsync(svg, {
        font: { fontFiles, loadSystemFonts: false, defaultFontFamily: 'Barlow' },
        logLevel: 'off',
      });
      return result.asPng();
    });
  renderTail = task;
  try {
    return await task;
  } finally {
    queued--;
  }
}
