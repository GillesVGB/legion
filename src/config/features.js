import { assertUser } from '../common/errors.js';
export const WEEKLY_CHECK_CHANNEL_ID = '1555685632704249932';
export const featureDefaults = {
  gangpot: {
    weeklyAmount: 25000,
    deadlineTime: '23:59',
    remindersEnabled: true,
    thursdayTime: '18:00',
    fridayTime: '18:00',
    leadReminderEnabled: true,
    leadTime: '20:00',
  },
  planning: {
    requireApproval: true,
    autoApproveAbsences: true,
    duration: 120,
    title: 'Gangactiviteit',
    preparation:
      'Zorg dat je volledig bent geheald. Tank je voertuig helemaal vol. Neem repairkits en de benodigde spullen mee. Sta op tijd klaar en volg de aanwijzingen van de leiding.',
  },
  fishing: {
    collectionEnabled: true,
    weeklyEnabled: true,
    target: 25,
    rareTarget: 3,
    reward: 750,
    rareReward: 400,
  },
  activityCheck: {
    remindersEnabled: true,
    reminderMinutes: 60,
    weeklyEnabled: false,
    weeklyStartDate: '2026-10-23',
    weeklyIntervalWeeks: 2,
    weeklyTime: '07:30',
    weeklyReason: 'Tweewekelijkse activiteitencheck',
    weeklyChannelId: WEEKLY_CHECK_CHANNEL_ID,
  },
  backups: { enabled: true, keep: 2, maxTotalMB: 96 },
  monthlyReports: { enabled: true, sendTime: '09:00' },
  weeklyReports: { enabled: true, sendTime: '09:00' },
  absence: { maxDays: 90 },
  logs: { enabled: true, batchSize: 15, localRetentionDays: 90 },
  recruitment: { capacity: 25, limitedAt: 20, minimumAge: 16 },
  admission: { inviteMaxAgeSeconds: 86400 },
  security: {
    enabled: true,
    raidEnabled: true,
    allowInviteCreation: false,
    linkBanCount: 2,
    linkWindowMinutes: 10,
    allowedMentions: 3,
    spamWindowSeconds: 10,
    spamMessageCount: 6,
    duplicateMessageCount: 3,
    timeoutMinutes: 10,
    escalationEnabled: true,
    escalationDays: 30,
    raidJoinCount: 8,
    raidWindowSeconds: 10,
    raidModeMinutes: 10,
    raidTimeoutMinutes: 10,
  },
};
const bounds = {
  weeklyAmount: [1, 100000000],
  duration: [15, 720],
  target: [1, 10000],
  rareTarget: [1, 1000],
  reward: [1, 1000000],
  rareReward: [1, 1000000],
  maxDays: [1, 180],
  batchSize: [1, 20],
  capacity: [2, 1000],
  limitedAt: [1, 999],
  minimumAge: [1, 100],
  inviteMaxAgeSeconds: [300, 604800],
  reminderMinutes: [1, 10080],
  weeklyIntervalWeeks: [1, 12],
  keep: [1, 30],
  maxTotalMB: [16, 256],
  localRetentionDays: [7, 365],
  linkBanCount: [2, 5],
  linkWindowMinutes: [1, 120],
  allowedMentions: [1, 3],
  spamWindowSeconds: [3, 30],
  spamMessageCount: [4, 20],
  duplicateMessageCount: [2, 10],
  timeoutMinutes: [1, 1440],
  escalationDays: [1, 365],
  raidJoinCount: [5, 100],
  raidWindowSeconds: [5, 60],
  raidModeMinutes: [1, 1440],
  raidTimeoutMinutes: [1, 1440],
};
export function operationSettings(ctx) {
  return Object.fromEntries(
    Object.entries(featureDefaults).map(([group, defaults]) => {
      const saved = ctx.config.operations?.[group] || {};
      if (group === 'security')
        return [
          group,
          {
            ...defaults,
            allowInviteCreation:
              ctx.config.security?.allowInviteCreation ?? defaults.allowInviteCreation,
            ...saved,
          },
        ];
      if (group === 'gangpot') {
        const hasNewSchedule =
          Object.hasOwn(saved, 'thursdayTime') ||
          (Object.hasOwn(saved, 'fridayTime') && !Object.hasOwn(saved, 'saturdayTime'));
        const values = {
          ...defaults,
          weeklyAmount: ctx.config.gangpot?.weeklyAmount ?? defaults.weeklyAmount,
          ...saved,
          thursdayTime:
            saved.thursdayTime ??
            (!hasNewSchedule ? saved.fridayTime : undefined) ??
            defaults.thursdayTime,
          fridayTime: hasNewSchedule
            ? (saved.fridayTime ?? defaults.fridayTime)
            : (saved.saturdayTime ?? defaults.fridayTime),
        };
        delete values.saturdayTime;
        return [group, values];
      }
      return [group, { ...defaults, ...saved }];
    }),
  );
}
export function validateOperations(value) {
  assertUser(
    value && typeof value === 'object' && !Array.isArray(value),
    'Ongeldige module-instellingen.',
  );
  const result = {};
  for (const [group, settings] of Object.entries(value)) {
    assertUser(
      Object.hasOwn(featureDefaults, group) &&
        settings &&
        typeof settings === 'object' &&
        !Array.isArray(settings),
      'Onbekende module.',
    );
    result[group] = {};
    for (const [key, input] of Object.entries(settings)) {
      const defaults = featureDefaults[group];
      assertUser(Object.hasOwn(defaults, key), 'Onbekende module-instelling.');
      if (typeof defaults[key] === 'boolean')
        assertUser(typeof input === 'boolean', 'Kies aan of uit.');
      else if (bounds[key])
        assertUser(
          Number.isSafeInteger(input) && input >= bounds[key][0] && input <= bounds[key][1],
          `${key}: kies ${bounds[key][0]} tot ${bounds[key][1]}.`,
        );
      else if (key === 'weeklyStartDate')
        assertUser(
          typeof input === 'string' &&
            /^\d{4}-\d{2}-\d{2}$/.test(input) &&
            Number.isFinite(Date.parse(input + 'T12:00:00Z')) &&
            new Date(input + 'T12:00:00Z').toISOString().slice(0, 10) === input,
          'Gebruik een geldige startdatum: JJJJ-MM-DD.',
        );
      else if (key === 'weeklyChannelId')
        assertUser(
          typeof input === 'string' && (!input || /^\d{17,20}$/.test(input)),
          'Gebruik een geldig kanaal-ID of laat leeg voor mededelingen.',
        );
      else if (key.endsWith('Time'))
        assertUser(
          typeof input === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(input),
          'Gebruik een tijd in UU:MM.',
        );
      else
        assertUser(
          typeof input === 'string' &&
            input.trim() &&
            input.length <= (key === 'preparation' ? 700 : 80),
          'Gebruik een geldige tekst.',
        );
      result[group][key] = typeof input === 'string' ? input.trim() : input;
    }
  }
  return result;
}
export function applyOperations(ctx, values) {
  const merged = operationSettings(ctx);
  for (const [group, settings] of Object.entries(values)) Object.assign(merged[group], settings);
  assertUser(
    (!merged.gangpot.remindersEnabled ||
      (merged.gangpot.thursdayTime < merged.gangpot.deadlineTime &&
        merged.gangpot.fridayTime < merged.gangpot.deadlineTime)) &&
      (!merged.gangpot.leadReminderEnabled ||
        merged.gangpot.leadTime < merged.gangpot.deadlineTime),
    'De herinneringen moeten vóór de deadline op zaterdag staan.',
  );
  assertUser(
    merged.recruitment.limitedAt < merged.recruitment.capacity,
    'De grens voor beperkte plaatsen moet lager dan de capaciteit zijn.',
  );
  ctx.config.operations = merged;
  if (ctx.config.gangpot) Object.assign(ctx.config.gangpot, merged.gangpot);
  if (!merged.security.enabled || !merged.security.raidEnabled) {
    ctx.securityRaidUntil = 0;
    ctx.securityJoins = [];
  }
  if (ctx.config.recruitment) Object.assign(ctx.config.recruitment, merged.recruitment);
  if (ctx.config.admission) Object.assign(ctx.config.admission, merged.admission);
}
