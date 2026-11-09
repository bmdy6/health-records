import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHealthCommand, dateRange, boundedRows, primaryGoal } from './health-agent.mjs';
test('health CLI validates explicit ranges, IDs and stdin structure without truncation',()=>{
 assert.equal(parseHealthCommand(['workout','list','2026-10-01','2026-10-30']).kind,'workout');
 assert.throws(()=>parseHealthCommand(['weight','list']));assert.throws(()=>dateRange('2026-02-30','2026-03-03'));assert.throws(()=>dateRange('2026-01-01','2028-01-01'));
 assert.throws(()=>parseHealthCommand(['workout','update','../x'],'{}'));assert.throws(()=>parseHealthCommand(['goal','get'],'{}'));
 assert.throws(()=>parseHealthCommand(['goal','set'],'{"mutation_id":"x","expected":null,"patch":{},"extra":1}'));
 const records=Array.from({length:1001},(_,i)=>({id:String(i),date:'2026-10-30'}));assert.throws(()=>boundedRows({records}));
});
test('goal set uses stable primary creation and exact snapshot update',async()=>{
 const calls=[];const store={addGoals:async a=>{calls.push(a);return a.items;},updateGoal:async a=>{calls.push(a);return a.patch;}};
 await primaryGoal(store,{mutation_id:'m',expected:null,patch:{date:'2026-10-30',startKg:70,targetKg:65}});assert.equal(calls[0].items[0].id,'primary');
 const expected={id:'primary'};await primaryGoal(store,{mutation_id:'n',expected,patch:{targetKg:66}});assert.equal(calls[1].expected,expected);assert.equal(calls[1].id,'primary');
});

test('CLI health context returns authorized food and shared summaries with future anchor capped',async()=>{
 const {runHealth,healthModule}=await import('./health-agent.mjs');
 const profile={heightCm:175,weightKg:70,age:30,sex:'male',activity:1.2,updatedAt:1};
 const food={id:'rice',date:'2026-10-30',food:'rice',kcal:200,protein:4,carbs:40,fat:1,createdAt:1,updatedAt:1,deleted:false};
 const requests=[];
 const fetchImpl=async(url,init)=>{
  assert.notEqual(init?.method,'PUT');requests.push(String(url));
  const value=String(url).endsWith('_settings.json')?{}:String(url).endsWith('profile.json')?profile:String(url).endsWith('food.json')?[food]:[];
  return new Response(JSON.stringify(value),{headers:{etag:'"1"'}});
 };
 const env={HEALTH_WEBDAV_URL:'https://dav.example/wb/',HEALTH_WEBDAV_USER:'owner',HEALTH_WEBDAV_PASSWORD:'test-only'};
 const context=await runHealth(['health','context','2026-10-30','2026-10-30'],'',{env,fetchImpl});
 const {summarizeNutrition,summarizeProgress,summarizeWeek,composeHealthContext,shanghaiToday}=await healthModule();
 assert.equal(context.foods.length,1);assert.equal(context.coverage.foods,true);
 assert.deepEqual(context.summaries.nutrition,summarizeNutrition(context.foods,profile,null,context.asOf));
 assert.deepEqual(context.summaries.progress,summarizeProgress([],null,context.asOf));
 assert.deepEqual(context.summaries.weekly,summarizeWeek(context.foods,[],context.asOf));
 assert.equal(shanghaiToday(Date.parse('2026-10-30T18:00:00Z')),'2026-10-31');
 const snapshot={records:[],path:'body/owner/workouts.json',etag:'"1"',exists:false};
 const health={readWorkouts:async()=>snapshot,readGoals:async()=>({...snapshot,path:'body/owner/health-goals.json'}),readWeights:async()=>({...snapshot,path:'body/owner/weights.json'}),readProfile:async()=>null};
 const future=await composeHealthContext(health,null,'2026-10-01','2026-11-30','2026-10-30');assert.equal(future.asOf,'2026-10-30');assert.equal(future.summaries.nutritionReason,'food-scope-unavailable');assert.equal(future.summaries.weekly.foodRecords,null);
 await assert.rejects(composeHealthContext(health,{read:async()=>({...snapshot,path:'body/shared/foods.json'})},'2026-10-01','2026-10-30','2026-10-30'),e=>e.code==='conflict');
});
