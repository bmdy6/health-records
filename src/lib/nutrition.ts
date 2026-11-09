// 营养数据与每日需求推算
// 食物数据由用户导入（每 100g），不随代码分发第三方营养表。
// TDEE：Mifflin-St Jeor 公式（健身界标准）

import { EXT_FOOD_LIBRARY } from './food-data';

export interface FoodNutrient {
  name: string;
  kcal: number; // 每 100g 千卡
  protein: number;
  carbs: number;
  fat: number;
  // 微量营养（每 100g；无数据为 0）
  vitC?: number;
  calcium?: number;
  iron?: number;
  zinc?: number;
  potassium?: number;
  magnesium?: number;
  vitA?: number;
  vitB1?: number;
  vitB2?: number;
  selenium?: number;
  fiber?: number;
}

export const FOOD_LIBRARY: FoodNutrient[] = [...EXT_FOOD_LIBRARY];
export function replaceFoodLibrary(foods: FoodNutrient[]): void {
  FOOD_LIBRARY.splice(0, FOOD_LIBRARY.length, ...foods);
}

// 口述/AI 常用名 → 库名同义词映射（单字/烹饪词无法可靠子串匹配的场景）
const AI_NAME_ALIAS: Record<string, string> = {
  水煮蛋: '鸡蛋', 白煮蛋: '鸡蛋', 茶叶蛋: '鸡蛋', 荷包蛋: '鸡蛋', 煎蛋: '鸡蛋', 炒蛋: '鸡蛋', 卤蛋: '鸡蛋',
  水煮鱼: '鱼', 清蒸鱼: '鱼', 红烧鱼: '鱼', 糖醋鱼: '鱼',
  白米饭: '米饭', 大米饭: '米饭',
  可乐: '可口可乐', 百事: '百事可乐（佳得乐）',
};

export function findFood(input: string): FoodNutrient | null {
  const q = input.trim().toLowerCase();
  if (!q) return null;
  const strip = (s: string) => s.toLowerCase().replace(/[（(].*?[)）]/g, '').trim();
  // 0. 同义词映射（水煮蛋→鸡蛋 等）；自映射（蛋炒饭→蛋炒饭）跳过，防无限递归
  const alias = AI_NAME_ALIAS[q] ?? AI_NAME_ALIAS[strip(q)];
  if (alias && alias !== q && alias !== strip(q)) return findFood(alias) ?? null;
  // 1. 精确
  let hit = FOOD_LIBRARY.find((f) => f.name.toLowerCase() === q);
  if (hit) return hit;
  // 2. 去括号后精确（"米饭" → "米饭（均值）"）
  const sq = strip(q);
  hit = FOOD_LIBRARY.find((f) => strip(f.name) === sq);
  if (hit) return hit;
  // 2.5 去烹饪修饰词后重试（口述/AI 名如"清蒸鲈鱼"；剥离结果至少 2 字才走子串，避免单字"蛋"误配"蛋黄"）
  const bare = q.replace(/^(水煮|清蒸|红烧|油炸|油煎|香煎|爆炒|清炒|凉拌|醋溜|糖醋|干锅|卤|烤|煎|炖|煮|蒸|炒)/, '');
  if (bare !== q && bare.length >= 2) {
    const b = strip(bare);
    hit = FOOD_LIBRARY.find((f) => strip(f.name) === b)
      ?? FOOD_LIBRARY.filter((f) => f.name.toLowerCase().includes(b)).sort((a, b2) => a.name.length - b2.name.length)[0];
    if (hit) return hit;
  }
  // 3. 子串（优先短名，"苹果" → 史密斯奶奶苹果/红苹果）
  const hits = FOOD_LIBRARY.filter((f) => f.name.toLowerCase().includes(q)).sort((a, b2) => a.name.length - b2.name.length);
  if (hits.length) return hits[0];
  // 4. 反向（用户输入含库名）
  hit = FOOD_LIBRARY.find((f) => q.includes(f.name.toLowerCase()));
  return hit ?? null;
}

// 下拉候选（子串匹配，短名优先，最多 5 条）
export function searchFoods(input: string, limit = 5): FoodNutrient[] {
  const q = input.trim().toLowerCase();
  if (!q) return [];
  return FOOD_LIBRARY.filter((f) => f.name.toLowerCase().includes(q)).sort((a, b) => a.name.length - b.name.length).slice(0, limit);
}

