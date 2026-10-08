import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PermissionFlagsBits as P, Routes } from 'discord.js';
import { UserError, assertUser } from './errors.mjs';
import { saveDashboardSettings, validateDashboardSettings } from './dashboard-settings.mjs';
import { commands } from './commands.mjs';
import { decideCase, startInterview, publishPanel, writeWarnLog, warnLogChannel } from './service.mjs';
import { safeText } from './ui.mjs';
import { fetchTranscriptMessages } from './transcripts.mjs';
import { transcriptViewURL } from './viewer.mjs';
import { resendAcceptance } from './admissions.mjs';
import { refreshMembers } from './members.mjs';
import { refreshRecruitment } from './recruitment.mjs';
import { publishRoster } from './roster.mjs';
import { applicationQueue } from './application-status.mjs';
import { cancelActivity } from './activities.mjs';
import { decidePromotion,promotionVotes,promotionVoteReply,PROMOTION_LEAD_ROLE_ID } from './promotions.mjs';
import { missions,missionDay } from './mission-definitions.mjs';

const secret = () => randomBytes(32).toString('base64url');
const digest = value => createHash('sha256').update(value).digest('hex');
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const assets = new Map([
  ['/dashboard', ['index.html', 'text/html; charset=utf-8']],
  ['/dashboard/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/dashboard/style.css', ['style.css', 'text/css; charset=utf-8']]
].map(([path, [file, type]]) => [path, { body: readFileSync(new URL(`dashboard-assets/${file}`, import.meta.url)), type }]));
const security = {
  'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY', 'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://cdn.discordapp.com https://media.discordapp.net; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
};
class HTTPError extends Error { constructor(status, message) { super(message); this.status = status; } }
const failure = (test, status, message) => { if (!test) throw new HTTPError(status, message); };
async function bodyJSON(request) {
  failure(request.headers['content-type']?.startsWith('application/json'), 415, 'Stuur geldige JSON.');
  let text = '';
  for await (const part of request) { text += part.toString('utf8'); failure(Buffer.byteLength(text) <= 32768, 413, 'Het verzoek is te groot.'); }
  let value;
  try { value = JSON.parse(text); } catch { throw new HTTPError(400, 'Ongeldige JSON.'); }
  failure(value && typeof value === 'object' && !Array.isArray(value), 400, 'Ongeldig verzoek.');
  return value;
}

