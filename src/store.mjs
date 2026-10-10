import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { assertUser, UserError } from './errors.mjs';
import { makeDeck, natural, resultOf, finishDealer, handValue } from './cards.mjs';
import { applicationSteps, validateApplicationStep } from './application.mjs';
import { fishCatch } from './fishing.mjs';
import { missions, missionDay } from './mission-definitions.mjs';

const newId = () => randomBytes(6).toString('hex');
export const DAY = 24 * 60 * 60 * 1000;

export class Store {
  constructor(config, filename) {
    this.config = config;
    if (!filename) mkdirSync(config.dataDir, { recursive: true });
    this.db = new DatabaseSync(filename ?? join(config.dataDir, `legion-${config.guildId}.sqlite`));
    const previousSchema=this.db.prepare('PRAGMA user_version').get().user_version;
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS warnings (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, reason TEXT NOT NULL,
        actor_id TEXT NOT NULL, created_at INTEGER NOT NULL,
        removed_by TEXT, removed_reason TEXT, removed_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS wallets (
        user_id TEXT PRIMARY KEY, balance INTEGER NOT NULL CHECK(balance >= 0),
        last_daily INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS games (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, state TEXT NOT NULL,
        status TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
        expires INTEGER NOT NULL, channel_id TEXT, message_id TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_game ON games(user_id) WHERE status = 'active';
      CREATE TABLE IF NOT EXISTS cases (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, owner_id TEXT NOT NULL,
        channel_id TEXT UNIQUE, message_id TEXT, status TEXT NOT NULL,
        payload TEXT NOT NULL, created_at INTEGER NOT NULL,
        closed_by TEXT, closed_at INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_open_case ON cases(owner_id, kind) WHERE status IN ('creating','open');
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL,
        actor_id TEXT NOT NULL, details TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS application_drafts (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL UNIQUE, step INTEGER NOT NULL DEFAULT 0,
        revision INTEGER NOT NULL DEFAULT 0, answers TEXT NOT NULL,
        expires INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS transcripts (
        case_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending', chunks TEXT,
        message_ids TEXT NOT NULL DEFAULT '[]', last_error TEXT,
        next_attempt INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS interviews (
        case_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL,
        actor_id TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS transcript_views (
        case_id TEXT PRIMARY KEY, view_id TEXT NOT NULL UNIQUE,
        secret_key TEXT NOT NULL, envelope TEXT NOT NULL, uploaded INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS case_cleanup (
        case_id TEXT PRIMARY KEY, next_attempt INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS acceptance_notifications (
        case_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, target_guild_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', invite_code TEXT, expires_at INTEGER,
        dm_id TEXT, next_attempt INTEGER NOT NULL DEFAULT 0, last_error TEXT
      );
      CREATE TABLE IF NOT EXISTS activities (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL,
        location TEXT NOT NULL, starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL,
        creator_id TEXT NOT NULL, channel_id TEXT NOT NULL, message_id TEXT, date_label TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'open', dirty INTEGER NOT NULL DEFAULT 1,
        next_attempt INTEGER NOT NULL DEFAULT 0, last_error TEXT
      );
      CREATE TABLE IF NOT EXISTS activity_rsvps (
        activity_id TEXT NOT NULL, user_id TEXT NOT NULL,
        response TEXT NOT NULL CHECK(response IN ('yes','late','no','maybe')),
        updated_at INTEGER NOT NULL, PRIMARY KEY(activity_id,user_id)
      );
      CREATE TABLE IF NOT EXISTS promotions (
        id TEXT PRIMARY KEY, member_id TEXT NOT NULL, role_id TEXT NOT NULL,
        proposer_id TEXT NOT NULL, reason TEXT NOT NULL, created_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', approver_id TEXT, closed_at INTEGER,
        channel_id TEXT NOT NULL, message_id TEXT, dirty INTEGER NOT NULL DEFAULT 1,
        next_attempt INTEGER NOT NULL DEFAULT 0, last_error TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_pending_promotion ON promotions(member_id) WHERE status IN ('pending','approving');
      CREATE TABLE IF NOT EXISTS promotion_votes (
        proposal_id TEXT NOT NULL, voter_id TEXT NOT NULL,
        response TEXT NOT NULL CHECK(response IN ('approve','reject')),
        updated_at INTEGER NOT NULL, PRIMARY KEY(proposal_id,voter_id)
      );
      CREATE TABLE IF NOT EXISTS mission_progress (
        user_id TEXT NOT NULL, day TEXT NOT NULL, kind TEXT NOT NULL, amount INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(user_id,day,kind)
      );
      CREATE TABLE IF NOT EXISTS mission_claims (
        user_id TEXT NOT NULL, day TEXT NOT NULL, mission_id TEXT NOT NULL, reward INTEGER NOT NULL,
        PRIMARY KEY(user_id,day,mission_id)
      );
      CREATE TABLE IF NOT EXISTS gangpot_periods (
        id TEXT PRIMARY KEY, starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL,
        weekly_amount INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'open'
      );
      CREATE TABLE IF NOT EXISTS gangpot_dues (
        period_id TEXT NOT NULL, user_id TEXT NOT NULL, enrolled_at INTEGER NOT NULL,
        active INTEGER NOT NULL DEFAULT 1, warn_id TEXT, warn_cleared_by_payment INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(period_id,user_id)
      );
      CREATE TABLE IF NOT EXISTS gangpot_entries (
        id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL CHECK(kind IN ('payment','donation','expense')),
        user_id TEXT, period_id TEXT, amount INTEGER NOT NULL CHECK(amount>0),
        actor_id TEXT NOT NULL, paid_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
        note TEXT NOT NULL DEFAULT '', voided_at INTEGER, voided_by TEXT, void_reason TEXT
      );
      CREATE TABLE IF NOT EXISTS gangpot_notifications (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, period_id TEXT NOT NULL,
        warn_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('issue','revoke','restore')),
        message TEXT NOT NULL, log_id TEXT, dm_id TEXT, dm_blocked INTEGER NOT NULL DEFAULT 0,
        next_attempt INTEGER NOT NULL DEFAULT 0, last_error TEXT
      );
      CREATE TABLE IF NOT EXISTS gangpot_claims (
        id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, period_id TEXT NOT NULL,
        user_id TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount>0), reported_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
        note TEXT NOT NULL DEFAULT '', reviewer_id TEXT, reviewed_at INTEGER, payment_id TEXT,
        withdrawn_at INTEGER, withdrawn_by TEXT, withdraw_reason TEXT,
        message_id TEXT, dirty INTEGER NOT NULL DEFAULT 1, next_attempt INTEGER NOT NULL DEFAULT 0,
        last_error TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS gangpot_pending_member ON gangpot_claims(period_id,user_id) WHERE status='pending';
      CREATE TABLE IF NOT EXISTS gangpot_removals (
        id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL, period_id TEXT NOT NULL,
        actor_id TEXT NOT NULL, amount INTEGER NOT NULL, claim_count INTEGER NOT NULL,
        reason TEXT NOT NULL, created_at INTEGER NOT NULL
      );
    `);
    const gangpotColumns=new Set(this.db.prepare('PRAGMA table_info(gangpot_claims)').all().map(column=>column.name));
    for(const [name,type] of [['withdrawn_at','INTEGER'],['withdrawn_by','TEXT'],['withdraw_reason','TEXT']])if(!gangpotColumns.has(name))this.db.exec(`ALTER TABLE gangpot_claims ADD COLUMN ${name} ${type};`);
    if(previousSchema<10)this.db.exec(`UPDATE gangpot_claims SET
      withdrawn_at=(SELECT voided_at FROM gangpot_entries WHERE id=payment_id),
      withdrawn_by=(SELECT voided_by FROM gangpot_entries WHERE id=payment_id),
      withdraw_reason=(SELECT void_reason FROM gangpot_entries WHERE id=payment_id),dirty=1,next_attempt=0
      WHERE payment_id IN (SELECT id FROM gangpot_entries WHERE voided_at IS NOT NULL);`);
    if(!this.db.prepare('PRAGMA table_info(activities)').all().some(column=>column.name==='date_label'))this.db.exec("ALTER TABLE activities ADD COLUMN date_label TEXT NOT NULL DEFAULT '';");
    if(previousSchema<7){
      this.db.exec("UPDATE promotions SET status='pending',approver_id=NULL,dirty=1,next_attempt=0 WHERE status='approving' AND (SELECT COUNT(*) FROM promotion_votes WHERE proposal_id=promotions.id)<3;");
      this.db.exec("UPDATE promotions SET dirty=1,next_attempt=0 WHERE status='pending';");
    }
    this.db.exec('PRAGMA user_version = 10;');
  }

  close() { this.db.close(); }
  setting(key) { return this.db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value; }
  setSetting(key, value) {
    this.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  }
  applicationDraft(id, owner, now = Date.now()) {
    const draft = this.db.prepare('SELECT * FROM application_drafts WHERE id=? AND owner_id=? AND expires>?').get(id, owner, now);
    return draft ? { ...draft, answers: JSON.parse(draft.answers) } : null;
  }
  beginApplication(owner, now = Date.now()) {
    const existing = this.db.prepare("SELECT channel_id FROM cases WHERE owner_id=? AND kind='application' AND status IN ('creating','open')").get(owner);
    assertUser(!existing, existing?.channel_id ? `Je hebt al een sollicitatie: <#${existing.channel_id}>.` : 'Je sollicitatie wordt nog aangemaakt.');
    const previous = this.db.prepare('SELECT id FROM application_drafts WHERE owner_id=? AND expires>?').get(owner, now);
    if (previous) return this.applicationDraft(previous.id, owner, now);
    this.db.prepare('DELETE FROM application_drafts WHERE owner_id=?').run(owner);
    const id = newId();
    this.db.prepare('INSERT INTO application_drafts(id,owner_id,answers,expires) VALUES(?,?,?,?)').run(id, owner, '{}', now + DAY);
    return this.applicationDraft(id, owner, now);
  }
  advanceApplication(id, owner, step, revision, answers, now = Date.now()) {
    return this.transaction(() => {
      const draft = this.applicationDraft(id, owner, now);
      assertUser(draft, 'Dit sollicitatieformulier is verlopen of hoort bij een ander lid. Gebruik /solliciteren.');
      assertUser(draft.step === step && draft.revision === revision && step < applicationSteps.length, 'Deze formulierstap is al opgeslagen. Gebruik /solliciteren om verder te gaan.');
      const error = validateApplicationStep(step, answers, this.config.recruitment?.minimumAge ?? 16);
      assertUser(!error, error);
      const clean = Object.fromEntries(applicationSteps[step].map(field => [field.id, answers[field.id].trim()]));
      this.db.prepare('UPDATE application_drafts SET step=step+1,revision=revision+1,answers=?,expires=? WHERE id=?')
        .run(JSON.stringify({ ...draft.answers, ...clean }), now + DAY, id);
      return this.applicationDraft(id, owner, now);
    });
  }
  deleteApplicationDraft(id, owner) { this.db.prepare('DELETE FROM application_drafts WHERE id=? AND owner_id=?').run(id, owner); }
  transcript(caseId) {
    const row = this.db.prepare('SELECT * FROM transcripts WHERE case_id=?').get(caseId);
    return row ? { ...row, chunks: row.chunks ? JSON.parse(row.chunks) : null, message_ids: JSON.parse(row.message_ids) } : null;
  }
  pendingTranscripts(now = Date.now()) {
    return this.db.prepare("SELECT case_id FROM transcripts WHERE state NOT IN ('done','unavailable') AND next_attempt<=? ORDER BY rowid LIMIT 5").all(now).map(row => this.transcript(row.case_id));
  }
  prepareTranscript(caseId, chunks) {
    this.db.prepare("UPDATE transcripts SET chunks=?,state='ready' WHERE case_id=? AND chunks IS NULL").run(JSON.stringify(chunks), caseId);
  }
  transcriptPart(caseId, messageId) {
    const current = this.transcript(caseId);
    this.db.prepare('UPDATE transcripts SET message_ids=?,last_error=NULL WHERE case_id=?').run(JSON.stringify([...current.message_ids, messageId]), caseId);
  }
  finishTranscript(caseId, origin = this.config.transcriptSiteURL) {
    // Een tunnel kan wisselen terwijl Discord de laatste export verwerkt.
    const state = this.config.transcriptViewerMode === 'local' && origin !== this.config.transcriptSiteURL ? 'ready' : 'done';
    this.db.prepare('UPDATE transcripts SET state=?,next_attempt=0,last_error=NULL WHERE case_id=?').run(state, caseId);
  }
  transcriptView(caseId) {
    const row = this.db.prepare('SELECT * FROM transcript_views WHERE case_id=?').get(caseId);
    return row ? { ...row, envelope: JSON.parse(row.envelope) } : null;
  }
  transcriptEnvelope(viewId) {
    const row = this.db.prepare('SELECT envelope FROM transcript_views WHERE view_id=?').get(viewId);
    return row ? JSON.parse(row.envelope) : null;
  }
  queueTranscriptLinks() {
    this.db.prepare("UPDATE transcripts SET state='ready',next_attempt=0 WHERE state='done'").run();
  }
  saveTranscriptView(caseId, view) {
    this.db.prepare('INSERT OR IGNORE INTO transcript_views(case_id,view_id,secret_key,envelope) VALUES(?,?,?,?)')
      .run(caseId, view.id, view.key, JSON.stringify(view.envelope));
    return this.transcriptView(caseId);
  }
  markTranscriptUploaded(caseId) { this.db.prepare('UPDATE transcript_views SET uploaded=1 WHERE case_id=?').run(caseId); }
  markTranscriptUnavailable(caseId) {
    this.db.prepare("UPDATE transcripts SET state='unavailable',last_error='SOURCE_DELETED' WHERE case_id=?").run(caseId);
  }
  queueTranscriptUpgrade() {
    this.db.prepare("UPDATE transcripts SET state='ready',next_attempt=0 WHERE state='done' AND case_id NOT IN (SELECT case_id FROM transcript_views WHERE uploaded=1)").run();
  }
  interview(caseId) { return this.db.prepare('SELECT * FROM interviews WHERE case_id=? AND ended_at IS NULL').get(caseId); }
  bindInterview(caseId, channel, actor) {
    this.db.prepare('INSERT INTO interviews(case_id,channel_id,actor_id,started_at) VALUES(?,?,?,?) ON CONFLICT(case_id) DO UPDATE SET channel_id=excluded.channel_id,actor_id=excluded.actor_id,started_at=excluded.started_at,ended_at=NULL')
      .run(caseId, channel, actor, Date.now());
    this.audit('application.interview', actor, { id: caseId, channel });
  }
  endInterview(caseId) { this.db.prepare('UPDATE interviews SET ended_at=? WHERE case_id=?').run(Date.now(), caseId); }
  staleInterviews() {
    return this.db.prepare("SELECT i.* FROM interviews i JOIN cases c ON c.id=i.case_id WHERE i.ended_at IS NULL AND c.status NOT IN ('open','creating')").all();
  }
  pendingCaseCleanup(now = Date.now()) {
    return this.db.prepare('SELECT c.* FROM cases c JOIN case_cleanup q ON q.case_id=c.id WHERE q.next_attempt<=? ORDER BY c.closed_at LIMIT 5').all(now).map(row => this.decodeCase(row));
  }
  queueClosedCases() {
    this.db.prepare("INSERT OR IGNORE INTO case_cleanup(case_id) SELECT id FROM cases WHERE status IN ('closed','accepted','rejected') AND channel_id IS NOT NULL").run();
  }
  retryCaseCleanup(id) { this.db.prepare('UPDATE case_cleanup SET next_attempt=? WHERE case_id=?').run(Date.now() + 60000, id); }
  finishCaseCleanup(id) { this.db.prepare('DELETE FROM case_cleanup WHERE case_id=?').run(id); }
  retryTranscript(caseId, error) {
    this.db.prepare('UPDATE transcripts SET last_error=?,next_attempt=? WHERE case_id=?').run(String(error), Date.now() + 60000, caseId);
  }
  acceptance(caseId) { return this.db.prepare('SELECT * FROM acceptance_notifications WHERE case_id=?').get(caseId); }
  pendingAcceptances(now = Date.now()) {
    return this.db.prepare("SELECT * FROM acceptance_notifications WHERE status='pending' AND next_attempt<=? ORDER BY rowid LIMIT 5").all(now);
  }
  bindAcceptanceInvite(caseId, invite) {
    this.db.prepare('UPDATE acceptance_notifications SET invite_code=?,expires_at=?,last_error=NULL WHERE case_id=?')
      .run(invite.code, invite.expiresAt, caseId);
  }
  acceptanceSent(caseId, messageId, alreadyMember = false) {
    this.db.prepare('UPDATE acceptance_notifications SET status=?,dm_id=?,last_error=NULL WHERE case_id=?')
      .run(alreadyMember ? 'joined' : 'sent', messageId, caseId);
    this.audit('application.dm.sent', this.config.clientId, { id: caseId, alreadyMember });
  }
  retryAcceptance(caseId, error, blocked = false) {
    this.db.prepare('UPDATE acceptance_notifications SET status=?,last_error=?,next_attempt=? WHERE case_id=?')
      .run(blocked ? 'dm_blocked' : 'pending', String(error).slice(0, 250), Date.now() + 60000, caseId);
  }
  requeueAcceptance(caseId) {
    assertUser(this.caseById(caseId)?.status === 'accepted', 'Alleen een aangenomen sollicitatie heeft een uitnodiging.');
    this.db.prepare("UPDATE acceptance_notifications SET status='pending',next_attempt=0,last_error=NULL WHERE case_id=? AND status!='revoked'").run(caseId);
  }
  markAcceptance(caseId, status, clearInvite = false) {
    assertUser(['joined','expired','revoked','claimed'].includes(status), 'Ongeldige uitnodigingsstatus.');
    this.db.prepare(`UPDATE acceptance_notifications SET status=?,last_error=NULL${clearInvite ? ',invite_code=NULL' : ''} WHERE case_id=?`).run(status, caseId);
  }
  clearAcceptanceInvite(caseId) { this.db.prepare('UPDATE acceptance_notifications SET invite_code=NULL WHERE case_id=?').run(caseId); }
  adjustCoins(user, change, actor, reason) {
    assertUser(Number.isSafeInteger(change) && change !== 0 && Math.abs(change) <= 100000, 'Kies een bedrag van -100000 tot 100000 coins.');
    return this.transaction(() => {
      const balance = this.wallet(user).balance + change;
      assertUser(balance >= 0 && balance <= 1000000000, 'Het nieuwe saldo moet tussen 0 en 1 miljard coins liggen.');
      this.db.prepare('UPDATE wallets SET balance=? WHERE user_id=?').run(balance, user);
      this.audit('coins.adjust', actor, { user, change, reason });
      return balance;
    });
  }
  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  audit(event, actor, details) {
    this.db.prepare('INSERT INTO audit(event,actor_id,details,created_at) VALUES(?,?,?,?)')
      .run(event, actor, JSON.stringify(details), Date.now());
  }
  addWarn(user, actor, reason) {
    return this.transaction(() => this.addWarnInside(user,actor,reason));
  }
  addWarnInside(user,actor,reason,now=Date.now()) {
      const id = newId();
      this.db.prepare('INSERT INTO warnings(id,user_id,reason,actor_id,created_at) VALUES(?,?,?,?,?)')
        .run(id, user, reason, actor, now);
      this.audit('warn.add', actor, { id, user, reason });
      return { id, count: this.warnCount(user) };
  }
  warnCount(user) {
    return this.db.prepare('SELECT COUNT(*) AS count FROM warnings WHERE user_id=? AND removed_at IS NULL').get(user).count;
  }
  warnings(user) {
    return this.db.prepare('SELECT * FROM warnings WHERE user_id=? ORDER BY created_at DESC LIMIT 25').all(user);
  }
  removeWarn(id, actor, reason) {
    return this.transaction(() => {
      const warning = this.db.prepare('SELECT * FROM warnings WHERE id=?').get(id);
      assertUser(warning, 'Geen gangwarn gevonden met dit ID.');
      assertUser(warning.removed_at === null, 'Deze gangwarn is al ingetrokken.');
      this.db.prepare('UPDATE warnings SET removed_by=?,removed_reason=?,removed_at=? WHERE id=?')
        .run(actor, reason, Date.now(), id);
      this.audit('warn.remove', actor, { id, user: warning.user_id, reason });
      return warning;
    });
  }
  wallet(user) {
    this.db.prepare('INSERT OR IGNORE INTO wallets(user_id,balance) VALUES(?,?)').run(user, this.config.startingCoins);
    return this.db.prepare('SELECT * FROM wallets WHERE user_id=?').get(user);
  }
  daily(user, now = Date.now()) {
    return this.transaction(() => {
      const wallet = this.wallet(user);
      const next = wallet.last_daily + DAY;
      if (wallet.last_daily && now < next) return { available: false, next };
      this.db.prepare('UPDATE wallets SET balance=balance+?,last_daily=? WHERE user_id=?')
        .run(this.config.dailyCoins, now, user);
      this.missionProgress(user, 'daily', now);
      return { available: true, balance: wallet.balance + this.config.dailyCoins };
    });
  }
  validateBet(user, bet, even = false) {
    assertUser(Number.isSafeInteger(bet) && bet >= 2 && bet <= this.config.maxBet, `Kies een inzet van 2 tot ${this.config.maxBet} coins.`);
    assertUser(!even || bet % 2 === 0, 'Kies bij blackjack een even inzet, zodat de 3:2-uitbetaling hele coins oplevert.');
    assertUser(this.wallet(user).balance >= bet, 'Je hebt te weinig coins. Gebruik /daily voor gratis coins.');
  }
  coinflip(user, bet, guess, coin) {
    assertUser(['kop', 'munt'].includes(guess) && ['kop', 'munt'].includes(coin), 'Kies kop of munt.');
    return this.transaction(() => {
      this.validateBet(user, bet);
      const won = guess === coin;
      this.db.prepare('UPDATE wallets SET balance=balance+? WHERE user_id=?').run(won ? bet : -bet, user);
      return { won, coin, balance: this.wallet(user).balance };
    });
  }
  leaderboard() {
    return this.db.prepare('SELECT user_id,balance FROM wallets ORDER BY balance DESC,user_id ASC LIMIT 10').all();
  }
  fish(user, roll, now = Date.now()) {
    const caught = fishCatch(roll);
    return this.transaction(() => {
      const wallet = this.wallet(user);
      const change = Math.max(-wallet.balance, caught.coins) || 0;
      this.db.prepare('UPDATE wallets SET balance=balance+? WHERE user_id=?').run(change, user);
      this.missionProgress(user, 'fish', now);
      return { caught, change, balance: wallet.balance + change };
    });
  }
  decodeGame(row) {
    return row ? { ...JSON.parse(row.state), id: row.id, userId: row.user_id, status: row.status,
      revision: row.revision, expires: row.expires, channelId: row.channel_id, messageId: row.message_id } : null;
  }
  game(id) { return this.decodeGame(this.db.prepare('SELECT * FROM games WHERE id=?').get(id)); }
  activeGame(user) { return this.decodeGame(this.db.prepare("SELECT * FROM games WHERE user_id=? AND status='active'").get(user)); }
  startGame(user, bet, now = Date.now(), deck = makeDeck()) {
    return this.transaction(() => {
      assertUser(!this.activeGame(user), 'Je hebt al een blackjackspel. Gebruik /blackjack zonder inzet om het te hervatten.');
      this.validateBet(user, bet, true);
      const game = { id: newId(), userId: user, bet, deck: [...deck], player: [], dealer: [],
        status: 'active', revision: 0, expires: now + this.config.blackjackTimeoutMs };
      game.player.push(game.deck.pop()); game.dealer.push(game.deck.pop());
      game.player.push(game.deck.pop()); game.dealer.push(game.deck.pop());
      this.db.prepare('UPDATE wallets SET balance=balance-? WHERE user_id=?').run(bet, user);
      this.db.prepare('INSERT INTO games(id,user_id,state,status,expires) VALUES(?,?,?,?,?)')
        .run(game.id, user, JSON.stringify(game), 'active', game.expires);
      if (natural(game.player) || natural(game.dealer)) return this.settleInside(game, resultOf(game), now);
      return this.game(game.id);
    });
  }
  bindGame(id, channel, message) {
    this.db.prepare('UPDATE games SET channel_id=?,message_id=? WHERE id=?').run(channel, message, id);
  }
  settleInside(game, result, now = Date.now()) {
    const updated = this.db.prepare("UPDATE games SET state=?,status='done',revision=revision+1 WHERE id=? AND status='active' AND revision=?")
      .run(JSON.stringify({ ...game, result }), game.id, game.revision);
    assertUser(updated.changes === 1, 'Dit blackjackspel is al gewijzigd of afgelopen.');
    this.db.prepare('UPDATE wallets SET balance=balance+? WHERE user_id=?').run(result.credit, game.userId);
    this.missionProgress(game.userId, 'blackjack', now);
    return this.game(game.id);
  }
  missionProgress(user, kind, now = Date.now()) {
    const definition = missions.find(mission => mission.kind === kind);
    assertUser(definition, 'Onbekende missie.');
    this.db.prepare('INSERT INTO mission_progress(user_id,day,kind,amount) VALUES(?,?,?,1) ON CONFLICT(user_id,day,kind) DO UPDATE SET amount=MIN(amount+1,?)')
      .run(user, missionDay(now), kind, definition.target);
  }
  missionStatus(user, now = Date.now()) {
    const day = missionDay(now);
    const amounts = new Map(this.db.prepare('SELECT kind,amount FROM mission_progress WHERE user_id=? AND day=?').all(user,day).map(item=>[item.kind,item.amount]));
    const claimed = new Set(this.db.prepare('SELECT mission_id FROM mission_claims WHERE user_id=? AND day=?').all(user,day).map(item=>item.mission_id));
    return { day, missions: missions.map(mission=>({ ...mission, progress:amounts.get(mission.kind)||0, claimed:claimed.has(mission.id) })) };
  }
  claimMissions(user, expectedDay, now = Date.now()) {
    return this.transaction(() => {
      assertUser(expectedDay === missionDay(now), 'Deze missiekaart is van een andere dag. Gebruik /missies voor je nieuwe missies.');
      const completed = this.missionStatus(user,now).missions.filter(mission=>mission.progress>=mission.target&&!mission.claimed);
      assertUser(completed.length, 'Je hebt nog geen nieuwe beloning klaarstaan. Rond een missie af en bekijk /missies opnieuw.');
      const reward = completed.reduce((total,mission)=>total+mission.reward,0);
      const wallet = this.wallet(user);
      assertUser(wallet.balance+reward <= 1000000000, 'Je saldo is te hoog om deze beloning toe te voegen.');
      for (const mission of completed) this.db.prepare('INSERT INTO mission_claims(user_id,day,mission_id,reward) VALUES(?,?,?,?)').run(user,expectedDay,mission.id,mission.reward);
      this.db.prepare('UPDATE wallets SET balance=balance+? WHERE user_id=?').run(reward,user);
      this.audit('mission.claim',user,{day:expectedDay,reward,missions:completed.map(mission=>mission.id)});
      return { reward,balance:wallet.balance+reward };
    });
  }
  playGame(id, user, revision, action, now = Date.now()) {
    return this.transaction(() => {
      const game = this.game(id);
      assertUser(game && game.userId === user, 'Deze knoppen horen bij een andere speler of een oud spel.');
      assertUser(game.status === 'active', 'Dit spel is al afgelopen. Start een nieuw spel met /blackjack.');
      assertUser(game.revision === revision, 'Deze knoppen zijn verouderd. Gebruik /blackjack zonder inzet om verder te spelen.');
      assertUser(['hit', 'stand', 'timeout'].includes(action), 'Onbekende blackjackactie.');
      if (action === 'timeout') assertUser(now >= game.expires, 'Dit spel is nog niet verlopen.');
      if (now >= game.expires || action === 'stand') {
        const result = finishDealer(game);
        if (now >= game.expires) result.text = `Tijd verlopen; automatisch gepast. ${result.text}`;
        return this.settleInside(game, result, now);
      }
      game.player.push(game.deck.pop());
      if (handTotal(game) >= 21) {
        return this.settleInside(game, handTotal(game) > 21 ? resultOf(game) : finishDealer(game), now);
      }
      const saved = this.db.prepare("UPDATE games SET state=?,revision=revision+1 WHERE id=? AND status='active' AND revision=?")
        .run(JSON.stringify(game), id, revision);
      assertUser(saved.changes === 1, 'Dit spel is al gewijzigd.');
      return this.game(id);
    });
  }
  expiredGames(now = Date.now()) {
    return this.db.prepare("SELECT id FROM games WHERE status='active' AND expires<=?").all(now)
      .map(({ id }) => { const game = this.game(id); return this.playGame(id, game.userId, game.revision, 'timeout', now); });
  }
  reserveCase(kind, owner, payload, now = Date.now()) {
    assertUser(['ticket', 'application'].includes(kind), 'Onbekend dossiertype.');
    assertUser(kind !== 'ticket' || this.config.ticketsEnabled, 'Tickets zijn uitgeschakeld in deze guild.');
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM cases WHERE kind=? AND owner_id=? AND status IN ('creating','open')").get(kind, owner);
      if (existing) throw new UserError(existing.channel_id ? `Je hebt al een open dossier: <#${existing.channel_id}>.` : 'Je vorige dossier wordt nog aangemaakt. Probeer later opnieuw.');
      const recent = this.db.prepare("SELECT created_at FROM cases WHERE kind=? AND owner_id=? AND status!='failed' ORDER BY created_at DESC LIMIT 1").get(kind, owner);
      assertUser(!recent || now >= recent.created_at + 60000, 'Je kunt maximaal een nieuw dossier per minuut openen. Probeer zo meteen opnieuw.');
      const id = newId();
      this.db.prepare('INSERT INTO cases(id,kind,owner_id,status,payload,created_at) VALUES(?,?,?,?,?,?)')
        .run(id, kind, owner, 'creating', JSON.stringify(payload), now);
      this.audit(`${kind}.reserve`, owner, { id });
      return this.caseById(id);
    });
  }
  decodeCase(row) { return row ? { ...row, payload: JSON.parse(row.payload) } : null; }
  caseById(id) { return this.decodeCase(this.db.prepare('SELECT * FROM cases WHERE id=?').get(id)); }
  restoreCase(row, actor) {
    return this.transaction(() => {
      const existing = this.caseById(row.id);
      if (existing) return existing;
      const conflict = this.db.prepare("SELECT id FROM cases WHERE channel_id=? OR (kind=? AND owner_id=? AND status IN ('creating','open'))").get(row.channel_id, row.kind, row.owner_id);
      assertUser(!conflict, 'Er bestaat al een dossier voor dit kanaal of dit lid. Herstel gestopt.');
      this.db.prepare("INSERT INTO cases(id,kind,owner_id,channel_id,message_id,status,payload,created_at) VALUES(?,?,?,?,?,'open',?,?)")
        .run(row.id, row.kind, row.owner_id, row.channel_id, row.message_id, JSON.stringify(row.payload), row.created_at);
      this.audit(`${row.kind}.recovered`, actor, { id: row.id, channel: row.channel_id, owner: row.owner_id });
      return this.caseById(row.id);
    });
  }
  caseByChannel(channel) { return this.decodeCase(this.db.prepare('SELECT * FROM cases WHERE channel_id=?').get(channel)); }
  activeCases() { return this.db.prepare("SELECT * FROM cases WHERE status IN ('creating','open')").all().map(x => this.decodeCase(x)); }
  bindCase(id, channel) { this.db.prepare('UPDATE cases SET channel_id=? WHERE id=?').run(channel, id); }
  openCase(id, message) {
    this.db.prepare("UPDATE cases SET status='open',message_id=? WHERE id=? AND status='creating'").run(message, id);
  }
  closeCase(id, status, actor) {
    assertUser(['closed', 'accepted', 'rejected', 'failed'].includes(status), 'Onbekende dossierstatus.');
    return this.transaction(() => {
      const row = this.caseById(id);
      assertUser(row && ['open', 'creating'].includes(row.status), 'Dit dossier is al afgehandeld.');
      this.db.prepare('UPDATE cases SET status=?,closed_by=?,closed_at=? WHERE id=?').run(status, actor, Date.now(), id);
      this.audit(`${row.kind}.${status}`, actor, { id, owner: row.owner_id, channel: row.channel_id });
      const target = row.kind === 'application' ? this.config.applicationTranscriptChannelId : this.config.ticketTranscriptChannelId;
      if (target && ['closed', 'accepted', 'rejected'].includes(status)) {
        this.db.prepare('INSERT OR IGNORE INTO transcripts(case_id,channel_id) VALUES(?,?)').run(id, target);
      }
      if (['closed', 'accepted', 'rejected'].includes(status)) this.db.prepare('INSERT OR IGNORE INTO case_cleanup(case_id) VALUES(?)').run(id);
      if (row.kind === 'application' && status === 'accepted' && this.config.admission?.targetGuildId) {
        this.db.prepare('INSERT OR IGNORE INTO acceptance_notifications(case_id,owner_id,target_guild_id) VALUES(?,?,?)')
          .run(id, row.owner_id, this.config.admission.targetGuildId);
      }
      return this.caseById(id);
    });
  }
}

const handTotal = game => handValue(game.player);
