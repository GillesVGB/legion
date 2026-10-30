import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Client,
  MessageManager,
  ReactionUserManager,
  UserManager,
  GuildMemberManager,
  ChannelManager,
  RoleManager,
} from 'discord.js';
import {
  createRuntimeClientOptions,
  pruneRuntimeCaches,
  runtimeLimits,
  startRuntimeCacheMaintenance,
} from '../src/app/runtime-limits.js';
import { hostingNodeOptions } from '../src/app/startup-memory.js';

test('runtime cache limits evict old messages and reaction users while preserving full member and structural caches', () => {
  const { makeCache } = createRuntimeClientOptions();
  for (const [manager, limit] of [
    [MessageManager, runtimeLimits.messagesPerChannel],
    [ReactionUserManager, runtimeLimits.reactionUsers],
  ]) {
    const cache = makeCache(manager, null, manager);
    for (let i = 0; i < 1000; i++) cache.set(String(i), { id: String(i) });
    assert.equal(cache.size, limit);
    assert.equal(cache.has('0'), false);
    assert.equal(cache.has('999'), true);
  }
  for (const manager of [GuildMemberManager, ChannelManager, RoleManager]) {
    const cache = makeCache(manager, null, manager);
    for (let i = 0; i < 2000; i++) cache.set(String(i), { id: String(i) });
    assert.equal(cache.size, 2000);
  }
});

test('user cache stays bounded while retaining the bot user', () => {
  const { makeCache } = createRuntimeClientOptions(),
    cache = makeCache(UserManager, null, UserManager),
    client = { user: { id: 'bot' } };
  cache.set('bot', { id: 'bot', client });
  for (let i = 0; i < 2000; i++) cache.set(String(i), { id: String(i), client });
  assert.equal(cache.size, runtimeLimits.users);
  assert.equal(cache.has('bot'), true);
  assert.equal(cache.has('1999'), true);
});

test('global message budget removes oldest messages across channels and retains recently edited messages', () => {
  const old = new Map([
      ['old', { createdTimestamp: 1 }],
      ['edited', { createdTimestamp: 2, editedTimestamp: 1000 }],
    ]),
    recent = new Map([
      ['recent', { createdTimestamp: 900 }],
      ['middle', { createdTimestamp: 500 }],
    ]);
  const members = new Map([['member', { id: 'member' }]]),
    client = {
      channels: {
        cache: new Map([
          ['a', { messages: { cache: old }, members }],
          ['b', { messages: { cache: recent } }],
          ['voice', {}],
        ]),
      },
    };
  assert.equal(pruneRuntimeCaches(client, { maxMessages: 2 }), 2);
  assert.deepEqual([...old.keys()], ['edited']);
  assert.deepEqual([...recent.keys()], ['recent']);
  assert.equal(members.size, 1);
  assert.equal(pruneRuntimeCaches(client, { maxMessages: 2 }), 0);
});

test('runtime options construct a Discord client without connecting and can be shut down cleanly', async () => {
  const client = new Client({ intents: [], ...createRuntimeClientOptions() });
  const stop = startRuntimeCacheMaintenance(client);
  try {
    assert.equal(client.sweepers.options.messages.lifetime, runtimeLimits.messageLifetimeSeconds);
    assert.equal(client.options.rest.handlerSweepInterval, 60000);
    stop();
    stop();
  } finally {
    await client.destroy();
  }
});

test('small Linux containers get heap headroom while existing user flags and other environments are preserved', () => {
  const base = {
    platform: 'linux',
    constrainedBytes: 256 * 1024 * 1024,
    nodeOptions: '',
    execArgv: [],
  };
  assert.equal(hostingNodeOptions(base), '--max-old-space-size=128 --max-semi-space-size=4');
  assert.equal(
    hostingNodeOptions({ ...base, nodeOptions: '--max-old-space-size=96' }),
    '--max-old-space-size=96',
  );
  assert.equal(hostingNodeOptions({ ...base, execArgv: ['--max_old_space_size', '112'] }), '');
  assert.equal(
    hostingNodeOptions({ ...base, nodeOptions: '--trace-warnings --max-semi-space-size=6' }),
    '--trace-warnings --max-semi-space-size=6 --max-old-space-size=128',
  );
  for (const value of [
    { platform: 'win32' },
    { constrainedBytes: 0 },
    { constrainedBytes: 1024 * 1024 * 1024 },
  ])
    assert.equal(hostingNodeOptions({ ...base, ...value }), '');
});
