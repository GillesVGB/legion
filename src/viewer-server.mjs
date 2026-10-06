import { createServer } from 'node:http';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const assets = new Map([
  ['page', ['page.html', 'text/html; charset=utf-8']],
  ['/viewer.css', ['viewer.css', 'text/css; charset=utf-8']],
  ['/viewer.js', ['viewer.js', 'text/javascript; charset=utf-8']]
].map(([key, [file, type]]) => [key, { type, body: readFileSync(new URL(`viewer-assets/${file}`, import.meta.url)) }]));
const headers = {
  'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow, noarchive', 'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src 'self'; img-src data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
};

export async function createTranscriptServer(contexts, port = 0, dashboard) {
  const server = createServer(async (request, response) => {
    if (dashboard) {
      try { if (await dashboard.handle(request, response)) return; }
      catch { response.writeHead(503, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' }); response.end('Dashboard tijdelijk niet beschikbaar.'); return; }
    }
    const send = (code, type, body) => { response.writeHead(code, { ...headers, 'Content-Type': type }); response.end(request.method === 'HEAD' ? undefined : body); };
    if (!['GET', 'HEAD'].includes(request.method)) { request.resume(); return send(405, 'text/plain; charset=utf-8', 'Alleen lezen toegestaan.'); }
    let path;
    try { path = new URL(request.url, 'http://localhost').pathname; }
    catch { return send(400, 'text/plain; charset=utf-8', 'Ongeldig adres.'); }
    if (path === '/health') return send(200, 'application/json', '{"ok":true}');
    const asset = assets.get(path) ?? (path === '/' || /^\/t\/[a-f0-9]{32}$/.test(path) ? assets.get('page') : null);
    if (asset) return send(200, asset.type, asset.body);
    const id = /^\/api\/transcripts\/([a-f0-9]{32})$/.exec(path)?.[1];
    if (id) {
      try {
        for (const ctx of contexts.values()) {
          const envelope = ctx.store.transcriptEnvelope(id);
          if (envelope) return send(200, 'application/json', JSON.stringify(envelope));
        }
      } catch { return send(503, 'text/plain; charset=utf-8', 'Tijdelijk niet beschikbaar.'); }
    }
    return send(404, 'text/plain; charset=utf-8', 'Niet gevonden.');
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return server;
}

export function neutralTunnelURL(log) {
  return log.match(/https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com\b/)?.[0] ?? null;
}

export function tunnelFailureMessage(code) {
  if (code === 'ENOENT') return 'Het dashboard kan cloudflared niet vinden. Gebruik bin/cloudflared op Linux of bin/cloudflared.exe op Windows en controleer CLOUDFLARED_PATH.';
  if (code === 'EACCES') return 'Cloudflared is niet uitvoerbaar. Start via index.js en controleer de uitvoerrechten op bin/cloudflared.';
  if (code === 'ENOEXEC') return 'Deze cloudflared-versie past niet bij je systeem. Gebruik de Windows-client op Windows en de Linux-client op Linux.';
  return 'De HTTPS-verbinding van het dashboard is onderbroken. De bot probeert opnieuw; controleer cloudflared en uitgaande verbindingen in de hostingconsole.';
}

export async function startTranscriptViewer(config, contexts, onReady, dashboard, options = {}) {
  const spawnTunnel = options.spawnTunnel ?? spawn, fetchHealth = options.fetchHealth ?? fetch;
  const retryDelay = options.retryDelayMs ?? 10000, healthDelay = options.healthRetryDelayMs ?? 1000;
  const server = await createTranscriptServer(contexts, config.transcriptPort, dashboard);
  const port = server.address().port;
  let stopped = false, child, restart, currentOrigin = '';
  const pidFile = join(config.dataDir, 'transcript-tunnel.pid');
  const setOrigin = origin => {
    currentOrigin = origin;
    dashboard?.setConnection(origin);
    for (const ctx of contexts.values()) if (ctx.config.transcriptViewerMode === 'local') ctx.config.transcriptSiteURL = origin;
  };
  setOrigin('');
  const connect = () => {
    if (stopped) return;
    let log = '', discovered = false, retried = false, healthError = 'verbinding opstarten';
    const candidate = spawnTunnel(config.cloudflaredPath, ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', `http://127.0.0.1:${port}`], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child = candidate;
    if (candidate.pid) writeFileSync(pidFile, String(candidate.pid));
    const retry = error => {
      if (child !== candidate || retried) return;
      retried = true;
      setOrigin('');
      dashboard?.setConnection('', tunnelFailureMessage(error?.code));
      try { unlinkSync(pidFile); } catch {}
      if (!stopped) { console.error(`Dashboardverbinding onderbroken (${error?.code ?? healthError}); herstart over 10 seconden.`); restart = setTimeout(connect, retryDelay); }
    };
    candidate.once('error', retry); candidate.once('exit', retry);
    const read = async chunk => {
      log = (log + chunk.toString()).slice(-8192);
      const origin = neutralTunnelURL(log);
      if (!origin || discovered) return;
      discovered = true;
      console.log(`Legion transcriptverbinding start: ${origin}`);
      for (let attempt = 0; attempt < (options.maxHealthAttempts ?? 120) && !stopped && child === candidate && candidate.exitCode === null; attempt++) {
        try {
          const result = await fetchHealth(`${origin}/health`, { redirect: 'error', signal: AbortSignal.timeout(4000) });
          if (result.ok && (await result.json()).ok === true) {
            setOrigin(origin);
            for (const ctx of contexts.values()) {
              ctx.store.setSetting('dashboard-origin', origin);
              if (ctx.config.transcriptViewerMode === 'local') {
                ctx.store.setSetting('transcript-viewer-origin', origin);
                ctx.store.queueTranscriptLinks();
              }
            }
            console.log(`Legion dashboard bereikbaar: ${origin}`);
            await onReady?.();
            return;
          }
          healthError = `HTTP ${result.status}`;
        } catch (error) { healthError = error.cause?.code ?? error.name; }
        await new Promise(resolve => setTimeout(resolve, healthDelay));
      }
      if (!stopped && !currentOrigin && child === candidate) candidate.kill();
    };
    candidate.stdout.on('data', read); candidate.stderr.on('data', read);
  };
  connect();
  return async () => {
    stopped = true; clearTimeout(restart); setOrigin('');
    if (child?.exitCode === null) child.kill();
    try { unlinkSync(pidFile); } catch {}
    await new Promise(resolve => server.close(resolve));
  };
}
