import { createCipheriv, randomBytes } from 'node:crypto';
import { assertUser } from './errors.mjs';

export function encryptTranscript(html) {
  const key = randomBytes(32), iv = randomBytes(12), id = randomBytes(16).toString('hex');
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(id));
  const data = Buffer.concat([cipher.update(html, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return { id, key: key.toString('base64url'), envelope: { version: 1, iv: iv.toString('base64url'), data: data.toString('base64url') } };
}

export function transcriptViewURL(config, view) {
  const origin = new URL(config.transcriptSiteURL);
  assertUser(origin.protocol === 'https:', 'De transcriptpagina moet HTTPS gebruiken.');
  return `${origin.origin}/t/${view.view_id}#k=${view.secret_key}`;
}

export async function publishTranscriptView(config, view, transport = fetch) {
  if (config.transcriptViewerMode === 'local') return transcriptViewURL(config, view);
  const url = new URL(`/api/transcripts/${view.view_id}`, config.transcriptSiteURL);
  assertUser(url.protocol === 'https:', 'De transcriptpagina moet HTTPS gebruiken.');
  assertUser(config.transcriptSiteToken && config.transcriptUploadSecret, 'De toegang tot de transcriptpagina is niet ingesteld.');
  const response = await transport(url, { method: 'PUT', redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.transcriptUploadSecret}`,
      'OAI-Sites-Authorization': `Bearer ${config.transcriptSiteToken}` }, body: JSON.stringify(view.envelope) });
  assertUser(response.ok, `Transcriptpagina opslaan mislukt (HTTP ${response.status}).`);
  const result = await response.json();
  assertUser(result.id === view.view_id, 'De transcriptpagina gaf geen geldige ontvangstbevestiging.');
  return transcriptViewURL(config, view);
}