// 计量单位（含换算为克的系数；库匹配时用，无匹配走 AI 估算）
export const UNITS = [
  { value: 'g', label: '克', grams: 1 },
  { value: '碗', label: '碗', grams: 200 },
  { value: '份', label: '份', grams: 250 },
  { value: '个', label: '个', grams: 100 },
  { value: '杯', label: '杯', grams: 200 },
] as const;

export type Unit = (typeof UNITS)[number]['value'];

// 库匹配：数量 × 单位 → 总克数 → 按每 100g 营养换算
export function calcFromLibrary(nut: FoodNutrient, amount: number, unit: Unit): { kcal: number; protein: number; carbs: number; fat: number } {
  const grams = amount * (UNITS.find((u) => u.value === unit)?.grams ?? 1);
  const factor = grams / 100;
  return {
    kcal: Math.round(nut.kcal * factor),
    protein: Math.round(nut.protein * factor * 10) / 10,
    carbs: Math.round(nut.carbs * factor * 10) / 10,
    fat: Math.round(nut.fat * factor * 10) / 10,
  };
}

// —— 每日需求推算（Mifflin-St Jeor）+ 目标模式 ——
export interface DailyNeeds {
  bmr: number; // 基础代谢
  tdee: number; // 每日总消耗
  targetKcal: number; // 目标热量（模式调整后；默认=TDEE）
  proteinG: { min: number; max: number }; // 蛋白质建议（g）
  fatG: number; // 脂肪建议（按目标热量 25%）
}

// 目标模式：热量系数 + 蛋白乘数（g/kg）。蛋白由热量缺口驱动（缺口期拉高防肌肉流失）
export const GOAL_MODES = [
  { value: 'maintain', label: '维持体重', kcalFactor: 1, proteinMin: 1.2, proteinMax: 1.6, desc: '目标 = 每日总消耗' },
  { value: 'cut-mild', label: '温和减脂', kcalFactor: 0.85, proteinMin: 1.6, proteinMax: 2.0, desc: '目标 = TDEE−15%，高蛋白保肌肉' },
  { value: 'cut-agg', label: '积极减脂', kcalFactor: 0.75, proteinMin: 1.8, proteinMax: 2.2, desc: '目标 = TDEE−25%，蛋白拉满' },
  { value: 'fasting', label: '轻断食', kcalFactor: 0.8, proteinMin: 1.6, proteinMax: 2.0, desc: '目标 = TDEE−20%，缺口期蛋白保肌' },
  { value: 'bulk', label: '干净增肌', kcalFactor: 1.075, proteinMin: 1.8, proteinMax: 2.2, desc: '目标 = TDEE+7.5%，少盈余多蛋白' },
] as const;

export type GoalModeValue = (typeof GOAL_MODES)[number]['value'];

// AI 口述/识别结果营养库校准：按该份克数 × 每 100g 库值重算宏量
// 命中返回库值（更可靠），未命中返回 null（调用方保留 AI 估算并打标）
export function calibrateFoodNutrition(name: string, grams: number): { kcal: number; protein: number; carbs: number; fat: number } | null {
  const nut = findFood(name);
  if (!nut || !(grams > 0)) return null;
  const f = grams / 100;
  return {
    kcal: Math.round(nut.kcal * f),
    protein: Math.round(nut.protein * f * 10) / 10,
    carbs: Math.round(nut.carbs * f * 10) / 10,
    fat: Math.round(nut.fat * f * 10) / 10,
  };
}

export function calcDailyNeeds(opts: {
  sex: 'male' | 'female';
  weightKg: number;
  heightCm: number;
  age: number;
  activity: number; // 1.2~1.9
  goalMode?: GoalModeValue;
  kcalOverride?: number;
  proteinOverride?: number;
}): DailyNeeds {
  const base = opts.sex === 'male' ? 5 : -161;
  const bmr = 10 * opts.weightKg + 6.25 * opts.heightCm - 5 * opts.age + base;
  const tdee = Math.round(bmr * opts.activity);
  const mode = GOAL_MODES.find((m) => m.value === (opts.goalMode ?? 'maintain')) ?? GOAL_MODES[0];
  const targetKcal = Math.round(opts.kcalOverride && opts.kcalOverride > 0 ? opts.kcalOverride : tdee * mode.kcalFactor);
  const pMin = Math.round(opts.weightKg * mode.proteinMin);
  const pMax = Math.round(opts.weightKg * mode.proteinMax);
  return {
    bmr: Math.round(bmr),
    tdee,
    targetKcal,
    proteinG: {
      min: opts.proteinOverride && opts.proteinOverride > 0 ? opts.proteinOverride : pMin,
      max: opts.proteinOverride && opts.proteinOverride > 0 ? Math.max(opts.proteinOverride, pMax) : pMax,
    },
    fatG: Math.round((targetKcal * 0.25) / 9),
  };
}

