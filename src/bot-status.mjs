import {MessageFlags} from 'discord.js';
import {requireStaff,quiet} from './service.mjs';
import {embed} from './ui.mjs';
export function botHealth(ctx,client){
  const db=ctx.store.db,counts={
    transcripts:db.prepare("SELECT COUNT(*) AS n FROM transcripts WHERE state NOT IN ('done','unavailable')").get().n,
    invitations:db.prepare("SELECT COUNT(*) AS n FROM acceptance_notifications WHERE status IN ('pending','dm_blocked')").get().n,
    payments:db.prepare('SELECT COUNT(*) AS n FROM gangpot_claims WHERE dirty=1').get().n,
    absences:db.prepare('SELECT COUNT(*) AS n FROM absence_requests WHERE dirty=1').get().n,
    notifications:db.prepare("SELECT COUNT(*) AS n FROM feature_notices WHERE status='pending'").get().n,
    gangpotWarns:db.prepare('SELECT COUNT(*) AS n FROM gangpot_notifications WHERE log_id IS NULL OR (dm_id IS NULL AND dm_blocked=0)').get().n,
    blockedDMs:db.prepare("SELECT COUNT(*) AS n FROM feature_notices WHERE status='blocked'").get().n,
    changelog:db.prepare('SELECT COUNT(*) AS n FROM release_announcements WHERE message_id IS NULL').get().n,
    logs:db.prepare('SELECT COUNT(*) AS n FROM audit WHERE id>?').get(Number(ctx.store.setting('audit:cursor')||0)).n
  };
  const errors=[];for(const table of ['gangpot_claims','gangpot_notifications','absence_requests','feature_notices','audit_deliveries','release_announcements','promotions','activities'])for(const item of db.prepare(`SELECT last_error FROM ${table} WHERE last_error IS NOT NULL LIMIT 5`).all())errors.push({module:table,code:item.last_error});
  if(ctx.store.setting('absence:panel:error'))errors.push({module:'Afmeldpaneel',code:ctx.store.setting('absence:panel:error')});
  return{ready:ctx.ready&&client.isReady(),uptime:Math.round(process.uptime()),latency:Math.max(0,client.ws?.ping||0),memoryMB:Math.round(process.memoryUsage().rss/1048576),counts,errors:errors.slice(0,20)};
}
export async function handleBotStatus(ctx,interaction){requireStaff(interaction,ctx.config);const health=botHealth(ctx,interaction.client);return interaction.reply({flags:MessageFlags.Ephemeral,embeds:[embed(ctx.config,'Legion — Botstatus',`**Verbinding:** ${health.ready?'🟢 Online':'🟠 Starten / herstellen'}\n**Uptime:** ${Math.floor(health.uptime/60)} minuten\n**Vertraging:** ${health.latency} ms\n**Geheugen:** ${health.memoryMB} MB\n\n**Wachten op verwerking**\n${Object.entries(health.counts).map(([name,n])=>`${name}: ${n}`).join('\n')}\n\n**Laatste problemen:**\n${health.errors.map(item=>`${item.module}: ${item.code}`).join('\n')||'Geen geregistreerde problemen.'}`)],allowedMentions:quiet});}
