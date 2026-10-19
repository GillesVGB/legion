import test from 'node:test';
import assert from 'node:assert/strict';
import {dashboardFixture,ACTOR,OTHER} from './dashboard-fixture.mjs';
import {recordGangpotAsset,voidGangpotAsset,gangpotAssets,assetBalance} from '../src/gangpot-assets.mjs';
import {gangpotBalance,gangpotTotalMessage,gangpotMoney} from '../src/gangpot.mjs';
import {Dashboard} from '../src/dashboard.mjs';
import {Locks} from '../src/locks.mjs';
const NOW=Date.parse('2026-10-20T10:00:00Z');
function fixture(t){const f=dashboardFixture();t.after(f.close);const ctx=f.contexts.values().next().value,guild=f.guilds.get(ctx.config.guildId),lead=guild.members.cache.get(ACTOR);return{...f,ctx,guild,lead};}
const entry=(f,options={})=>recordGangpotAsset(f.ctx,{kind:'item',name:'Repairkits',quantity:5,direction:'in',actor:ACTOR,requestId:'asset-request-001',...options},NOW);
test('items en zwartgeld blijven apart van gewoon geld, weekbetalingen en coins; dubbele verzoeken tellen eenmaal',t=>{
  const f=fixture(t),before=f.ctx.store.wallet(OTHER).balance;
  entry(f);entry(f);entry(f,{kind:'blackmoney',quantity:25000,requestId:'blackmoney-request'});
  assert.equal(assetBalance(f.ctx,'item',' REPAIRKITS '),5);assert.equal(gangpotAssets(f.ctx).blackMoney,25000);assert.equal(gangpotBalance(f.ctx),0);
  assert.equal(f.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM gangpot_entries').get().n,0);assert.equal(f.ctx.store.wallet(OTHER).balance,before);
  assert.throws(()=>entry(f,{quantity:6}),/andere registratie/);assert.equal(gangpotAssets(f.ctx).history.length,2);
  const card=gangpotTotalMessage(f.ctx,f.guild,NOW).embeds[0].data;assert.match(card.fields.find(field=>field.name==='Zwartgeld').value,/€25.000/);assert.match(card.fields.find(field=>field.name==='Items in de gangpot').value,/repairkits/);
  assert.equal(gangpotMoney(25000),'€25.000');assert.doesNotMatch(card.description,/\$/);
});
test('opnames en correcties kunnen geen negatieve voorraad maken en behouden alle historische registraties',t=>{
  const f=fixture(t),deposit=entry(f),withdrawal=entry(f,{direction:'out',quantity:3,requestId:'withdraw-request'});
  assert.throws(()=>entry(f,{direction:'out',quantity:3,requestId:'too-much-request'}),/negatieve/);
  assert.throws(()=>voidGangpotAsset(f.ctx,deposit.id,ACTOR,'Fout',NOW+1),/eerst/);
  voidGangpotAsset(f.ctx,withdrawal.id,ACTOR,'Opname niet uitgevoerd',NOW+2);voidGangpotAsset(f.ctx,deposit.id,ACTOR,'Niet ontvangen',NOW+3);
  assert.equal(assetBalance(f.ctx,'item','repairkits'),0);assert.equal(gangpotAssets(f.ctx).history.length,2);
  assert.throws(()=>entry(f,{quantity:0,requestId:'invalid-request'}),/positief/);
  assert.throws(()=>recordGangpotAsset(f.source,{kind:'item',name:'test',quantity:1,direction:'in',actor:ACTOR,requestId:'other-guild-request'}),/hoofdserver/);
});
test('dashboardvoorraad vereist actuele leidingrechten en bevestiging; beide soorten verschijnen in de samenvatting',async t=>{
  const f=fixture(t);t.mock.method(Date,'now',()=>NOW);const dashboard=new Dashboard({...f,locks:new Locks()});
  const input={action:'gangpot.asset',kind:'item',name:'Koffers <test>',quantity:2,direction:'in',requestId:'dashboard-asset-request',confirm:true};
  await assert.rejects(dashboard.action(f.ctx,f.guild,f.guild.members.cache.get(OTHER),input));
  await assert.rejects(dashboard.action(f.ctx,f.guild,f.lead,{...input,confirm:false}),/Bevestig/);
  await dashboard.action(f.ctx,f.guild,f.lead,input);assert.equal(dashboard.summary(f.ctx,f.guild,f.lead).gangpot.assets.items[0].quantity,2);
});
