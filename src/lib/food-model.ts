import type { FoodLog } from '../types';

export type FoodDraft = Pick<FoodLog, 'id' | 'date' | 'food' | 'kcal'> & Partial<Pick<FoodLog, 'grams' | 'protein' | 'carbs' | 'fat' | 'meal' | 'note'>>;
export type FoodPatch = Partial<Omit<FoodDraft, 'id'>>;
const fields = ['id', 'date', 'food', 'kcal', 'grams', 'protein', 'carbs', 'fat', 'meal', 'note'];
export class FoodError extends Error {
  constructor(public code: string, message: string, public uncertain = false) { super(message); }
}
export function requireFood(condition: unknown, message: string): asserts condition {
  if (!condition) throw new FoodError('input', message);
}
export function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
export function validateFoodDraft(value: unknown): asserts value is FoodDraft {
  requireFood(object(value), '食物记录必须是对象');
  requireFood(Object.keys(value).every(k => fields.includes(k)), '食物记录包含未知字段');
  requireFood(typeof value.id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value.id), '需要稳定、安全的记录 ID');
  requireFood(typeof value.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.date) &&
    Number(value.date.slice(0, 4)) >= 1900 && Number.isFinite(Date.parse(`${value.date}T00:00:00Z`)) && new Date(`${value.date}T00:00:00Z`).toISOString().slice(0, 10) === value.date, '日期必须是真实的 YYYY-MM-DD');
  requireFood(typeof value.food === 'string' && value.food.trim().length > 0 && value.food.length <= 200, '食物名称无效');
  for (const key of ['kcal', 'grams', 'protein', 'carbs', 'fat']) {
    const n = value[key];
    requireFood((key !== 'kcal' && n === undefined) || (typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100000 && (key !== 'grams' || n > 0)), '营养数值或份量无效');
  }
  requireFood(value.meal === undefined || ['早餐', '午餐', '晚餐', '加餐'].includes(String(value.meal)), '餐次无效');
  requireFood(value.note === undefined || (typeof value.note === 'string' && value.note.length <= 2000), '备注无效');
}
export function validateFoodLogs(value: unknown): asserts value is FoodLog[] {
  if (!Array.isArray(value) || value.length > 20000) throw new FoodError('data', '饮食文件格式无效');
  const ids = new Set<string>();
  for (const row of value) {
    try {
      requireFood(object(row), '记录无效');
      const draft = Object.fromEntries(fields.filter(k => row[k] !== undefined).map(k => [k, row[k]]));
      validateFoodDraft(draft);
      requireFood(typeof row.deleted === 'boolean' && typeof row.id === 'string' && typeof row.createdAt === 'number' && typeof row.updatedAt === 'number' && Number.isSafeInteger(row.createdAt) && row.createdAt >= 0 &&
        Number.isSafeInteger(row.updatedAt) && row.updatedAt >= row.createdAt && !ids.has(row.id), '记录身份或时间无效');
      if (row.agentMutation !== undefined) requireFood(object(row.agentMutation) &&
        typeof row.agentMutation.id === 'string' && /^[\w-]{1,100}$/.test(row.agentMutation.id) &&
        typeof row.agentMutation.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(row.agentMutation.fingerprint), '修改回执无效');
      ids.add(row.id);
    } catch { throw new FoodError('data', '饮食文件存在无效记录，停止写入'); }
  }
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export async function fingerprint(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)));
  return Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, '0')).join('');
}
export function patchFood(before: FoodLog, patch: unknown): FoodLog {
  requireFood(object(patch) && Object.keys(patch).length > 0 && Object.keys(patch).every(k => fields.includes(k) && k !== 'id'), '修改字段无效');
  const next = { ...before, ...patch };
  // Absolute grams, always scaled from the caller's original record, never from a retried result.
  if (patch.grams !== undefined && ['kcal', 'protein', 'carbs', 'fat'].every(k => patch[k] === undefined)) {
    requireFood(typeof patch.grams === 'number' && typeof before.grams === 'number' && before.grams > 0, '原记录没有重量，不能自动按份量换算');
    for (const key of ['kcal', 'protein', 'carbs', 'fat'] as const) {
      if (before[key] !== undefined) next[key] = Math.round(before[key]! * patch.grams / before.grams * 100) / 100;
    }
  }
  const draft = Object.fromEntries(fields.filter(k => next[k as keyof FoodLog] !== undefined).map(k => [k, next[k as keyof FoodLog]]));
  validateFoodDraft(draft);
  return next;
}

// Apply only the user's changes to a fresh remote collection, preserving unseen additions.
export function mergeFoodChanges(baseline: FoodLog[], desired: FoodLog[], remote: FoodLog[], now: number): FoodLog[] {
  validateFoodLogs(baseline); validateFoodLogs(desired); validateFoodLogs(remote);
  const result = new Map(remote.map(r => [r.id, r]));
  for (const before of baseline) {
    const next = desired.find(r => r.id === before.id);
    if (next && canonical(next) === canonical(before)) continue;
    const current = result.get(before.id);
    if (!next && current?.deleted) continue;
    if (next && current && canonical(next) === canonical(current)) continue;
    if (!current || canonical(current) !== canonical(before)) throw new FoodError('conflict', '食物已被其他客户端修改，请刷新核对');
    const changed = next ?? { ...before, deleted: true };
    result.set(before.id, { ...changed, agentMutation: undefined, updatedAt: Math.max(now, before.updatedAt + 1) });
  }
  for (const added of desired.filter(r => !baseline.some(old => old.id === r.id))) {
    const current = result.get(added.id);
    const restored = current?.deleted && !added.deleted && current.createdAt === added.createdAt &&
      canonical({ ...current, deleted: false, updatedAt: 0, agentMutation: undefined }) === canonical({ ...added, updatedAt: 0, agentMutation: undefined });
    if (restored) result.set(added.id, { ...added, agentMutation: undefined, updatedAt: Math.max(now, current!.updatedAt + 1) });
    else {
      if (current && canonical(current) !== canonical(added)) throw new FoodError('conflict', '食物 ID 已存在且内容不同');
      result.set(added.id, current ?? added);
    }
  }
  return [...result.values()];
}
