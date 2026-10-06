import { existsSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { loadEnvFile } from 'node:process';

process.chdir(dirname(fileURLToPath(import.meta.url)));
const envFile = fileURLToPath(new URL('.env', import.meta.url));
if (existsSync(envFile)) loadEnvFile(envFile);
// FPS.ms start index.js rechtstreeks. Pas NODE_OPTIONS uit .env toe vóór de bot laadt.
if (process.platform === 'linux' && process.env.NODE_OPTIONS && !process.env.LEGION_ENV_APPLIED && typeof process.execve === 'function') {
  process.execve(process.execPath, [process.execPath, ...process.execArgv, ...process.argv.slice(1)], { ...process.env, LEGION_ENV_APPLIED: '1' });
}
if (process.platform !== 'win32' && process.env.TRANSCRIPT_VIEWER_MODE === 'local') {
  const executable = process.env.CLOUDFLARED_PATH;
  if (executable && existsSync(executable)) chmodSync(executable, 0o755);
}
await import('./src/bot.mjs');
