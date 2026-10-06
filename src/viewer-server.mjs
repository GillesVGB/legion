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

export async function createTranscriptServer(contexts, port = 0, dashboard, host = '127.0.0.1') {
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
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  return server;
}

export function neutralTunnelURL(log) {
  return log.match(/https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com\b/)?.[0] ?? null;
}

export function tunnelFailureMessage(code) {
  if (code === 'ENOENT') return 'Het dashboard kan cloudflared niet vinden. Gebruik bin/cloudflared op Linux of bin/cloudflared.exe op Windows en controleer CLOUDFLARED_PATH.';
  if (code === 'EACCES') return 'Cloudflared is niet uitvoerbaar. Start via index.js en controleer de uitvoerrechten op bin/cloudflared.';
  if (code === 'ENOEXEC') return 'Deze cloudflared-versie past niet bij je systeem. Gebruik de Windows-client op Windows en de Linux-client op Linux.';
  if (code === 'DNS') return 'Cloudflared kan de Cloudflare-server niet vinden via DNS. Controleer DNS op de hosting of gebruik DASHBOARD_PUBLIC_URL met het HTTPS-adres uit Domains.';
  if (code === 'NETWORK') return 'Cloudflared krijgt geen verbinding met Cloudflare op poort 7844. Controleer uitgaand TCP/UDP-verkeer op de hosting of gebruik DASHBOARD_PUBLIC_URL.';
  if (code === 'TLS') return 'Cloudflared kan het Cloudflare-certificaat niet controleren. Controleer de systeemtijd en vertrouwde certificaten op de hosting.';
  if (code === 'HTTP_530') return 'Cloudflare geeft fout 1033: de tunnel is niet verbonden. De bot probeert opnieuw. Gebruik het HTTPS-adres uit Domains als DASHBOARD_PUBLIC_URL om zonder tunnel te werken.';
  return 'De HTTPS-verbinding van het dashboard is onderbroken. De bot probeert opnieuw; controleer cloudflared en uitgaande verbindingen in de hostingconsole.';
}

export function connectionDiagnostic(log) {
  if (/Registered tunnel connection/i.test(log)) return 'CONNECTED';
  if (/Switching to fallback protocol http2/i.test(log)) return 'FALLBACK';
  if (/error looking up|DNS query failed|lookup .*?(?:no such host|timeout|server misbehaving)/i.test(log)) return 'DNS';
  if (/x509:|certificate signed by unknown authority/i.test(log)) return 'TLS';
  if (/DialContext error|dial (?:tcp|udp).*?(?:timeout|refused|unreachable)|Failed to dial a quic connection|handshake did not complete/i.test(log)) return 'NETWORK';
  return null;
}

