// 口述饮食解析：AI 返回数组的校验、编辑换算、映射 FoodLog（纯函数，无 fetch/无 WebDAV）
import type { FoodLog } from '../types';

// AI 单条结果契约（与 vision-prompts NARRATION_PROMPT 对齐）
export const MEAL_OPTIONS = ['早餐', '午餐', '晚餐', '加餐'] as const;
export type Meal = (typeof MEAL_OPTIONS)[number];

export const NARRATION_UNITS = ['克', '碗', '份', '个', '杯', '毫升', '包', '瓶', '袋', '盒', '罐', '条'] as const;
export type NarrationUnit = (typeof NARRATION_UNITS)[number];

export interface OralFoodAIItem {
  meal: Meal;
  name: string;
  amount: number; // 口述数量（数字）
  unit: NarrationUnit;
  grams: number; // 该份估算克数
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  // 营养来源：library=营养库校准（每100g×克数）；ai=AI 估算（库无此食物）
  source?: 'library' | 'ai';
}

// 待确认草稿：AI 项 + 稳定 id + 用户编辑后的数量/克数
export interface OralFoodDraft extends OralFoodAIItem {
  id: string;
}

const NINE_KEYS = ['meal', 'name', 'amount', 'unit', 'grams', 'kcal', 'protein_g', 'carbs_g', 'fat_g'] as const;

function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

// 校验失败原因（供自动修正 prompt 与错误分类使用）
export type NarrationFailReason = 'not-array' | 'missing-field' | 'invalid-meal' | 'invalid-unit' | 'invalid-number';

// 带原因的结构化校验结果
// ok=true：items 为合法数组；ok=false：reason 给出失败原因、field 给出具体字段（缺失/非法时）
export interface NarrationValidation {
  ok: boolean;
  items: OralFoodAIItem[] | null;
  reason?: NarrationFailReason;
  field?: string;
}

// 校验：任何一条不合法 → 整批拒绝（不静默丢条），并给出失败原因
// 严格校验简写（兼容包装）已删，测试内自建 strict；本函数保留原语义
export function validateNarration(raw: unknown): NarrationValidation {
  if (!Array.isArray(raw)) return { ok: false, items: null, reason: 'not-array' };
  const out: OralFoodAIItem[] = [];
  for (const it of raw) {
    if (typeof it !== 'object' || it === null) return { ok: false, items: null, reason: 'missing-field' };
    const o = it as Record<string, unknown>;
    for (const k of NINE_KEYS) {
      if (!(k in o)) return { ok: false, items: null, reason: 'missing-field', field: k };
    }
    const meal = o.meal as string;
    const unit = o.unit as string;
    const name = typeof o.name === 'string' ? o.name.trim() : '';
    if (!MEAL_OPTIONS.includes(meal as Meal)) return { ok: false, items: null, reason: 'invalid-meal', field: 'meal' };
    if (!name) return { ok: false, items: null, reason: 'missing-field', field: 'name' };
    if (!NARRATION_UNITS.includes(unit as NarrationUnit)) return { ok: false, items: null, reason: 'invalid-unit', field: 'unit' };
    const amount = o.amount as number;
    const grams = o.grams as number;
    if (!isFiniteNum(amount) || amount <= 0) return { ok: false, items: null, reason: 'invalid-number', field: 'amount' };
    if (!isFiniteNum(grams) || grams <= 0) return { ok: false, items: null, reason: 'invalid-number', field: 'grams' };
    for (const k of ['kcal', 'protein_g', 'carbs_g', 'fat_g'] as const) {
      if (!isFiniteNum(o[k]) || (o[k] as number) < 0) return { ok: false, items: null, reason: 'invalid-number', field: k };
    }
    out.push({ meal: meal as Meal, name, amount, unit: unit as NarrationUnit, grams, kcal: o.kcal as number, protein_g: o.protein_g as number, carbs_g: o.carbs_g as number, fat_g: o.fat_g as number });
  }
  return { ok: true, items: out };
}

// 严格校验（ponytail: 已删——validateNarration 的兼容包装，生产 0 引用，仅测试用；测试改用 validateNarration）

// 生成稳定 id（确认时用；解析/缓存命中都重新生成，避免历史 id 复用）
export function newDraftId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// AI 项 → 草稿（分配 id）
export function toDrafts(items: OralFoodAIItem[], idFn: () => string = newDraftId): OralFoodDraft[] {
  return items.map((it) => ({ ...it, id: idFn() }));
}

// 按新数量联动克数（数量变 → 克数按比例变，sourceGrams 不变仍可回算）
export function scaleByAmount(draft: OralFoodDraft, newAmount: number): OralFoodDraft {
  const a = newAmount > 0 ? newAmount : draft.amount;
  const ratio = a / draft.amount;
  return { ...draft, amount: a, grams: Math.round(draft.grams * ratio), kcal: draft.kcal * ratio, protein_g: draft.protein_g * ratio, carbs_g: draft.carbs_g * ratio, fat_g: draft.fat_g * ratio };
}

// 按新克数联动营养（克数变 → 四项按比例变）
export function scaleByGrams(draft: OralFoodDraft, newGrams: number): OralFoodDraft {
  const g = newGrams > 0 ? newGrams : draft.grams;
  const ratio = g / draft.grams;
  return { ...draft, grams: g, kcal: draft.kcal * ratio, protein_g: draft.protein_g * ratio, carbs_g: draft.carbs_g * ratio, fat_g: draft.fat_g * ratio };
}

// 草稿 → FoodLog（今天）
export function draftToFoodLog(d: OralFoodDraft, date: string, now: number): FoodLog {
  const r1 = (n: number) => Math.round(n * 10) / 10;
  return {
    id: d.id,
    date,
    food: d.name,
    kcal: Math.round(d.kcal),
    protein: r1(d.protein_g),
    carbs: r1(d.carbs_g),
    fat: r1(d.fat_g),
    grams: Math.round(d.grams),
    meal: d.meal,
    createdAt: now,
    updatedAt: now,
    deleted: false,
  };
}

// 与现有 foods 合并（按 id 去重，防重复确认）→ 返回新数组
export function mergeFoodLogs(existing: FoodLog[], additions: FoodLog[]): FoodLog[] {
  const ids = new Set(existing.map((f) => f.id));
  return [...existing, ...additions.filter((a) => !ids.has(a.id))];
}

// 口述疑问句检测：用户是查询意图（『今天吃了什么/哪些东西/啥』），而非口述食物
// 命中后上层不调模型、直接给引导文案；排除否定句（『今天没吃什么』= 陈述没吃，走正常空结果）
// 与量词/具体食物词共现视为带描述口述（如『吃了什么？两个鸡蛋』），不拦截
const QUERY_QUESTION_WORDS = /(什么|啥|哪些|几样|多少)/;
const QUERY_NEGATION = /(没|不|未|没有)/;
const QUERY_FOOD_SIGNALS = /(个|碗|份|杯|克|毫升|盘|盒|袋|瓶|颗|斤|两)/;

export function isFoodQuery(text: string): boolean {
  const t = text.trim();
  if (!/吃/.test(t)) return false;
  if (!QUERY_QUESTION_WORDS.test(t)) return false;
  if (QUERY_NEGATION.test(t)) return false;
  return !QUERY_FOOD_SIGNALS.test(t);
}

// 文本归一化（缓存 key 用）
export function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

// 缓存 key 的文本 hash（djb2，避免长中文原文作 key 超限）
export function hashText(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}
