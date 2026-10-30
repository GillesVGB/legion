import { PermissionFlagsBits as P } from 'discord.js';

const MAIN_GUILD_ID = '1555685630640652338';
const definitions = [
  { key: 'warning:role:1', name: 'Waarschuwing 1', color: 0xf59e0b },
  { key: 'warning:role:2', name: 'Waarschuwing 2', color: 0xef4444 },
];

async function ensureRole(ctx, guild, definition) {
  const saved = ctx.store.setting(definition.key);
  let role = saved ? await guild.roles.fetch(saved).catch(() => null) : null;
  role ??= guild.roles.cache.find((item) => item.name === definition.name) || null;
  if (!role)
    role = await guild.roles.create({
      name: definition.name,
      color: definition.color,
      hoist: false,
      mentionable: false,
      reason: 'Automatische rol voor actieve gangwarns',
    });
  ctx.store.setSetting(definition.key, role.id);
  const bot = guild.members.me;
  if (role.managed || role.comparePositionTo(bot.roles.highest) >= 0)
    throw new Error(`De rol ${definition.name} staat boven de botrol of is beheerd.`);
  return role;
}

export async function syncWarningRoles(ctx, guild) {
  if (guild.id !== MAIN_GUILD_ID) return;
  await guild.members.fetchMe();
  if (!guild.members.me.permissions.has(P.ManageRoles))
    throw new Error('De bot mist Rollen beheren voor Waarschuwing 1 en Waarschuwing 2.');
  const [first, second] = await Promise.all(
    definitions.map((definition) => ensureRole(ctx, guild, definition)),
  );
  const roleIds = [first.id, second.id];
  const counts = new Map(
    ctx.store.db
      .prepare(
        'SELECT user_id,COUNT(*) AS count FROM warnings WHERE removed_at IS NULL GROUP BY user_id',
      )
      .all()
      .map((item) => [item.user_id, item.count]),
  );
  const members = new Set(counts.keys());
  for (const member of guild.members.cache.values())
    if (roleIds.some((id) => member.roles.cache.has(id))) members.add(member.id);
  let failed = 0;
  for (const id of members) {
    const member =
      guild.members.cache.get(id) ||
      (await guild.members.fetch({ user: id, force: true }).catch(() => null));
    if (!member || member.user.bot) continue;
    const count = counts.get(id) || 0,
      desired = count >= 2 ? second : count === 1 ? first : null;
    const remove = roleIds.filter(
      (roleId) => member.roles.cache.has(roleId) && roleId !== desired?.id,
    );
    try {
      if (remove.length)
        await member.roles.remove(remove, 'Gangwarnrollen automatisch synchroniseren');
      if (desired && !member.roles.cache.has(desired.id))
        await member.roles.add(desired, 'Actief aantal gangwarns bijgewerkt');
    } catch {
      failed++;
    }
  }
  if (failed) throw new Error(`Waarschuwingsrollen bijwerken mislukte voor ${failed} leden.`);
}