export async function startTranscriptViewer(config, contexts, onReady, dashboard, options = {}) {
  const spawnTunnel = options.spawnTunnel ?? spawn, fetchHealth = options.fetchHealth ?? fetch;
  const retryDelay = options.retryDelayMs ?? 10000, healthDelay = options.healthRetryDelayMs ?? 1000;
  const server = await createTranscriptServer(contexts, config.transcriptPort, dashboard, config.dashboardPublicURL ? '0.0.0.0' : '127.0.0.1');
  options.onListening?.(server);
  const port = server.address().port;
  let stopped = false, child, restart, healthTimer, startupTimer, currentOrigin = '';
  const pidFile = join(config.dataDir, 'transcript-tunnel.pid');
  const setOrigin = origin => {
    currentOrigin = origin;
    dashboard?.setConnection(origin);
    for (const ctx of contexts.values()) if (ctx.config.transcriptViewerMode === 'local') ctx.config.transcriptSiteURL = origin;
  };
  const publishOrigin = origin => {
    setOrigin(origin);
    for (const ctx of contexts.values()) {
      ctx.store.setSetting('dashboard-origin', origin);
      if (ctx.config.transcriptViewerMode === 'local') {
        ctx.store.setSetting('transcript-viewer-origin', origin);
        ctx.store.queueTranscriptLinks();
      }
    }
    console.log(`Legion dashboard bereikbaar: ${origin}`);
    Promise.resolve().then(() => onReady?.()).catch(error => console.error(`Dashboard bereikbaar; achtergrondtaken worden opnieuw geprobeerd (${error.code ?? error.name}).`));
  };
  setOrigin('');

  // Bot-Hosting verzorgt HTTPS; het interne HTTP-proces luistert op SERVER_PORT.
  if (config.dashboardPublicURL) {
    const origin = config.dashboardPublicURL;
    console.log(`Legion dashboard luistert op hostingpoort ${port}: ${origin}`);
    let failures = 0, lastError;
    const probe = async () => {
      if (stopped) return;
      try {
        const response = await fetchHealth(`${origin}/health`, { redirect: 'error', signal: AbortSignal.timeout(4000) });
        if (response.ok && (await response.json()).ok === true) {
          if (stopped) return;
          failures = 0; lastError = null;
          if (!currentOrigin) publishOrigin(origin);
        } else { await response.body?.cancel(); throw Object.assign(new Error(), { code: `HTTP_${response.status}` }); }
      } catch (error) {
        if (stopped) return;
        const code = error.cause?.code ?? error.code ?? error.name;
        if (++failures >= 3 || !currentOrigin) {
          setOrigin('');
          dashboard?.setConnection('', `Het hostingadres is niet bereikbaar (${code}). Controleer Domains en SERVER_PORT in het hostingpaneel.`);
        }
        if (code !== lastError) console.error(`Dashboardcontrole hostingadres: ${code}. Controleer Domains en SERVER_PORT.`);
        lastError = code;
      }
      if (!stopped) healthTimer = setTimeout(probe, currentOrigin ? (options.monitorDelayMs ?? 15000) : healthDelay);
    };
    probe();
    return async () => { stopped = true; clearTimeout(healthTimer); setOrigin(''); await new Promise(resolve => server.close(resolve)); };
  }

  const connect = () => {
    if (stopped) return;
    clearTimeout(healthTimer); clearTimeout(startupTimer);
    let log = '', discovered = false, retried = false, healthError = 'STARTING', transportError, lastDiagnostic, failures = 0, attempts = 0;
    const args = ['tunnel', '--no-autoupdate', '--protocol', config.cloudflaredProtocol ?? 'auto', '--edge-ip-version', config.cloudflaredIPVersion ?? '4', '--loglevel', 'info', '--url', `http://127.0.0.1:${port}`];
    const candidate = spawnTunnel(config.cloudflaredPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child = candidate;
    if (candidate.pid) writeFileSync(pidFile, String(candidate.pid));
    const retry = error => {
      if (child !== candidate || retried) return;
      retried = true;
      clearTimeout(healthTimer); clearTimeout(startupTimer);
      setOrigin('');
      const code = error?.code ?? transportError ?? healthError;
      dashboard?.setConnection('', tunnelFailureMessage(code));
      try { unlinkSync(pidFile); } catch {}
      if (!stopped) { console.error(`Dashboardverbinding onderbroken (${code}); herstart over 10 seconden. ${tunnelFailureMessage(code)}`); restart = setTimeout(connect, retryDelay); }
    };
    const disconnect = code => { retry({ code }); if (candidate.exitCode === null) candidate.kill(); };
    candidate.once('error', retry);
    candidate.once('exit', (code, signal) => retry({ code: transportError ?? (signal ? `SIGNAL_${signal}` : `EXIT_${code}`) }));
    startupTimer = setTimeout(() => disconnect(transportError ?? (healthError === 'STARTING' ? 'STARTUP_TIMEOUT' : healthError)), options.startupTimeoutMs ?? 120000);
    const probe = async origin => {
      if (stopped || retried || child !== candidate) return;
      try {
        const result = await fetchHealth(`${origin}/health`, { redirect: 'error', signal: AbortSignal.timeout(4000) });
        if (result.ok && (await result.json()).ok === true) {
          if (stopped || retried || child !== candidate) return;
          clearTimeout(startupTimer); failures = 0; transportError = null;
          if (!currentOrigin) publishOrigin(origin);
          healthTimer = setTimeout(() => probe(origin), options.monitorDelayMs ?? 15000);
          return;
        }
        await result.body?.cancel();
        healthError = `HTTP_${result.status}`;
      } catch (error) { healthError = error.cause?.code ?? error.name; }
      if (stopped || retried || child !== candidate) return;
      failures++; attempts++;
      if (attempts === 1 || attempts % 30 === 0) console.error(`Dashboardcontrole wacht (${healthError}). ${tunnelFailureMessage(transportError ?? healthError)}`);
      if ((currentOrigin && failures >= 3) || (!currentOrigin && attempts >= (options.maxHealthAttempts ?? 120))) return disconnect(transportError ?? healthError);
      healthTimer = setTimeout(() => probe(origin), currentOrigin ? (options.monitorDelayMs ?? 15000) : healthDelay);
    };
    const read = chunk => {
      log = (log + chunk.toString()).slice(-8192);
      const diagnostic = connectionDiagnostic(chunk.toString());
      if (diagnostic && diagnostic !== lastDiagnostic) {
        lastDiagnostic = diagnostic;
        if (diagnostic === 'CONNECTED') console.log('Cloudflared: verbinding met Cloudflare actief; HTTPS-adres wordt gecontroleerd.');
        else if (diagnostic === 'FALLBACK') console.log('Cloudflared: UDP niet bereikbaar; probeert HTTP/2 via TCP.');
        else { transportError = diagnostic; console.error(`Cloudflared ${diagnostic}: ${tunnelFailureMessage(diagnostic)}`); }
      }
      const origin = neutralTunnelURL(log);
      if (!origin || discovered) return;
      discovered = true;
      console.log(`Legion transcriptverbinding start: ${origin}`);
      probe(origin);
    };
    candidate.stdout.on('data', read); candidate.stderr.on('data', read);
  };
  connect();
  return async () => {
    stopped = true; clearTimeout(restart); clearTimeout(healthTimer); clearTimeout(startupTimer); setOrigin('');
    if (child?.exitCode === null) child.kill();
    try { unlinkSync(pidFile); } catch {}
    await new Promise(resolve => server.close(resolve));
  };
}
