export async function runMaintenanceJobs(
  ctx,
  jobs,
  { now = Date.now(), shouldStop = () => false, report = console.error } = {},
) {
  for (const [name, execute] of jobs) {
    if (shouldStop()) break;
    const key = `maintenance:error:${name}`;
    try {
      await execute();
      if (ctx.store.setting(key)) ctx.store.db.prepare('DELETE FROM settings WHERE key=?').run(key);
    } catch (error) {
      const code = String(error.code || error.name || 'ERROR').slice(0, 80);
      ctx.store.setSetting(key, JSON.stringify({ code, at: now }));
      report(`Guild ${ctx.config.guildId}: ${name} wacht op herhaling (${code}).`);
    }
  }
}