export const ACTIVITY_LEVELS = [
  { value: 1.2, label: '久坐（很少运动）' },
  { value: 1.375, label: '轻度（每周运动 1-3 次）' },
  { value: 1.55, label: '中度（每周运动 3-5 次）' },
  { value: 1.725, label: '高强度（每周运动 6-7 次）' },
  { value: 1.9, label: '极高（体力劳动/每天两练）' },
] as const;

// —— 每日推荐摄入（成人 RNI，中国标准）与缺口分析 ——
export type MicroKey = 'vitC' | 'calcium' | 'iron' | 'zinc' | 'potassium' | 'magnesium' | 'vitA' | 'vitB1' | 'vitB2' | 'selenium' | 'fiber';

export interface MicroTarget {
  key: MicroKey;
  label: string;
  unit: string;
  rni: number;
  foods: string[];
}

export const MICRO_TARGETS: MicroTarget[] = [
  { key: 'vitC', label: '维生素C', unit: 'mg', rni: 100, foods: ['橙子', '西红柿', '青椒'] },
  { key: 'calcium', label: '钙', unit: 'mg', rni: 800, foods: ['牛奶', '鸡蛋', '豆腐'] },
  { key: 'iron', label: '铁', unit: 'mg', rni: 12, foods: ['瘦肉', '猪肝', '菠菜'] },
  { key: 'zinc', label: '锌', unit: 'mg', rni: 12.5, foods: ['瘦肉', '鸡蛋', '花生'] },
  { key: 'potassium', label: '钾', unit: 'mg', rni: 2000, foods: ['香蕉', '土豆', '西红柿'] },
  { key: 'magnesium', label: '镁', unit: 'mg', rni: 330, foods: ['燕麦', '花生', '绿叶菜'] },
  { key: 'vitA', label: '维生素A', unit: 'µg', rni: 800, foods: ['胡萝卜', '南瓜', '鸡蛋'] },
  { key: 'vitB1', label: '维生素B1', unit: 'mg', rni: 1.4, foods: ['米饭', '瘦肉', '豆类'] },
  { key: 'vitB2', label: '维生素B2', unit: 'mg', rni: 1.4, foods: ['牛奶', '鸡蛋', '绿叶菜'] },
  { key: 'selenium', label: '硒', unit: 'µg', rni: 60, foods: ['鸡蛋', '花生', '瘦肉'] },
  { key: 'fiber', label: '膳食纤维', unit: 'g', rni: 25, foods: ['蔬菜', '燕麦', '米饭'] },
];

export interface MicroIntake {
  key: string;
  label: string;
  unit: string;
  intake: number;
  rni: number;
  pct: number;
  foods: string[];
}

// 计算一批食物记录的微量摄入（按克数回查库）
export function calcDailyMicro(foods: { food: string; grams?: number }[]): MicroIntake[] {
  const acc: Record<string, number> = {};
  for (const t of MICRO_TARGETS) acc[t.key] = 0;
  for (const f of foods) {
    const nut = findFood(f.food);
    if (!nut) continue;
    const grams = f.grams ?? 100;
    const factor = grams / 100;
    for (const t of MICRO_TARGETS) {
      acc[t.key] += (nut[t.key] ?? 0) * factor;
    }
  }
  return MICRO_TARGETS.map((t) => ({
    key: t.key,
    label: t.label,
    unit: t.unit,
    intake: acc[t.key],
    rni: t.rni,
    pct: t.rni > 0 ? (acc[t.key] / t.rni) * 100 : 0,
    foods: t.foods,
  }));
}

// 精确匹配（加号用）：完全同名 或 去括号后同名（"米饭" → "米饭（均值）"）
// 不做子串/模糊匹配——避免"汉堡"被自动匹配成"素食汉堡"
export function findFoodExact(input: string): FoodNutrient | null {
  const q = input.trim().toLowerCase();
  if (!q) return null;
  const strip = (s: string) => s.toLowerCase().replace(/[（(].*?[)）]/g, '').trim();
  return (
    FOOD_LIBRARY.find((f) => f.name.toLowerCase() === q) ??
    FOOD_LIBRARY.find((f) => strip(f.name) === strip(q)) ??
    null
  );
}
