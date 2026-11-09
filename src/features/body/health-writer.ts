import { validDate } from '../../lib/health-model';
import { FoodError } from '../../lib/food-model';
import { localToday } from '../../lib/date';
export function assertRecordedDate(date: string, today = localToday()) {
  validDate(date);
  if (date > today) throw new FoodError('input', '实际记录不能填写未来日期');
}
// Keep the exact original request while its receipt is uncertain. No automatic retry.
export function createHealthWriter<Request, Result>() {
  let pending: Request | undefined;
  let saving = false;
  return {
    isSaving: () => saving,
    hasPending: () => pending !== undefined,
    discard() { if (saving) return false; pending = undefined; return true; },
    async run(make: () => Request, write: (request: Request) => Promise<Result>): Promise<{ kind: 'saved'; value: Result } | { kind: 'busy' }> {
      if (saving) return { kind: 'busy' };
      saving = true;
      try {
        pending ??= structuredClone(make());
        const value = await write(pending);
        pending = undefined;
        return { kind: 'saved', value };
      } catch (error) {
        // Input validation is guaranteed to precede I/O in the health service.
        // All other failures retain the original request until explicitly reconciled.
        if (error && typeof error === 'object' && 'code' in error && error.code === 'input') pending = undefined;
        throw error;
      } finally { saving = false; }
    },
  };
}
