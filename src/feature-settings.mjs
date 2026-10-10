import {assertUser} from './errors.mjs';
export const featureDefaults={
  gangpot:{weeklyAmount:25000,deadlineTime:'23:59',remindersEnabled:true,fridayTime:'18:00',saturdayTime:'18:00',leadReminderEnabled:true,leadTime:'20:00'},
  planning:{requireApproval:true,duration:120,title:'Gangactiviteit',preparation:'Zorg dat je volledig bent geheald. Tank je voertuig helemaal vol. Neem repairkits en de benodigde spullen mee. Sta op tijd klaar en volg de aanwijzingen van de leiding.'},
  fishing:{collectionEnabled:true,weeklyEnabled:true,target:25,rareTarget:3,reward:750,rareReward:400},
  absence:{maxDays:90},logs:{enabled:true,batchSize:15},recruitment:{capacity:25,limitedAt:20,minimumAge:16},admission:{inviteMaxAgeSeconds:86400}
};
const bounds={weeklyAmount:[1,100000000],duration:[15,720],target:[1,10000],rareTarget:[1,1000],reward:[1,1000000],rareReward:[1,1000000],maxDays:[1,180],batchSize:[1,20],capacity:[2,1000],limitedAt:[1,999],minimumAge:[1,100],inviteMaxAgeSeconds:[300,604800]};
export function operationSettings(ctx){return Object.fromEntries(Object.entries(featureDefaults).map(([group,defaults])=>[group,{...defaults,...(group==='gangpot'?{weeklyAmount:ctx.config.gangpot?.weeklyAmount??defaults.weeklyAmount}:{}),...ctx.config.operations?.[group]}]));}
export function validateOperations(value){
  assertUser(value&&typeof value==='object'&&!Array.isArray(value),'Ongeldige module-instellingen.');const result={};
  for(const [group,settings] of Object.entries(value)){
    assertUser(Object.hasOwn(featureDefaults,group)&&settings&&typeof settings==='object'&&!Array.isArray(settings),'Onbekende module.');result[group]={};
    for(const [key,input] of Object.entries(settings)){
      const defaults=featureDefaults[group];assertUser(Object.hasOwn(defaults,key),'Onbekende module-instelling.');
      if(typeof defaults[key]==='boolean')assertUser(typeof input==='boolean','Kies aan of uit.');
      else if(bounds[key])assertUser(Number.isSafeInteger(input)&&input>=bounds[key][0]&&input<=bounds[key][1],`${key}: kies ${bounds[key][0]} tot ${bounds[key][1]}.`);
      else if(key.endsWith('Time'))assertUser(typeof input==='string'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(input),'Gebruik een tijd in UU:MM.');
      else assertUser(typeof input==='string'&&input.trim()&&input.length<=(key==='preparation'?700:80),'Gebruik een geldige tekst.');
      result[group][key]=typeof input==='string'?input.trim():input;
    }
  }return result;
}
export function applyOperations(ctx,values){
  const merged=operationSettings(ctx);for(const [group,settings] of Object.entries(values))Object.assign(merged[group],settings);
  assertUser((!merged.gangpot.remindersEnabled||merged.gangpot.saturdayTime<merged.gangpot.deadlineTime)&&(!merged.gangpot.leadReminderEnabled||merged.gangpot.leadTime<merged.gangpot.deadlineTime),'De zaterdagherinneringen moeten vóór de deadline staan.');
  assertUser(merged.recruitment.limitedAt<merged.recruitment.capacity,'De grens voor beperkte plaatsen moet lager dan de capaciteit zijn.');
  ctx.config.operations=merged;if(ctx.config.gangpot)Object.assign(ctx.config.gangpot,merged.gangpot);
  if(ctx.config.recruitment)Object.assign(ctx.config.recruitment,merged.recruitment);if(ctx.config.admission)Object.assign(ctx.config.admission,merged.admission);
}
