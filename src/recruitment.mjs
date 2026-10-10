import { assertUser } from './errors.mjs';
import { refreshMembers } from './members.mjs';

export function recruitmentState(count, settings = { capacity: 25, limitedAt: 20 }) {
  if (!Number.isInteger(count) || count < 0) return { count: null, icon: '⏳', label: 'Status wordt gecontroleerd', closed: true, color: 0xF59E0B };
  if (count >= settings.capacity) return { count, icon: '🔴', label: 'Vol', closed: false, full: true, color: 0xEF4444 };
  if (count >= settings.limitedAt) return { count, icon: '🟠', label: 'Open, beperkte plaatsen', closed: false, color: 0xF59E0B };
  return { count, icon: '🟢', label: 'Open', closed: false, color: 0x22C55E };
}

export function countRecruitment(ctx, guild) {
  if (!ctx.config.recruitment) return null;
  const count = guild.members.cache.filter(member => !member.user.bot && member.roles.cache.has(ctx.config.memberRoleId)).size;
  ctx.recruitment = recruitmentState(count, ctx.config.recruitment);
  return ctx.recruitment;
}

export async function refreshRecruitment(ctx, guild) {
  if (!ctx.config.recruitment) return null;
  await refreshMembers(guild);
  return countRecruitment(ctx, guild);
}

export function requireApplicationsOpen(ctx) {
  assertUser(ctx.config.guildId!=='1555685630640652338','Solliciteren kan alleen in de Legion-communityserver.');
  if (!ctx.config.recruitment) return;
  assertUser(ctx.recruitment?.count !== null && ctx.recruitment?.count !== undefined, 'De ledenstand wordt nog gecontroleerd. Probeer zo opnieuw.');
}

export const applicationWaitingNotice = state => state?.full
  ? 'Legion zit momenteel vol. Je kunt wel solliciteren, maar het bekijken van je sollicitatie kan langer duren.'
  : '';

export function requireRecruitmentSpace(ctx) {
  requireApplicationsOpen(ctx);
  if (ctx.config.recruitment) assertUser(ctx.recruitment.count < ctx.config.recruitment.capacity,
    `Legion zit vol: ${ctx.recruitment.count}/${ctx.config.recruitment.capacity} plaatsen. De sollicitatie blijft open; aannemen kan zodra er een plek vrijkomt.`);
}
