import type { BodyProfile, FoodLog, WeightRecord } from '../types';
import type { HealthGoal, WorkoutLog } from './health-model';
import { calcDailyNeeds } from './nutrition';

type Nutrient = 'kcal' | 'protein' | 'carbs' | 'fat';
const nutrients: Nutrient[] = ['kcal', 'protein', 'carbs', 'fat'];
export interface NutritionSummary {
  recordCount: number;
  totals: Record<Nutrient, number>;
  missing: Record<Nutrient, number>;
  targets: Partial<Record<Nutrient, number>>;
  /** Target minus known intake; omitted when any record has an unknown amount. */
  deltas: Partial<Record<Nutrient, number>>;
  complete: boolean;
}
export type EstimateReason = 'no-data' | 'missing-goal' | 'invalid-today' | 'stale-data' | 'insufficient-observations' | 'short-observation-span' | 'plateau' | 'opposite-trend' | 'extreme-trend' | 'nonsteady-trend' | 'range-expired' | 'maintenance-goal';
export type ProgressEstimate = {kind: 'unavailable'; reason: EstimateReason} | {kind: 'achieved'} | {
  kind: 'heuristic-range'; earliestDate: string; latestDate: string; minDays: number; maxDays: number; observedKgPerWeek: number;
};
export interface ProgressSummary {
  currentKg?: number; currentDate?: string; startKg?: number; targetKg?: number;
  progressPercent?: number; remainingKg?: number; estimate: ProgressEstimate;
}
export interface WeekSummary {
  startDate: string; endDate: string; foodRecords: number; foodDays: number;
  workoutCount: number; workoutDays: number; durationMin: number; missingDurationCount: number; nutrition: NutritionSummary;
}
const dayMs = 86400000;
const day = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0,10) === date ? Date.parse(`${date}T00:00:00Z`) / dayMs : NaN;
const dateOf = (d: number) => new Date(d * dayMs).toISOString().slice(0,10);
const localToday = () => { const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`; };
const amount = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const active = <T extends {date: string; deleted: boolean}>(rows: readonly T[], today: string) => rows.filter(r => !r.deleted && Number.isFinite(day(r.date)) && day(r.date) <= day(today));

/** Caller selects the reporting period; future/deleted records are always excluded. */
export function summarizeNutrition(foods: readonly FoodLog[], profile: BodyProfile | null | undefined, goal: HealthGoal | null | undefined, today = localToday()): NutritionSummary {
  const rows = active(foods, today);
  const totals = {kcal:0,protein:0,carbs:0,fat:0}; const missing = {...totals};
  for (const row of rows) for (const key of nutrients) { if (amount(row[key])) totals[key] += row[key]; else missing[key]++; }
  const targets: NutritionSummary['targets'] = {};
  if (profile) { const needs = calcDailyNeeds(profile); if (amount(needs.targetKcal) && needs.targetKcal > 0) targets.kcal = needs.targetKcal; if (amount(needs.proteinG.min) && needs.proteinG.min > 0) targets.protein = needs.proteinG.min; }
  if (goal && !goal.deleted && day(goal.date) <= day(today)) { if (amount(goal.carbsG)) targets.carbs = goal.carbsG; if (amount(goal.fatG)) targets.fat = goal.fatG; }
  const deltas: NutritionSummary['deltas'] = {};
  for (const key of nutrients) if (targets[key] !== undefined && missing[key] === 0) deltas[key] = targets[key]! - totals[key];
  return {recordCount:rows.length,totals,missing,targets,deltas,complete:rows.length > 0 && nutrients.every(k=>missing[k]===0)};
}

/** Observational heuristic only: dynamic weight responses preclude a fixed calorie-to-date promise (NIDDK Body Weight Planner principle). */
export function summarizeProgress(weights: readonly WeightRecord[], goal: HealthGoal | null | undefined, today: string): ProgressSummary {
  const result: ProgressSummary = {estimate:{kind:'unavailable',reason:'no-data'}};
  const unavailable = (reason: EstimateReason) => ({...result,estimate:{kind:'unavailable' as const,reason}});
  if (!Number.isFinite(day(today))) return unavailable('invalid-today');
  const dates = new Map<string,WeightRecord>();
  for (const row of active(weights,today).filter(w=>amount(w.kg)&&w.kg>0)) {
    const previous = dates.get(row.date);
    if (!previous || row.updatedAt > previous.updatedAt || (row.updatedAt === previous.updatedAt && row.id.localeCompare(previous.id)>0)) dates.set(row.date,row);
  }
  const sorted = [...dates.values()].sort((a,b)=>a.date.localeCompare(b.date));
  const latest = sorted[sorted.length - 1];
  if (latest) { result.currentKg=latest.kg; result.currentDate=latest.date; }
  if (!goal || goal.deleted || !Number.isFinite(day(goal.date)) || day(goal.date)>day(today) || !amount(goal.startKg) || goal.startKg<=0 || !amount(goal.targetKg) || goal.targetKg<=0) return unavailable('missing-goal');
  result.startKg=goal.startKg; result.targetKg=goal.targetKg;
  if (!latest) return unavailable('no-data');
  const direction = Math.sign(goal.targetKg-goal.startKg);
  result.remainingKg = Math.abs(goal.targetKg-latest.kg);
  result.progressPercent = direction === 0 ? (latest.kg === goal.targetKg ? 100 : 0) : Math.max(0,Math.min(100,(latest.kg-goal.startKg)/(goal.targetKg-goal.startKg)*100));
  if (day(today)-day(latest.date)>7) return unavailable('stale-data');
  if (direction === 0 && latest.kg !== goal.targetKg) return unavailable('maintenance-goal');
  if (direction === 0 || (latest.kg-goal.targetKg)*direction>=0) return {...result,remainingKg:0,estimate:{kind:'achieved'}};
  const recent=sorted.filter(w=>day(w.date)>=day(today)-27 && day(w.date)>=day(goal.date));
  if (recent.length<4) return unavailable('insufficient-observations');
  const first=recent[0]; const span=day(latest.date)-day(first.date);
  if (span<14) return unavailable('short-observation-span');
  const rate=(latest.kg-first.kg)/span;
  if (Math.abs(rate)*7 < 0.05) return unavailable('plateau');
  if (Math.sign(rate)!==direction) return unavailable('opposite-trend');
  if (Math.abs(rate)*7>1) return unavailable('extreme-trend');
  // Every observed segment must follow the overall direction, with no abrupt jump.
  const segments=recent.slice(1).map((w,i)=>(w.kg-recent[i].kg)/(day(w.date)-day(recent[i].date)));
  if (segments.some(r=>r*direction<=0 || Math.abs(r)>Math.abs(rate)*2 || Math.abs(r)<Math.abs(rate)*0.5 || Math.abs(r)*7>1)) return unavailable('nonsteady-trend');
  const elapsed=day(today)-day(latest.date); const remaining=result.remainingKg;
  const minDays=Math.ceil(remaining/(Math.abs(rate)*1.25))-elapsed;
  const maxDays=Math.ceil(remaining/(Math.abs(rate)*0.75))-elapsed;
  if (!Number.isFinite(maxDays) || minDays<=0 || maxDays<=minDays) return unavailable('range-expired');
  return {...result,estimate:{kind:'heuristic-range',earliestDate:dateOf(day(today)+minDays),latestDate:dateOf(day(today)+maxDays),minDays,maxDays,observedKgPerWeek:rate*7}};
}

/** Rolling seven calendar days; counts recorded activity, never inferred inactivity. */
export function summarizeWeek(foods: readonly FoodLog[], workouts: readonly WorkoutLog[], today: string): WeekSummary {
  const startDate=Number.isFinite(day(today))?dateOf(day(today)-6):today;
  const foodRows=active(foods,today).filter(r=>r.date>=startDate);
  const workoutRows=active(workouts,today).filter(r=>r.date>=startDate);
  return {startDate,endDate:today,foodRecords:foodRows.length,foodDays:new Set(foodRows.map(r=>r.date)).size,workoutCount:workoutRows.length,workoutDays:new Set(workoutRows.map(r=>r.date)).size,durationMin:workoutRows.reduce((s,r)=>s+(amount(r.durationMin)?r.durationMin:0),0),missingDurationCount:workoutRows.filter(r=>!amount(r.durationMin)).length,nutrition:summarizeNutrition(foodRows,null,null,today)};
}
