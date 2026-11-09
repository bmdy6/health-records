import { replaceFoodLibrary, type FoodNutrient } from './nutrition';
export const LIBRARY_KEY = 'health-records:food-library:v1';
export interface FoodLibrary { source: string; foods: FoodNutrient[] }
const fields = ['kcal','protein','carbs','fat','vitC','calcium','iron','zinc','potassium','magnesium','vitA','vitB1','vitB2','selenium','fiber'];
export function parseFoodLibrary(raw: string): FoodLibrary {
 if (raw.length > 2_000_000) throw new Error('食物库不超过 2 MB');
 const value = JSON.parse(raw) as FoodLibrary;
 if (!value || typeof value.source !== 'string' || !value.source.trim() || value.source.length > 500 || !Array.isArray(value.foods) || value.foods.length > 5000) throw new Error('需要 source 来源说明和 foods 数组（最多 5000 项）');
 const names = new Set<string>();
 for (const food of value.foods) {
  if (!food || typeof food.name !== 'string' || !food.name.trim() || food.name.length > 100 || names.has(food.name)) throw new Error('食物名称无效或重复');
  if (Object.keys(food).some(k => k !== 'name' && !fields.includes(k))) throw new Error('食物库含未知字段');
  for (const field of fields) { const n = food[field as keyof FoodNutrient]; if ((['kcal','protein','carbs','fat'].includes(field) || n !== undefined) && (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 100000)) throw new Error('营养值须为每 100g 的有限非负数'); }
  names.add(food.name);
 }
 return value;
}
export function loadFoodLibrary(): FoodLibrary | null {
 try { const raw = localStorage.getItem(LIBRARY_KEY);if(!raw)return null;const library=parseFoodLibrary(raw);replaceFoodLibrary(library.foods);return library; } catch { return null; }
}
export function saveFoodLibrary(raw: string): FoodLibrary { const library=parseFoodLibrary(raw);localStorage.setItem(LIBRARY_KEY,JSON.stringify(library));replaceFoodLibrary(library.foods);return library; }
