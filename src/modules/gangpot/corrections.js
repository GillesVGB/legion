import { randomBytes } from 'node:crypto';
import { planningTime } from '../planning/index.js';

const CORRECTION_DAY = '2026-10-24';
const CORRECTION_KEY = `gangpot:fronzy-correction:${CORRECTION_DAY}`;
const normalize = (value) =>
  String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('nl-BE')
    .replace(/[^a-z0-9]/g, '');

async function isFronzy(guild, client, id) {
  const member =
    guild.members.cache.get(id) ||
    (await guild.members.fetch({ user: id, force: true }).catch(() => null));
  const user = member?.user || (await client.users.fetch(id).catch(() => null));
  if (!member && !user) return null;
  return [member?.displayName, user?.globalName, user?.username].some(
    (name) => normalize(name) === 'fronzy',
  );
}

export async function correctFronzyGangpotWarnings(ctx, guild, client, now = Date.now()) {
  if (ctx.config.guildId !== '1555685630640652338' || ctx.store.setting(CORRECTION_KEY)) return [];
  const start = planningTime(CORRECTION_DAY, '00:00', now),
    end = planningTime('2026-10-25', '00:00', now);
  const candidates = ctx.store.db
    .prepare(
      "SELECT * FROM warnings WHERE removed_at IS NULL AND created_at>=? AND created_at<? AND lower(reason) LIKE '%gangpot%' ORDER BY created_at,id",
    )
    .all(start, end);
  const actors = [...new Set(candidates.map((item) => item.actor_id))],
    fronzy = [];
  for (const actor of actors) {
    const match = await isFronzy(guild, client, actor);
    if (match === null) {
      console.warn(
        'Gangpotwarn-correctie 24-10-2026: Discord kon de naam van een warn-uitgever niet controleren; de correctie wordt bij een volgende synchronisatie opnieuw geprobeerd.',
      );
      return [];
    }
    if (match) fronzy.push(...candidates.filter((item) => item.actor_id === actor));
  }
  if (fronzy.length !== 2) {
    ctx.store.transaction(() => {
      ctx.store.setSetting(CORRECTION_KEY, `review:${fronzy.length}`);
      ctx.store.audit('gangpot.warn-correction.review', guild.members.me.id, {
        day: CORRECTION_DAY,
        actorName: 'Fronzy',
        matchingWarnings: fronzy.length,
      });
    });
    console.warn(
      `Gangpotwarn-correctie ${CORRECTION_DAY}: ${fronzy.length} actieve gangpotwarn(s) van Fronzy gevonden; niets ingetrokken, handmatige controle nodig.`,
    );
    return [];
  }
  const reason =
    'Op verzoek van de leiding ingetrokken: de twee gangpotwarns van Fronzy op 24 oktober 2026 zijn gecorrigeerd.';
  ctx.store.transaction(() => {
    for (const warning of fronzy) {
      const changed = ctx.store.db
        .prepare(
          'UPDATE warnings SET removed_at=?,removed_by=?,removed_reason=? WHERE id=? AND removed_at IS NULL',
        )
        .run(now, guild.members.me.id, reason, warning.id);
      if (changed.changes !== 1)
        throw new Error('Een van de twee gangpotwarns veranderde tijdens de correctie.');
      ctx.store.audit('warn.remove', guild.members.me.id, {
        id: warning.id,
        user: warning.user_id,
        reason,
        originalActor: warning.actor_id,
        source: 'gangpot-correction',
      });
      const period =
        warning.reason.match(/gangpot\s+t\/m\s+(\d{4}-\d{2}-\d{2})/i)?.[1] || CORRECTION_DAY;
      ctx.store.db
        .prepare(
          'INSERT INTO gangpot_notifications(id,user_id,period_id,warn_id,kind,message) VALUES(?,?,?,?,?,?)',
        )
        .run(
          randomBytes(6).toString('hex'),
          warning.user_id,
          period,
          warning.id,
          'revoke',
          'De gangpotwarn is door de leiding ingetrokken na controle van de twee waarschuwingen die Fronzy op 24 oktober 2026 heeft gegeven.',
        );
    }
    ctx.store.setSetting(CORRECTION_KEY, 'done');
  });
  console.log(
    'Gangpotwarn-correctie 24-10-2026: precies twee actieve gangpotwarns van Fronzy ingetrokken; groene log en DM worden verzonden.',
  );
  return fronzy.map((item) => item.id);
}
