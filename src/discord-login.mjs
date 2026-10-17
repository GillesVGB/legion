import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';

const random=()=>randomBytes(32).toString('base64url');
const hash=value=>createHash('sha256').update(value).digest('hex');
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
export class DiscordLoginError extends Error {
  constructor(reason){super('Discord-inloggen kon niet worden afgerond.');this.reason=reason;}
}
// Only authorization state lives here. Discord access tokens never enter bot data or browser sessions.
export class DiscordLogin {
  constructor({config,origin,preview=false,fetchImpl=fetch}){
    this.config=config;this.origin=origin;this.preview=preview;this.fetch=fetchImpl;this.pending=new Map();
  }
  enabled(){const config=this.config();return /^\d{17,20}$/.test(config?.clientId)&&Boolean(config.discordClientSecret);}
  cookieName(){return this.preview?'legion-preview-oauth':'__Host-legion-oauth';}
  cookie(value,seconds=600){return `${this.cookieName()}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${this.preview?'':'; Secure'}`;}
  browser(request){return request.headers.cookie?.split(';').map(item=>item.trim()).find(item=>item.startsWith(this.cookieName()+'='))?.slice(this.cookieName().length+1);}
  prune(now=Date.now()){for(const [key,item]of this.pending)if(item.expires<=now)this.pending.delete(key);}
  start(request){
    if(!this.enabled())throw new DiscordLoginError('unavailable');
    this.prune();
    if(this.pending.size>=1000)throw new DiscordLoginError('unavailable');
    const previous=this.browser(request);
    if(previous)for(const [key,item]of this.pending)if(equal(item.browser,hash(previous)))this.pending.delete(key);
    const state=random(),browser=random(),origin=this.origin(),redirect=`${origin}/api/dashboard/oauth/callback`;
    this.pending.set(hash(state),{browser:hash(browser),origin,redirect,expires:Date.now()+600000});
    const url=new URL('https://discord.com/oauth2/authorize');
    url.search=new URLSearchParams({client_id:this.config().clientId,response_type:'code',scope:'identify',redirect_uri:redirect,state});
    return{url:url.href,cookie:this.cookie(browser)};
  }
  async complete(request,url){
    this.prune();
    const state=url.searchParams.get('state'),browser=this.browser(request);
    if(!state||!/^[A-Za-z0-9_-]{43}$/.test(state)||!browser||!/^[A-Za-z0-9_-]{43}$/.test(browser)||url.searchParams.getAll('state').length!==1)throw new DiscordLoginError('state');
    const key=hash(state),pending=this.pending.get(key);
    if(!pending||!equal(pending.browser,hash(browser))||pending.origin!==this.origin())throw new DiscordLoginError('state');
    this.pending.delete(key); // Consume before any network call, including denied authorizations.
    if(url.searchParams.has('error'))throw new DiscordLoginError('cancelled');
    const code=url.searchParams.get('code'),issuer=url.searchParams.get('iss');
    if(!code||code.length>2048||url.searchParams.getAll('code').length!==1||(issuer!==null&&(issuer!=='https://discord.com'||url.searchParams.getAll('iss').length!==1)))throw new DiscordLoginError('state');
    if(!this.enabled())throw new DiscordLoginError('unavailable');
    try{
      const config=this.config();
      const tokenResponse=await this.fetch('https://discord.com/api/oauth2/token',{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:config.clientId,client_secret:config.discordClientSecret,grant_type:'authorization_code',code,redirect_uri:pending.redirect})});
      if(!tokenResponse.ok)throw new DiscordLoginError('unavailable');
      const token=await tokenResponse.json();
      if(typeof token.access_token!=='string'||!token.access_token||token.token_type?.toLowerCase()!=='bearer'||!String(token.scope||'').split(' ').includes('identify'))throw new DiscordLoginError('unavailable');
      const identityResponse=await this.fetch('https://discord.com/api/v10/users/@me',{redirect:'error',signal:AbortSignal.timeout(15000),headers:{Authorization:`Bearer ${token.access_token}`}});
      if(!identityResponse.ok)throw new DiscordLoginError('unavailable');
      const identity=await identityResponse.json();
      if(!/^\d{17,20}$/.test(identity.id)||identity.bot)throw new DiscordLoginError('denied');
      return identity.id;
    }catch(error){throw error instanceof DiscordLoginError?error:new DiscordLoginError('unavailable');}
  }
  close(){this.pending.clear();}
}
