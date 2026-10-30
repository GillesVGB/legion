import { randomBytes } from 'node:crypto';
import { assertUser } from '../../common/errors.js';
const kinds = ['blackmoney', 'item'];
function key(kind, value) {
  assertUser(kinds.includes(kind), 'Kies zwartgeld of een item.');
  if (kind === 'blackmoney') return 'zwartgeld';
  const name = String(value || '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('nl-BE');
  assertUser(
    name && name.length <= 80 && !/[\u0000-\u001f]/.test(name),
    'Geef een itemnaam van maximaal 80 tekens.',
  );
  return name;
}
export function assetBalance(ctx, kind, name) {
  return ctx.store.db
    .prepare(
      "SELECT COALESCE(SUM(CASE direction WHEN 'in' THEN quantity ELSE -quantity END),0) AS n FROM gangpot_assets WHERE kind=? AND name=? AND voided_at IS NULL",
    )
    .get(kind, key(kind, name)).n;
}
export function gangpotAssets(ctx) {
  const stock = ctx.store.db
    .prepare(
      "SELECT kind,name,SUM(CASE direction WHEN 'in' THEN quantity ELSE -quantity END) AS quantity FROM gangpot_assets WHERE voided_at IS NULL GROUP BY kind,name HAVING quantity>0 ORDER BY kind,name",
    )
    .all();
  return {
    blackMoney: stock.find((item) => item.kind === 'blackmoney')?.quantity || 0,
    items: stock.filter((item) => item.kind === 'item'),
    history: ctx.store.db
      .prepare('SELECT * FROM gangpot_assets ORDER BY created_at DESC,rowid DESC LIMIT 100')
      .all(),
  };
}
export function recordGangpotAsset(ctx, input, now = Date.now()) {
  assertUser(
    ctx.config.guildId === '1555685630640652338' && ctx.config.gangpot,
    'Dit kan alleen in de Bakarov-hoofdserver.',
  );
  const name = key(input.kind, input.name),
    note = String(input.note || '').trim();
  assertUser(
    ['in', 'out'].includes(input.direction) &&
      Number.isSafeInteger(input.quantity) &&
      input.quantity > 0 &&
      input.quantity <= 100000000,
    'Gebruik een positief heel aantal of bedrag tot 100 miljoen.',
  );
  assertUser(
    typeof input.requestId === 'string' &&
      input.requestId.length >= 8 &&
      input.requestId.length <= 100 &&
      note.length <= 500,
    'Gebruik een geldige registratie en een toelichting van maximaal 500 tekens.',
  );
  return ctx.store.transaction(() => {
    const previous = ctx.store.db
      .prepare('SELECT * FROM gangpot_assets WHERE request_id=?')
      .get(input.requestId);
    if (previous) {
      assertUser(
        previous.kind === input.kind &&
          previous.name === name &&
          previous.quantity === input.quantity &&
          previous.direction === input.direction &&
          previous.actor_id === input.actor &&
          previous.note === note,
        'Dit verzoek is al voor een andere registratie gebruikt.',
      );
      return previous;
    }
    const balance = assetBalance(ctx, input.kind, name),
      after = balance + (input.direction === 'in' ? input.quantity : -input.quantity);
    assertUser(
      after >= 0 && after <= 1000000000,
      'Deze registratie zou een negatieve of te hoge voorraad veroorzaken.',
    );
    const id = randomBytes(6).toString('hex');
    ctx.store.db
      .prepare(
        'INSERT INTO gangpot_assets(id,request_id,kind,name,quantity,direction,actor_id,note,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      )
      .run(
        id,
        input.requestId,
        input.kind,
        name,
        input.quantity,
        input.direction,
        input.actor,
        note,
        now,
      );
    ctx.store.audit('gangpot.asset', input.actor, {
      id,
      kind: input.kind,
      name,
      quantity: input.quantity,
      direction: input.direction,
    });
    ctx.store.setSetting('gangpot:dirty', '1');
    return ctx.store.db.prepare('SELECT * FROM gangpot_assets WHERE id=?').get(id);
  });
}
export function voidGangpotAsset(ctx, id, actor, reason, now = Date.now()) {
  assertUser(
    ctx.config.guildId === '1555685630640652338' && ctx.config.gangpot,
    'Dit kan alleen in de Bakarov-hoofdserver.',
  );
  const text = String(reason || '').trim();
  assertUser(text && text.length <= 500, 'Geef een reden van maximaal 500 tekens.');
  return ctx.store.transaction(() => {
    const entry = ctx.store.db.prepare('SELECT * FROM gangpot_assets WHERE id=?').get(id);
    assertUser(entry && !entry.voided_at, 'Deze registratie bestaat niet of is al gecorrigeerd.');
    const balance =
      assetBalance(ctx, entry.kind, entry.name) +
      (entry.direction === 'in' ? -entry.quantity : entry.quantity);
    assertUser(
      balance >= 0 && balance <= 1000000000,
      'Corrigeer eerst de bijbehorende opnames; de voorraad mag niet negatief of te hoog worden.',
    );
    ctx.store.db
      .prepare('UPDATE gangpot_assets SET voided_at=?,voided_by=?,void_reason=? WHERE id=?')
      .run(now, actor, text, id);
    ctx.store.audit('gangpot.asset.void', actor, { id, reason: text });
    ctx.store.setSetting('gangpot:dirty', '1');
    return entry;
  });
}