export class Dashboard {
  constructor({ client, contexts, locks, origin, allowLocalPreview = false }) {
    this.client = client; this.contexts = contexts; this.locks = locks;
    this.origin = origin || (() => contexts.values().next().value?.config.transcriptSiteURL);
    this.allowLocalPreview = allowLocalPreview;
    this.logins = new Map(); this.sessions = new Map();
  }
  currentOrigin() {
    const value = this.connection ? this.connection.origin : this.origin();
    assertUser(value, this.connection?.error || 'Het dashboard maakt verbinding. Gebruik /dashboard opnieuw zodra de console "dashboard bereikbaar" toont.');
    const url = new URL(value);
    assertUser(url.protocol === 'https:' || (this.allowLocalPreview && url.protocol === 'http:' && ['localhost','127.0.0.1'].includes(url.hostname)), 'Het dashboard moet HTTPS gebruiken.');
    return url.origin;
  }
  setConnection(origin, error = '') { this.connection = { origin, error }; }
  prune(now = Date.now()) {
    for (const [key, entry] of this.logins) if (entry.expires <= now) this.logins.delete(key);
    for (const [key, entry] of this.sessions) if (entry.expires <= now) this.sessions.delete(key);
  }
  issueLogin(userId, guildId) {
    assertUser(/^\d{17,20}$/.test(userId) && this.contexts.has(guildId), 'Ongeldige dashboardtoegang.');
    const origin = this.currentOrigin();
    this.prune();
    const code = secret();
    for (const [key, item] of this.logins) if (item.userId === userId) this.logins.delete(key);
    this.logins.set(digest(code), { userId, guildId, expires: Date.now() + 120000 });
    return `${origin}/dashboard#login=${code}`;
  }
  cookieName() { return this.allowLocalPreview ? 'legion-preview-session' : '__Host-legion-session'; }
  cookie(value, maxAge) { return `${this.cookieName()}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${this.allowLocalPreview ? '' : '; Secure'}`; }
  session(request) {
    this.prune();
    const value = request.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(this.cookieName() + '='))?.slice(this.cookieName().length + 1);
    const session = value ? this.sessions.get(digest(value)) : null;
    failure(session, 401, 'Gebruik /dashboard in Discord om veilig in te loggen.');
    return session;
  }
  async authorized(session, guildId) {
    const ctx = this.contexts.get(guildId), guild = this.client.guilds.cache.get(guildId);
    failure(ctx && guild, 404, 'Deze guild hoort niet bij Legion.');
    failure(ctx.ready && this.client.isReady(), 503, 'De bot start nog op.');
    let member;
    try { member = await guild.members.fetch({ user: session.userId, force: true }); }
    catch (error) { throw new HTTPError(error.code === 10007 ? 403 : 503, error.code === 10007 ? 'Je zit niet meer in deze guild.' : 'Discordtoegang kan nu niet worden gecontroleerd.'); }
    failure(member.permissions.has(P.Administrator) || ctx.config.staffRoleIds.some(id => member.roles.cache.has(id)), 403, 'Alleen de leiding van deze guild heeft dashboardtoegang.');
    return { ctx, guild, member };
  }
  async sessionInfo(session) {
    const guilds = []; let user;
    for (const id of this.contexts.keys()) {
      try {
        const { ctx, guild, member } = await this.authorized(session, id);
        user ||= { id: member.id, name: member.displayName, avatar: member.displayAvatarURL?.({ size: 64 }) || null };
        guilds.push({ id, name: guild.name, icon: guild.iconURL?.({ size: 64 }) || null, ticketsEnabled: ctx.config.ticketsEnabled, admin: member.permissions.has(P.Administrator) });
      } catch (error) { if (![403,404].includes(error.status)) throw error; }
    }
    failure(guilds.length, 403, 'Je hebt geen leidingtoegang meer.');
    return { user, guilds, selectedGuild: guilds.some(g => g.id === session.guildId) ? session.guildId : guilds[0].id, csrf: session.csrf, expires: session.expires };
  }
  summary(ctx, guild, viewer) {
    const { config, store } = ctx;
    const name = id => guild.members.cache.get(id)?.displayName || id;
    const avatar = id => guild.members.cache.get(id)?.displayAvatarURL?.({ size: 64 }) || null;
    const queue=applicationQueue(store);
    const cases = store.db.prepare("SELECT c.*,a.status AS dm_status,a.last_error AS dm_error FROM cases c LEFT JOIN acceptance_notifications a ON a.case_id=c.id WHERE c.status!='creating' ORDER BY c.created_at DESC LIMIT 200").all().map(({ payload, ...item }) => ({ ...item, queue:queue.get(item.id)||null, owner_name: name(item.owner_id), owner_avatar: avatar(item.owner_id) }));
    const transcripts = store.db.prepare("SELECT c.id,c.kind,c.status,c.owner_id,c.closed_at,t.state,v.view_id,v.secret_key FROM cases c LEFT JOIN transcripts t ON t.case_id=c.id LEFT JOIN transcript_views v ON v.case_id=c.id WHERE c.status IN ('accepted','rejected','closed') ORDER BY c.closed_at DESC LIMIT 200").all().map(({ view_id, secret_key, ...item }) => ({ ...item, owner_name: name(item.owner_id), url: view_id && config.transcriptSiteURL ? this.allowLocalPreview ? `${this.currentOrigin()}/t/${view_id}#k=${secret_key}` : transcriptViewURL(config, { view_id, secret_key }) : null }));
    const warnings = store.db.prepare('SELECT * FROM warnings ORDER BY created_at DESC LIMIT 200').all().map(item => ({ ...item, user_name: name(item.user_id), actor_name: name(item.actor_id) }));
    const wallets = new Map(store.db.prepare('SELECT user_id,balance FROM wallets').all().map(item => [item.user_id,item.balance]));
    const ranked = config.roster?.roleIds || [];
    const members = [...guild.members.cache.values()].filter(member => !member.user.bot).map(member => {
      const roleId = ranked.find(id => member.roles.cache.has(id));
      return { id: member.id, name: member.displayName, avatar: member.displayAvatarURL?.({size:64}) || null, rank: roleId ? guild.roles.cache.get(roleId)?.name : null,
        rankOrder: roleId ? ranked.indexOf(roleId) : 999, legion: Boolean(config.memberRoleId && member.roles.cache.has(config.memberRoleId)), coins: wallets.get(member.id) ?? null };
    }).sort((a,b) => a.rankOrder-b.rankOrder || a.name.localeCompare(b.name,'nl'));
    const invitations = store.db.prepare('SELECT case_id,owner_id,target_guild_id,status,expires_at,last_error FROM acceptance_notifications ORDER BY rowid DESC LIMIT 100').all().map(item => ({ ...item, owner_name: name(item.owner_id) }));
    const activity = store.db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 80').all().map(item => ({ ...item, actor_name: name(item.actor_id), details: JSON.parse(item.details) }));
    const totals = store.db.prepare("SELECT COALESCE(SUM(kind='ticket' AND status='open'),0) AS tickets,COALESCE(SUM(kind='application' AND status='open'),0) AS applications,COALESCE(SUM(status='accepted'),0) AS accepted FROM cases").get();
    return { guild: { id: guild.id, name: guild.name, ticketsEnabled: config.ticketsEnabled, warningsEnabled: Boolean(config.warnLogChannelId), memberRoleId: config.memberRoleId, staffRoleNames: config.staffRoleIds.map(id => guild.roles.cache.get(id)?.name || id) },
      overview: { members: members.length, legionMembers: members.filter(member => member.legion).length, openTickets: totals.tickets,
        openApplications: totals.applications, accepted: totals.accepted,
        savedTranscripts: store.db.prepare('SELECT COUNT(*) AS total FROM transcript_views').get().total, activeWarns: store.db.prepare('SELECT COUNT(*) AS total FROM warnings WHERE removed_at IS NULL').get().total,
        pendingExports: store.db.prepare("SELECT COUNT(*) AS total FROM transcripts WHERE state NOT IN ('done','unavailable')").get().total,
        pendingDMs: store.db.prepare("SELECT COUNT(*) AS total FROM acceptance_notifications WHERE status IN ('pending','dm_blocked')").get().total,
        uptime: Math.round(process.uptime()), latency: Math.max(0, this.client.ws?.ping || 0), memoryMB: Math.round(process.memoryUsage().rss / 1048576), quota: ctx.recruitment || null },
      cases, transcripts, warnings, members, invitations, activity,
      leaderboard: [...wallets].sort((a,b) => b[1]-a[1]).slice(0,20).map(([id,balance]) => ({ id,name:name(id),balance })),
      settings: { warnThreshold: config.warnThreshold, startingCoins: config.startingCoins, dailyCoins: config.dailyCoins, maxBet: config.maxBet, gamesMembersOnly: config.gamesMembersOnly, content: config.content },
      panels: store.db.prepare("SELECT key,value FROM settings WHERE key LIKE 'panel:%'").all().map(item => { const [,type,channelId] = item.key.split(':'); return { type,channelId,messageId:item.value,url:`https://discord.com/channels/${guild.id}/${channelId}/${item.value}` }; }),
      channels: [...guild.channels.cache.values()].filter(channel => channel.type === 0).map(channel => ({id:channel.id,name:channel.name})),
      commands: commands(config.maxBet,config.ticketsEnabled).map(command => ({name:command.name,description:command.description})),
      admission: config.admission ? { targetGuildId: config.admission.targetGuildId, maxAge: config.admission.inviteMaxAgeSeconds, restricted: true, maxUses: 1 } : null,
      roster: config.roster || null,
      planningChannelId:config.planningChannelId,
      plannings:store.db.prepare('SELECT * FROM activities ORDER BY starts_at DESC LIMIT 100').all().map(item=>({...item,url:item.message_id?`https://discord.com/channels/${guild.id}/${item.channel_id}/${item.message_id}`:null,participants:store.db.prepare('SELECT user_id,response FROM activity_rsvps WHERE activity_id=? ORDER BY updated_at').all(item.id).map(person=>({...person,name:name(person.user_id)}))})),
      canVotePromotions:viewer?.roles.cache.has(PROMOTION_LEAD_ROLE_ID)??false,
      promotions:store.db.prepare('SELECT * FROM promotions ORDER BY created_at DESC LIMIT 100').all().map(item=>({...item,voting:promotionVotes(ctx,item.id),member_name:name(item.member_id),role_name:guild.roles.cache.get(item.role_id)?.name||item.role_id,url:item.message_id?`https://discord.com/channels/${guild.id}/${item.channel_id}/${item.message_id}`:null})),
      missions:{day:missionDay(),definitions:missions,claimedToday:store.db.prepare('SELECT COUNT(*) AS total FROM mission_claims WHERE day=?').get(missionDay()).total} };
  }
  async interaction(ctx, guild, member, caseId) {
    const dossier = ctx.store.caseById(caseId);
    assertUser(dossier && dossier.status === 'open', 'Dit dossier is niet meer open.');
    const channel = await guild.channels.fetch(dossier.channel_id);
    assertUser(channel?.guildId === guild.id && channel.topic?.includes(`dossier:${caseId} |`), 'Dit kanaal hoort niet bij het dossier.');
    let result = '';
    return { guild, guildId:guild.id, member, memberPermissions:member.permissions, user:member.user, client:this.client,
      channel,channelId:channel.id, editReply:async value => { result=value.content || ''; }, reply:async value => { result=value.content || ''; },
      result:() => result };
  }
  async action(ctx, guild, member, value) {
    const { store, config } = ctx;
    const actor = member.id;
    if(value.action==='planning.cancel') {
      assertUser(/^[a-f0-9]{12}$/.test(value.id)&&value.confirm===true,'Bevestig eerst welke planning je wilt annuleren.');
      await cancelActivity(ctx,guild,value.id,actor);
      return {message:'Planning geannuleerd. Nieuwe aanwezigheidsreacties worden niet meer verwerkt.'};
    }
    if(['promotion.approve','promotion.reject'].includes(value.action)) {
      assertUser(/^[a-f0-9]{12}$/.test(value.id)&&value.confirm===true,'Bevestig eerst welk promotievoorstel je wilt beoordelen.');
      const result=await decidePromotion(ctx,guild,member,value.id,value.action.endsWith('approve')?'approve':'reject');
      return {message:promotionVoteReply(result)};
    }
    const reason = () => { assertUser(typeof value.reason === 'string' && value.reason.trim() && value.reason.length <= 500, 'Geef een reden van maximaal 500 tekens.'); return value.reason.trim(); };
    const userId = () => { assertUser(/^\d{17,20}$/.test(value.userId), 'Kies een geldig Discord-lid.'); return value.userId; };
    if (value.action === 'warn.add') {
      await warnLogChannel(guild,config);
      const user = userId(), why = reason();
      assertUser(user !== actor, 'Je kunt jezelf geen gangwarn geven.');
      const target = await guild.members.fetch({user,force:true});
      assertUser(!target.user.bot && (member.permissions.has(P.Administrator) || (!target.permissions.has(P.Administrator) && member.roles.highest.comparePositionTo(target.roles.highest) > 0)), 'Je kunt geen bot, administrator of lid met een gelijke/hogere rang waarschuwen.');
      const result = store.addWarn(user,actor,why);
      const logged = await writeWarnLog(ctx,guild,'Legion | Gangwarn gegeven', `Lid: <@${user}>\nDoor: <@${actor}>\nID: \`${result.id}\`\nReden: ${safeText(why)}\nActieve warns: **${result.count}**${result.count>=config.warnThreshold?'\n⚠️ De ingestelde warn-drempel is bereikt.':''}`);
      await target.user.send({content:`Je hebt een gangwarn ontvangen in **${safeText(guild.name)}**.\nReden: ${safeText(why)}\nActieve warns: **${result.count}**\nID: \`${result.id}\``,allowedMentions:{parse:[]}}).catch(()=>{});
      return { message:`Gangwarn gegeven.${logged ? '' : ' De log staat lokaal opgeslagen.'}` };
    }
    if (value.action === 'warn.remove') {
      await warnLogChannel(guild,config);
      assertUser(/^[a-f0-9]{12}$/.test(value.id), 'Ongeldige gangwarn.');
      const why = reason(), removed = store.removeWarn(value.id,actor,why);
      await writeWarnLog(ctx,guild,'Gangwarn ingetrokken',`ID: \`${value.id}\` • <@${removed.user_id}>\nDoor: <@${actor}>\nReden: ${safeText(why)}`);
      return { message:'Gangwarn ingetrokken. De historie blijft bewaard.' };
    }
    if (value.action === 'coins.adjust') {
      const user = userId(), why = reason(); await guild.members.fetch({user,force:true});
      return { message:`Saldo bijgewerkt naar ${store.adjustCoins(user,value.amount,actor,why)} ${config.content.coinName}.` };
    }
    if (value.action === 'settings.save') {
      const checked = validateDashboardSettings(value.settings);
      assertUser(!checked.gamesMembersOnly || config.memberRoleId,'Stel eerst een ledenrol in.');
      const desiredMax = checked.maxBet;
      if (desiredMax !== undefined) assertUser(Number.isSafeInteger(desiredMax) && desiredMax>=2 && desiredMax<=100000,'Kies een maximale inzet tussen 2 en 100000.');
      if (desiredMax !== undefined && desiredMax!==config.maxBet) await this.client.rest.put(Routes.applicationGuildCommands(config.clientId,guild.id),{body:commands(desiredMax,config.ticketsEnabled)});
      saveDashboardSettings(ctx,checked,actor);
      for (const item of store.db.prepare("SELECT key FROM settings WHERE key LIKE 'panel:%'").all()) { const [,type,id]=item.key.split(':'); await publishPanel(ctx,guild,id,type); }
      return { message:'Instellingen opgeslagen en Discord-panelen bijgewerkt.' };
    }
    if (value.action === 'panel.refresh') {
      for (const item of store.db.prepare("SELECT key FROM settings WHERE key LIKE 'panel:%'").all()) { const [,type,id]=item.key.split(':'); await publishPanel(ctx,guild,id,type); }
      return { message:'Panelen in Discord bijgewerkt.' };
    }
    if (value.action === 'members.refresh') {
      await refreshMembers(guild); if (config.recruitment) await refreshRecruitment(ctx,guild); if (config.roster) await publishRoster(ctx,guild);
      return { message:'Ledenlijst en sollicitatiestatus bijgewerkt.' };
    }
    if (value.action === 'admission.resend') {
      assertUser(/^[a-f0-9]{12}$/.test(value.id) && store.acceptance(value.id), 'Geen aannamebericht gevonden.');
      const result=await resendAcceptance(ctx,this.client,value.id);
      return { message:['sent','joined'].includes(result.status) ? 'Het aannamebericht is verzonden.' : result.status==='dm_blocked' ? 'De ontvanger heeft DM’s geblokkeerd. De uitnodiging is persoonlijk bewaard.' : 'Het bericht staat in de verzendwachtrij.' };
    }
    if (value.action === 'case.decision' || value.action === 'case.interview') {
      assertUser(/^[a-f0-9]{12}$/.test(value.id), 'Ongeldig dossier.');
      failure(value.confirm === true,400,'Bevestig deze actie eerst.');
      const execute=async()=>{
        const interaction=await this.interaction(ctx,guild,member,value.id);
        if(value.action==='case.interview') await startInterview(ctx,interaction,value.id);
        else { assertUser(['accept','reject','close'].includes(value.decision),'Kies aannemen, afwijzen of sluiten.'); await decideCase(ctx,interaction,value.id,value.decision); }
        return {message:interaction.result() || 'Dossier bijgewerkt.'};
      };
      const decisionKey=`${guild.id}:case-decision:${value.id}`;
      return value.decision==='accept' ? this.locks.run(`${guild.id}:accept-member`,()=>this.locks.run(decisionKey,execute)) : this.locks.run(decisionKey,execute);
    }
    throw new HTTPError(400,'Onbekende dashboardactie.');
  }
  async handle(request,response) {
    const path=new URL(request.url,'http://localhost').pathname;
    if(path!=='/' && !path.startsWith('/dashboard') && !path.startsWith('/api/dashboard')) return false;
    const send=(status,value,extra={})=>{ response.writeHead(status,{...security,'Content-Type':'application/json; charset=utf-8',...extra}); response.end(request.method==='HEAD'?undefined:JSON.stringify(value)); };
    try {
      if(path==='/'){ response.writeHead(302,{...security,Location:'/dashboard'});response.end();return true; }
      const asset=assets.get(path==='/dashboard/'?'/dashboard':path);
      if(asset){ failure(['GET','HEAD'].includes(request.method),405,'Alleen lezen toegestaan.'); response.writeHead(200,{...security,'Content-Type':asset.type});response.end(request.method==='HEAD'?undefined:asset.body);return true; }
      if(request.method==='POST') failure(request.headers.origin===this.currentOrigin(),403,'Dit verzoek komt niet van het Legion-dashboard.');
      if(path==='/api/dashboard/login'){
        failure(request.method==='POST',405,'Gebruik POST.');
        const body=await bodyJSON(request); failure(/^[A-Za-z0-9_-]{43}$/.test(body.code),401,'Ongeldige inloglink.');
        this.prune(); const key=digest(body.code), pending=this.logins.get(key); failure(pending,401,'Deze inloglink is verlopen of al gebruikt. Gebruik opnieuw /dashboard.');
        this.logins.delete(key); await this.authorized(pending,pending.guildId);
        const token=secret(), session={userId:pending.userId,guildId:pending.guildId,csrf:secret(),expires:Date.now()+1800000};
        for(const [key,item] of this.sessions) if(item.userId===session.userId)this.sessions.delete(key);
        this.sessions.set(digest(token),session);
        send(200,await this.sessionInfo(session),{'Set-Cookie':this.cookie(token,1800)});return true;
      }
      const session=this.session(request);
      if(request.method==='POST') failure(same(request.headers['x-csrf-token'],session.csrf),403,'De sessiebeveiliging is verlopen. Open het dashboard opnieuw.');
      if(path==='/api/dashboard/logout'){
        failure(request.method==='POST',405,'Gebruik POST.');
        for(const [key,item] of this.sessions)if(item===session)this.sessions.delete(key);
        send(200,{ok:true},{'Set-Cookie':this.cookie('',0)});return true;
      }
      if(path==='/api/dashboard/session'){ failure(request.method==='GET',405,'Gebruik GET.');send(200,await this.sessionInfo(session));return true; }
      const match=/^\/api\/dashboard\/guilds\/(\d{17,20})\/(summary|actions|cases\/([a-f0-9]{12})\/messages)$/.exec(path);
      failure(match,404,'Pagina niet gevonden.');
      const {ctx,guild,member}=await this.authorized(session,match[1]);
      if(match[2]==='summary'){ failure(request.method==='GET',405,'Gebruik GET.');send(200,this.summary(ctx,guild,member));return true; }
      if(match[2]==='actions'){
        failure(request.method==='POST',405,'Gebruik POST.'); const value=await bodyJSON(request);
        const key=`${guild.id}:dashboard:${member.id}`;
        const result=await this.locks.run(key,()=>this.action(ctx,guild,member,value)); send(200,result);return true;
      }
      failure(request.method==='GET',405,'Gebruik GET.');
      const dossier=ctx.store.caseById(match[3]);failure(dossier,404,'Dossier niet gevonden.');
      if(dossier.status!=='open'){send(200,{messages:[],closed:true});return true;}
      const channel=await guild.channels.fetch(dossier.channel_id);failure(channel?.guildId===guild.id && channel.topic?.includes(`dossier:${dossier.id} |`),404,'Dossierkanaal niet gevonden.');
      send(200,{messages:await fetchTranscriptMessages(channel,Infinity),closed:false});return true;
    }catch(error){ send(error.status || (error instanceof UserError ? 400 : 503),{error:error.status || error instanceof UserError ? error.message : 'Deze actie kon nu niet worden uitgevoerd. Probeer opnieuw.'});return true; }
  }
  close(){this.sessions.clear();this.logins.clear();}
}
