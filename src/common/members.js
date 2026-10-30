const refreshes = new Map();

export async function refreshMembers(guild) {
  if (refreshes.has(guild.id)) return refreshes.get(guild.id);
  const task = (async () => {
    const previous = new Set(guild.members.cache.keys()),
      seen = new Map();
    let after;
    for (;;) {
      const page = await guild.members.list({
        limit: 1000,
        cache: false,
        ...(after ? { after } : {}),
      });
      for (const [id, member] of page) seen.set(id, member);
      if (page.size < 1000) break;
      const last = [...page.keys()].reduce((a, b) => (BigInt(a) > BigInt(b) ? a : b));
      if (last === after) throw new Error('De volledige ledenlijst kon niet worden opgehaald.');
      after = last;
    }
    for (const id of previous) if (!seen.has(id)) guild.members.cache.delete(id);
    for (const [id, member] of seen) guild.members.cache.set(id, member);
    return guild.members.cache;
  })();
  refreshes.set(guild.id, task);
  try {
    return await task;
  } finally {
    refreshes.delete(guild.id);
  }
}
