import { loadFoodLogs, saveFoodLogs, type BodyProfileAccess } from '../../lib/body';
import type { RecognizeResult } from '../../lib/vision';
import type { FoodLog } from '../../types';

export interface RecognizedFoodDraft {
  result: RecognizeResult;
  grams: string;
  date: string;
  meal: string;
  generation?: number;
}

export function recognizedFoodDraftKey(draft: RecognizedFoodDraft): string {
  return JSON.stringify([draft.result, draft.grams, draft.date, draft.meal, draft.generation ?? 0]);
}

interface Ports {
  read: (access: BodyProfileAccess) => Promise<FoodLog[]>;
  write: (records: FoodLog[], access: BodyProfileAccess) => Promise<void>;
  id: () => string;
  now: () => number;
}

type Result = { kind: 'saved'; record: FoodLog } | { kind: 'busy' | 'stale' };

/** One recognition confirmation, not a general queue. Identity survives retries only in this page. */
export function createRecognizedFoodSaver(overrides: Partial<Ports> = {}) {
  const ports: Ports = { read: loadFoodLogs, write: saveFoodLogs, id: () => crypto.randomUUID(), now: Date.now, ...overrides };
  let busy = false;
  let pending: { key: string; access: BodyProfileAccess; record: FoodLog; writeAttempted: boolean } | null = null;

  return {
    isSaving: () => busy,
    async save(draft: RecognizedFoodDraft, access: BodyProfileAccess, isDraftCurrent: () => boolean): Promise<Result> {
      if (busy) return { kind: 'busy' };
      if (!access.isCurrent() || !isDraftCurrent()) return { kind: 'stale' };
      busy = true;
      try {
        const key = recognizedFoodDraftKey(draft);
        const sameIdentity = pending?.access.revision === access.revision
          && pending?.access.config.url === access.config.url
          && pending?.access.config.username === access.config.username
          && pending?.access.config.password === access.config.password;
        if (pending && sameIdentity && pending.key !== key && pending.writeAttempted) {
          throw new Error('上次保存结果尚未核对，请按原草稿重试或刷新核对后再新增');
        }
        if (!pending || pending.key !== key || !sameIdentity) {
          const r = draft.result;
          const grams = parseFloat(draft.grams) || r.weight_g;
          if (!(grams > 0) || !(r.weight_g > 0)) throw new Error('请填写有效的食物重量');
          const now = ports.now();
          pending = { key, access, writeAttempted: false, record: {
            id: ports.id(), date: draft.date, food: r.name,
            kcal: Math.round((r.kcal / r.weight_g) * grams * 10) / 10,
            protein: Math.round((r.protein_g / r.weight_g) * grams * 10) / 10,
            carbs: Math.round((r.carbs_g / r.weight_g) * grams * 10) / 10,
            fat: Math.round((r.fat_g / r.weight_g) * grams * 10) / 10,
            grams, meal: draft.meal, createdAt: now, updatedAt: now, deleted: false,
          } };
        }
        const record = pending.record;
        // Strict read: a failed GET is never an empty collection. On uncertain PUT, first
        // reconcile this same ID; do not allocate another record or overwrite changed content.
        const remote = await ports.read(access);
        if (!access.isCurrent() || !isDraftCurrent()) return { kind: 'stale' };
        const existing = remote.find((item) => item.id === record.id);
        if (existing) {
          if (Object.keys(record).some((field) => existing[field as keyof FoodLog] !== record[field as keyof FoodLog])) {
            throw new Error('这条记录已变化，请刷新核对后再保存');
          }
        } else {
          pending.writeAttempted = true;
          await ports.write([...remote, record], access);
        }
        if (!access.isCurrent() || !isDraftCurrent()) return { kind: 'stale' };
        pending = null;
        return { kind: 'saved', record: existing ?? record };
      } finally {
        busy = false;
      }
    },
  };
}
