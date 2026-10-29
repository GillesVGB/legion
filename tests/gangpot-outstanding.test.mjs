import test from 'node:test';
import assert from 'node:assert/strict';
import {PermissionsBitField} from 'discord.js';
import {dashboardFixture,OTHER} from './dashboard-fixture.mjs';
import {commands} from '../src/commands.mjs';
import {gangpotWindow,gangpotOutstandingMessages,recordGangpotEntry,reportGangpotPayment,gangpotBalance,handleGangpotCommand,GANGPOT_LEAD_ROLE_ID} from '../src/gangpot.mjs';
const NOW=Date.parse('2026-10-29T12:00:00Z');
function fixture(t){
  const f=dashboardFixture();t.after(f.close);const ctx=f.contexts.values().next().value,guild=f.guilds.get(ctx.config.guildId);ctx.guild=guild;
  const period=gangpotWindow(ctx.config.gangpot,NOW),db=ctx.store.db;
  db.prepare('INSERT INTO gangpot_periods(id,starts_at,ends_at,weekly_amount) VALUES(?,?,?,?)').run(period.id,period.starts_at,period.ends_at,period.weekly_amount);
  const add=(number,roles=[ctx.config.gangpot.memberRoleId],active=1)=>{
    const id=String(BigInt('100000000000001000')+BigInt(number));guild.addMember(id,`Lid ${number}`,roles);
    db.prepare('INSERT INTO gangpot_dues(period_id,user_id,enrolled_at,active) VALUES(?,?,?,?)').run(period.id,id,period.starts_at,active);return id;
  };
  const pay=(id,amount)=>recordGangpotEntry(ctx,{kind:'payment',userId:id,periodId:period.id,amount,actor:'lead',requestId:`payment-${id}`,paidAt:NOW},NOW);
  const claim=(id,amount=25000)=>reportGangpotPayment(ctx,{userId:id,periodId:period.id,amount,requestId:`report-${id}`},NOW);
  return{...f,ctx,guild,period,db,add,pay,claim};
}
const text=messages=>messages.map(item=>item.embeds[0].toJSON().description).join('\n');

test('openstaand onderscheidt schuld en wachtende meldingen en sluit Lead, vrijstelling, instapweek en vertrokken leden uit',t=>{
  const f=fixture(t),unpaid=f.add(1),partial=f.add(2),pending=f.add(3),paid=f.add(4),exempt=f.add(5),newMember=f.add(6),left=f.add(7,undefined,0),lead=f.add(8,[f.ctx.config.gangpot.memberRoleId,GANGPOT_LEAD_ROLE_ID]),withdrawn=f.add(9),withoutRole=f.add(10,[]);
  f.pay(partial,5000);f.pay(paid,25000);f.claim(pending);
  f.db.prepare('INSERT INTO gangpot_exemptions(id,user_id,period_id,actor_id,reason,created_at) VALUES(?,?,?,?,?,?)').run('exemption',exempt,f.period.id,'lead','Vrijgesteld',NOW);
  f.db.prepare('INSERT INTO gangpot_memberships(user_id,started_at,required_from,source) VALUES(?,?,?,?)').run(newMember,NOW,f.period.ends_at,'role');
  const oldClaim=f.claim(withdrawn);f.db.prepare('UPDATE gangpot_claims SET withdrawn_at=? WHERE id=?').run(NOW,oldClaim.id);
  const balance=gangpotBalance(f.ctx),warnings=f.db.prepare('SELECT COUNT(*) AS n FROM warnings').get().n,messages=gangpotOutstandingMessages(f.ctx,f.period,NOW),output=text(messages);
  assert.match(output,/Openstaand:\*\* 4 leden/);assert.match(output,/Nog betalen \/ geen open betaalmelding \(3\)/);assert.match(output,/Wacht op Lead-goedkeuring \(1\)/);
  for(const id of [unpaid,partial,pending,withdrawn])assert.ok(output.includes(`<@${id}>`));
  for(const id of [paid,exempt,newMember,left,lead,withoutRole])assert.ok(!output.includes(`<@${id}>`));
  assert.ok(output.includes(`<@${partial}> — nog €20.000`));assert.ok(output.includes(`<@${pending}> — nog €25.000 · gemeld €25.000`));
  assert.equal(gangpotBalance(f.ctx),balance);assert.deepEqual(messages[0].allowedMentions.parse,[]);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM warnings').get().n,warnings);assert.ok(output.includes('€95.000'));
});

test('lange lijsten blijven volledig zichtbaar binnen Discordlimieten en een lege lijst is duidelijk',t=>{
  const f=fixture(t);assert.match(text(gangpotOutstandingMessages(f.ctx,f.period,NOW)),/Geen openstaande verplichte bijdragen/);
  const ids=Array.from({length:120},(_,index)=>f.add(index+1));const messages=gangpotOutstandingMessages(f.ctx,f.period,NOW);
  assert.ok(messages.length>1);for(const id of ids)assert.ok(text(messages).includes(`<@${id}>`));
  for(const item of messages){const card=item.embeds[0].toJSON();assert.ok(card.description.length<=4096);assert.ok(card.description.length+card.title.length+card.footer.text.length<6000);}
});

test('openstaand is geregistreerd in de hoofdserver en gewone leden kunnen het leidingsoverzicht niet openen',async t=>{
  const f=fixture(t),command=commands(10000,false).find(item=>item.name==='gangpot'),subcommand=command.options.find(item=>item.name==='openstaand');
  assert.ok(subcommand);assert.equal(subcommand.options[0].name,'termijn');assert.equal(subcommand.options[0].required,false);
  assert.equal(commands(10000,true).some(item=>item.name==='gangpot'),false);
  const interaction={options:{getSubcommand:()=> 'openstaand'},member:f.guild.members.cache.get(OTHER),memberPermissions:new PermissionsBitField(),deferReply:()=>{throw new Error('Niet toegestaan');}};
  await assert.rejects(handleGangpotCommand(f.ctx,interaction),/Alleen de Bakarov-leiding/);
});
