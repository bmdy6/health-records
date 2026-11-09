// Shared read composition for authorized adapters; records remain owned by their stores.
import { createHealthStore } from './health-store';
import type { createFoodStore } from './food-store';
import { FoodError, requireFood } from './food-model';
import { validDate } from './health-model';
import { summarizeNutrition, summarizeProgress, summarizeWeek } from './health-summary';
export { createHealthStore, summarizeNutrition, summarizeProgress, summarizeWeek };
export function shanghaiToday(now = Date.now()): string {
  return new Date(now + 8 * 3600000).toISOString().slice(0,10);
}
export async function composeHealthContext(health: ReturnType<typeof createHealthStore>, food: ReturnType<typeof createFoodStore> | null, start: string, end: string, today = shanghaiToday()) {
  validDate(start);validDate(end);validDate(today);
  requireFood(end >= start && (Date.parse(end)-Date.parse(start))/86400000 <= 366, '健康查询范围必须不超过 366 天');
  const [workouts, goals, weights, profile, foods] = await Promise.all([health.readWorkouts(),health.readGoals(),health.readWeights(),health.readProfile(),food?.read()]);
  // Recheck the current target after every raw read, including the independently authorized food read.
  const current = await health.readWorkouts();
  const directory = (path: string) => path.slice(0,path.lastIndexOf('/'));
  if ([workouts,goals,weights,...(foods ? [foods] : [])].some(s=>directory(s.path)!==directory(current.path))) throw new FoodError('conflict','健康与饮食数据位置已变化，请重新查询');
  const within = <T extends {date:string;deleted:boolean}>(records:T[]) => records.filter(r=>!r.deleted&&r.date>=start&&r.date<=end);
  const raw = { start,end,workouts:within(workouts.records),goals:goals.records.filter(r=>!r.deleted&&r.date<=end),weights:within(weights.records),profile };
  const foodRows = foods ? within(foods.records) : undefined;
  requireFood(raw.workouts.length+raw.goals.length+raw.weights.length+(foodRows?.length??0)<=1000,'请缩小健康查询范围');
  const asOf = end < today ? end : today;
  const goal = raw.goals.find(r=>r.id==='primary'&&r.date<=asOf)??null;
  const weekly = summarizeWeek(foodRows??[],raw.workouts,asOf);
  return { ...raw, ...(foodRows ? {foods:foodRows} : {}), asOf,
    coverage:{workouts:workouts.exists,goals:goals.exists,weights:weights.exists,profile:profile!==null,...(foods?{foods:foods.exists}:{})},
    summaries:{progress:summarizeProgress(raw.weights,goal,asOf),
      weekly:foods ? weekly : {...weekly,foodRecords:null,foodDays:null,nutrition:null},
      nutrition:foodRows&&start===end&&start<=asOf ? summarizeNutrition(foodRows,profile,goal,asOf) : null,
      nutritionReason:!foods?'food-scope-unavailable':start!==end?'daily-summary-requires-single-day':start>asOf?'future-date':null,
      period:'selected-range-only',estimateLabel:'observational-heuristic-not-guarantee'} };
}
