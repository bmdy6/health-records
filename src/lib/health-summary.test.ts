import { describe, it, expect } from 'vitest';
import { summarizeNutrition, summarizeProgress, summarizeWeek } from './health-summary';
import type { FoodLog, WeightRecord, BodyProfile } from '../types';
import type { HealthGoal, WorkoutLog } from './health-model';
const goal = {id:'g',date:'2026-10-01',startKg:80,targetKg:70,createdAt:1,updatedAt:1,deleted:false} as HealthGoal;
const weight = (date:string,kg:number,extra={}) => ({id:date,date,kg,createdAt:1,updatedAt:1,deleted:false,...extra}) as WeightRecord;
const food = (extra={}) => ({id:'f',date:'2026-10-30',food:'饭',kcal:100,createdAt:1,updatedAt:1,deleted:false,...extra}) as FoodLog;
const profile:BodyProfile = {heightCm:170,weightKg:80,age:30,sex:'male',activity:1.2,kcalOverride:1900,proteinOverride:120,updatedAt:1};
const steady = [weight('2026-10-09',80),weight('2026-10-16',79.5),weight('2026-10-23',79),weight('2026-10-30',78.5)];
describe('nutrition coverage',()=>{
 it('keeps missing macros unknown and respects explicit targets',()=>{const s=summarizeNutrition([food()],profile,{...goal,carbsG:200},'2026-10-30');expect(s.totals.kcal).toBe(100);expect(s.missing.protein).toBe(1);expect(s.targets).toEqual({kcal:1900,protein:120,carbs:200});expect(s.deltas.kcal).toBe(1800);expect(s.deltas.protein).toBeUndefined();expect(s.complete).toBe(false);});
 it('excludes deleted future and invalid dates; no goal/profile invents no target',()=>{const s=summarizeNutrition([food({deleted:true}),food({date:'2026-10-31'}),food({date:'bad'})],null,null,'2026-10-30');expect(s.recordCount).toBe(0);expect(s.targets).toEqual({});expect(s.complete).toBe(false);});
});
describe('progress',()=>{
 it('uses sorted deduped observations and produces a positive finite heuristic range',()=>{const s=summarizeProgress([...steady].reverse().concat(weight('2026-10-30',60,{updatedAt:0}),weight('2026-11-01',30),weight('2026-10-29',20,{deleted:true})),goal,'2026-10-30');expect(s.currentKg).toBe(78.5);expect(s.progressPercent).toBeCloseTo(15);expect(s.estimate.kind).toBe('heuristic-range');if(s.estimate.kind==='heuristic-range'){expect(s.estimate.minDays).toBeGreaterThan(0);expect(s.estimate.maxDays).toBeGreaterThan(s.estimate.minDays);expect(Number.isFinite(s.estimate.maxDays)).toBe(true);}});
 it.each([
 ['no-data',[],goal],['missing-goal',steady,null],['stale-data',steady,goal],
 ] as const)('returns %s with insufficient context',(reason,rows,g)=>{expect(summarizeProgress([...rows],g,reason==='stale-data'?'2026-11-08':'2026-10-30').estimate).toEqual({kind:'unavailable',reason});});
 it('does not treat duplicate dates as observations and handles exact freshness boundary',()=>{expect(summarizeProgress([steady[0],steady[1],steady[2],{...steady[2],id:'dup',updatedAt:2}],goal,'2026-10-30').estimate).toEqual({kind:'unavailable',reason:'insufficient-observations'});expect(summarizeProgress([weight('2026-10-16',80),weight('2026-10-21',79.7),weight('2026-10-26',79.4),weight('2026-10-30',79.1)],goal,'2026-11-06').estimate.kind).toBe('heuristic-range');expect(summarizeProgress(steady,{...goal,deleted:true},'2026-10-30').estimate).toEqual({kind:'unavailable',reason:'missing-goal'});});
 it('suppresses ranges whose early edge has already elapsed',()=>{expect(summarizeProgress(steady,{...goal,targetKg:78.49},'2026-11-02').estimate).toEqual({kind:'unavailable',reason:'range-expired'});});
 it('requires four distinct dates and fourteen days',()=>{expect(summarizeProgress(steady.slice(1),goal,'2026-10-30').estimate).toEqual({kind:'unavailable',reason:'insufficient-observations'});expect(summarizeProgress(steady.map((w,i)=>({...w,date:`2026-10-${27+i}`})),goal,'2026-10-30').estimate).toEqual({kind:'unavailable',reason:'short-observation-span'});});
 it('rejects plateau opposite extreme and nonsteady trends',()=>{for(const [values,reason] of [[[80,80,80,80],'plateau'],[[80,80.5,81,81.5],'opposite-trend'],[[80,78,76,74],'extreme-trend'],[[80,79,80,78.5],'nonsteady-trend']] as const){expect(summarizeProgress(steady.map((w,i)=>({...w,kg:values[i]})),goal,'2026-10-30').estimate).toEqual({kind:'unavailable',reason});}});
 it('handles gain and equal goals, ignores future goals, and shifts estimates from latest measurement',()=>{expect(summarizeProgress(steady.map(w=>({...w,kg:160-w.kg})),{...goal,targetKg:90},'2026-10-30').estimate.kind).toBe('heuristic-range');expect(summarizeProgress(steady,{...goal,startKg:78.5,targetKg:78.5},'2026-10-30').estimate.kind).toBe('achieved');expect(summarizeProgress(steady,{...goal,date:'2026-11-01'},'2026-10-30').estimate).toEqual({kind:'unavailable',reason:'missing-goal'});});
});
describe('week',()=>{it('counts recorded activity only in rolling seven days, including unknown durations',()=>{const w=(date:string,extra={})=>({id:date,date,title:'走路',createdAt:1,updatedAt:1,deleted:false,...extra}) as WorkoutLog;const s=summarizeWeek([food(),food({date:'2026-10-23'})],[w('2026-10-24',{durationMin:20}),w('2026-10-30'),w('2026-10-31'),w('2026-10-29',{deleted:true})],'2026-10-30');expect(s.startDate).toBe('2026-10-24');expect(s.foodRecords).toBe(1);expect(s.workoutCount).toBe(2);expect(s.durationMin).toBe(20);expect(s.missingDurationCount).toBe(1);});});

it('does not report a maintenance goal achieved when the latest weight differs', () => {
  const weights = [{id:'maintain',date:'2026-10-30',kg:80,createdAt:1,updatedAt:1,deleted:false}];
  const goal = {id:'primary',date:'2026-10-01',startKg:70,targetKg:70,createdAt:1,updatedAt:1,deleted:false};
  const result=summarizeProgress(weights,goal,'2026-10-30');
  expect(result.remainingKg).toBe(10);
  expect(result.progressPercent).toBe(0);
  expect(result.estimate.kind).toBe('unavailable');
  expect(summarizeProgress([{...weights[0],kg:70}],goal,'2026-10-30').estimate.kind).toBe('achieved');
});


it('historical reports do not use nutrition targets that start later', () => {
  const food={id:'f',date:'2026-10-29',food:'饭',kcal:160,carbs:40,createdAt:1,updatedAt:1,deleted:false};
  const goal={id:'primary',date:'2026-10-30',startKg:75,targetKg:70,carbsG:200,createdAt:1,updatedAt:1,deleted:false};
  expect(summarizeNutrition([food],null,goal,'2026-10-29').targets.carbs).toBeUndefined();
  expect(summarizeNutrition([{...food,date:'2026-10-30'}],null,goal,'2026-10-30').deltas.carbs).toBe(160);
});
