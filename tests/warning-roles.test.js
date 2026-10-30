import test from 'node:test';
import assert from 'node:assert/strict';
import { dashboardFixture, ACTOR, OTHER } from './dashboard-fixture.js';
import { syncWarningRoles } from '../src/modules/moderation/warning-roles.js';

test('waarschuwingrollen volgen actief aantal warns, bouwen af na intrekken en blijven alleen in de hoofdserver', async (t) => {
  const f = dashboardFixture();
  t.after(f.close);
  const main = f.contexts.values().next().value,
    guild = f.guilds.get(main.config.guildId);
  const first = main.store.addWarn(OTHER, ACTOR, 'Eerste gangwarn');
  await syncWarningRoles(main, guild);
  const firstRole = main.store.setting('warning:role:1'),
    secondRole = main.store.setting('warning:role:2'),
    member = guild.members.cache.get(OTHER);
  assert.ok(firstRole && secondRole);
  assert.ok(member.roles.cache.has(firstRole));
  assert.ok(!member.roles.cache.has(secondRole));
  const next = main.store.addWarn(OTHER, ACTOR, 'Tweede gangwarn');
  await syncWarningRoles(main, guild);
  assert.ok(!member.roles.cache.has(firstRole));
  assert.ok(member.roles.cache.has(secondRole));
  main.store.removeWarn(next.id, ACTOR, 'Ingetrokken');
  await syncWarningRoles(main, guild);
  assert.ok(member.roles.cache.has(firstRole));
  assert.ok(!member.roles.cache.has(secondRole));
  main.store.removeWarn(first.id, ACTOR, 'Ingetrokken');
  await syncWarningRoles(main, guild);
  assert.ok(!member.roles.cache.has(firstRole));
  assert.ok(!member.roles.cache.has(secondRole));
  const community = f.source;
  await syncWarningRoles(community, f.guilds.get(community.config.guildId));
  assert.equal(community.store.setting('warning:role:1'), undefined);
});
