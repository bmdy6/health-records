import { loadFoodLogs, saveFoodLogs, type BodyProfileAccess } from '../../lib/body';
import { calcFromLibrary, findFood, UNITS, type Unit } from '../../lib/nutrition';
import { recognizeFoodText } from '../../lib/vision';
import type { FoodLog } from '../../types';

export interface ManualFoodDraft {
  name: string;
  amount: string;
  unit: Unit;
  date: string;
  meal: string;
  generation: number;
}

interface Ports {
  read: (access: BodyProfileAccess) => Promise<FoodLog[]>;
  write: (records: FoodLog[], access: BodyProfileAccess) => Promise<void>;
  estimate: typeof recognizeFoodText;
  id: () => string;
  now: () => number;
}

type Result = { kind: 'saved'; record: FoodLog } | { kind: 'busy' | 'stale' };

/** One same-page manual submission. No durable queue or cross-device write guarantee. */
export function createManualFoodSaver(overrides: Partial<Ports> = {}) {
  const ports: Ports = { read: loadFoodLogs, write: saveFoodLogs, estimate: recognizeFoodText,
    id: () => crypto.randomUUID(), now: Date.now, ...overrides };
  let busy = false;
  let pending: { key: string; access: BodyProfileAccess; record: FoodLog; writeAttempted: boolean } | null = null;

  return {
    isSaving: () => busy,
    hasUnconfirmedWrite: () => Boolean(pending?.writeAttempted),
    async save(draft: ManualFoodDraft, access: BodyProfileAccess, isDraftCurrent: () => boolean,
      onEstimating: (value: boolean) => void = () => {}): Promise<Result> {
      if (busy) return { kind: 'busy' };
      const current = () => access.isCurrent() && isDraftCurrent();
      if (!current()) return { kind: 'stale' };
      busy = true;
      try {
        const key = JSON.stringify(draft);
        const sameIdentity = pending?.access.revision === access.revision
          && pending?.access.config.url === access.config.url
          && pending?.access.config.username === access.config.username
          && pending?.access.config.password === access.config.password;
        if (pending && sameIdentity && pending.key !== key && pending.writeAttempted) {
          throw new Error('上次保存结果尚未核对，请先按原草稿重试');
        }
        if (!pending || pending.key !== key || !sameIdentity) {
          const n = draft.name.trim();
          if (!n) throw new Error('请填写食物名称');
          const amt = parseFloat(draft.amount) || 100;
          const grams = amt * (UNITS.find((x) => x.value === draft.unit)?.grams ?? 1);
          const nut = findFood(n);
          let values: Pick<FoodLog, 'food' | 'kcal' | 'protein' | 'carbs' | 'fat' | 'grams'>;
          if (nut) {
            values = { food: nut.name, ...calcFromLibrary(nut, amt, draft.unit), grams };
          } else {
            onEstimating(true);
            try {
              const r = await ports.estimate(`${n} ${amt}${draft.unit === 'g' ? '克' : draft.unit}`);
              if (!current()) return { kind: 'stale' };
              if (!r.name) throw new Error('未识别，请换个说法');
              values = { food: r.name, kcal: Math.round(r.kcal), protein: r.protein_g,
                carbs: r.carbs_g, fat: r.fat_g, grams: r.weight_g || grams };
            } finally {
              if (current()) onEstimating(false);
            }
          }
          const now = ports.now();
          pending = { key, access, writeAttempted: false, record: { ...values, id: ports.id(),
            date: draft.date, meal: draft.meal, createdAt: now, updatedAt: now, deleted: false } };
        }
        const record = pending.record;
        // Never interpret a failed read as an empty remote, or re-estimate an uncertain retry.
        const remote = await ports.read(access);
        if (!current()) return { kind: 'stale' };
        const existing = remote.find((item) => item.id === record.id);
        if (existing) {
          if (Object.keys(record).some((field) => existing[field as keyof FoodLog] !== record[field as keyof FoodLog])) {
            throw new Error('这条记录已变化，请先核对云端记录');
          }
        } else {
          pending.writeAttempted = true;
          await ports.write([...remote, record], access);
        }
        if (!current()) return { kind: 'stale' };
        pending = null;
        return { kind: 'saved', record: existing ?? record };
      } finally {
        busy = false;
      }
    },
  };
}
