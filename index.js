import { existsSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { loadEnvFile } from 'node:process';
import {hostingNodeOptions} from './src/startup-memory.mjs';

process.chdir(dirname(fileURLToPath(import.meta.url)));
const envFile = fileURLToPath(new URL('.env', import.meta.url));
if (existsSync(envFile)) loadEnvFile(envFile);
const hostingOptions=hostingNodeOptions();
if(hostingOptions)process.env.NODE_OPTIONS=hostingOptions;
// Pas de hostinggeheugeninstellingen toe voordat de bot en zijn dependencies laden.
if (process.platform === 'linux' && process.env.NODE_OPTIONS && !process.env.LEGION_ENV_APPLIED && typeof process.execve === 'function') {
  process.execve(process.execPath, [process.execPath, ...process.execArgv, ...process.argv.slice(1)], { ...process.env, LEGION_ENV_APPLIED: '1' });
}
if (process.platform !== 'win32') {
  const { cloudflaredExecutable } = await import('./src/config.mjs');
  const executable = cloudflaredExecutable();
  if (executable && existsSync(executable)) chmodSync(executable, 0o755);
}
const {cleanupRuntimeCaches}=await import('./src/storage-maintenance.mjs');
const cacheCleanup=cleanupRuntimeCaches(dirname(fileURLToPath(import.meta.url)));
if(cacheCleanup.removedBytes)console.log(`Tijdelijke installatiecache opgeruimd: ${(cacheCleanup.removedBytes/1024/1024).toFixed(1)} MB vrijgemaakt.`);
if(cacheCleanup.failures.length)console.warn(`Tijdelijke installatiecache kon niet volledig worden opgeruimd (${cacheCleanup.failures.length} locaties). De bot start verder.`);
try { await import('discord.js'); }
catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  console.error('Dependencies ontbreken. Voer in deze botmap eerst "npm ci" uit en start daarna met "npm start".');
  process.exit(1);
}
try{
  const {loadConfig}=await import('./src/config.mjs');
  const {createDataBackup}=await import('./src/backups.mjs');
  const {readFileSync}=await import('node:fs');
  const result=createDataBackup(loadConfig(process.env,false).dataDir,JSON.parse(readFileSync(new URL('./package.json',import.meta.url),'utf8')).version,{automatic:true});
  if(result.saved)console.log(`Back-up vóór gegevensupdate opgeslagen: ${result.id}.`);
}catch(error){
  const detail=String(error.message||'').replace(/[\r\n]+/g,' ').slice(0,240);
  console.error(`Back-up vóór update mislukt (${error.code||error.name}${detail?`: ${detail}`:''}). Controleer vrije schijfruimte en schrijfrechten; de botgegevens zijn nog niet bijgewerkt.`);
  process.exit(1);
}
await import('./src/bot.mjs');
