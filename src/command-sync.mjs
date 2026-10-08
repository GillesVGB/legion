import { createHash } from 'node:crypto';
import { commands } from './commands.mjs';
export async function syncCommands(ctx,guild){
  const definitions=commands(ctx.config.maxBet,ctx.config.ticketsEnabled);
  const signature=createHash('sha256').update(JSON.stringify(definitions)).digest('hex');
  if(ctx.store.setting('commands:signature')===signature)return false;
  await guild.commands.set(definitions);
  ctx.store.setSetting('commands:signature',signature);
  return true;
}
