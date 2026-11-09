import { beforeEach, describe, expect, it, vi } from 'vitest';
import pageSource from './index.tsx?raw';
import ts from 'typescript';
import { createRecognizedFoodSaver, recognizedFoodDraftKey, type RecognizedFoodDraft } from './recognized-food-save';
import { loadFoodLogs, saveFoodLogs, type BodyProfileAccess } from '../../lib/body';
import type { FoodLog } from '../../types';

const io = vi.hoisted(() => ({ settings: vi.fn(), put: vi.fn(), get: vi.fn(), create: vi.fn() }));
vi.mock('../../lib/settings', () => ({ loadSettings: (...args: unknown[]) => io.settings(...args) }));
vi.mock('../../lib/webdav', () => ({ getConfig: () => null, createDavClient: (...args: unknown[]) => { io.create(...args); return { putFileContents: io.put, getFileContents: io.get }; } }));
const cfg = { url: 'https://dav.invalid/', username: 'synthetic', password: 'not-a-secret' };
const access = (): BodyProfileAccess => ({ config: { ...cfg }, revision: 1, isCurrent: () => true });
const draft: RecognizedFoodDraft = { result: { name: '合成米饭', weight_g: 100, kcal: 120, protein_g: 2, carbs_g: 26, fat_g: 0.2 }, grams: '80', date: '2026-10-25', meal: '午餐' };
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function setup() {
  const read = vi.fn(async (): Promise<FoodLog[]> => []);
  const write = vi.fn(async (_list: FoodLog[], _access: BodyProfileAccess): Promise<void> => {});
  const id = vi.fn(() => `synthetic-${id.mock.calls.length}`);
  return { read, write, id, saver: createRecognizedFoodSaver({ read, write, id, now: () => 100 }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  io.settings.mockReset().mockResolvedValue({ bills: 'shared', planner: 'private', body: 'private' });
  io.put.mockReset().mockResolvedValue(true); io.get.mockReset().mockResolvedValue({ data: '[]', headers: { etag: '"v1"' } });
});

describe('recognized-food save: same-page pending identity', () => {
  for (const kind of ['offline', '401', '503', 'timeout']) {
    it(`retains the same ID after ${kind}; retry saves one record`, async () => {
      const f = setup(), a = access(); f.write.mockRejectedValueOnce(new Error(kind));
      await expect(f.saver.save(draft, a, () => true)).rejects.toThrow(kind);
      expect(f.saver.isSaving()).toBe(false);
      const first = f.write.mock.calls[0][0][0];
      const result = await f.saver.save(draft, a, () => true);
      expect(result.kind).toBe('saved'); expect(f.id).toHaveBeenCalledOnce();
      expect(f.write.mock.calls[1][0]).toEqual([first]);
    });
  }
  it('strict read failure does not write or treat remote as empty', async () => {
    const f = setup(); f.read.mockRejectedValueOnce(new Error('GET 503'));
    await expect(f.saver.save(draft, access(), () => true)).rejects.toThrow('GET 503');
    expect(f.write).not.toHaveBeenCalled();
  });
  it('reconciles an uncertain PUT that actually committed; no second PUT', async () => {
    const f = setup(), a = access(); let remote: FoodLog[] = [];
    f.read.mockImplementation(async () => remote);
    f.write.mockImplementationOnce(async (rows) => { remote = rows; throw new Error('response lost'); });
    await expect(f.saver.save(draft, a, () => true)).rejects.toThrow('response lost');
    expect((await f.saver.save(draft, a, () => true)).kind).toBe('saved');
    expect(remote).toHaveLength(1); expect(f.write).toHaveBeenCalledOnce();
  });
  it('preserves unrelated fresh remote records', async () => {
    const f = setup(); const existing = { id: 'existing' } as FoodLog; f.read.mockResolvedValue([existing]);
    await f.saver.save(draft, access(), () => true);
    expect(f.write.mock.calls[0][0][0]).toBe(existing); expect(f.write.mock.calls[0][0]).toHaveLength(2);
  });
  it('blocks duplicate clicks while read/write is in flight', async () => {
    const f = setup(), pending = deferred<FoodLog[]>(); f.read.mockReturnValue(pending.promise);
    const first = f.saver.save(draft, access(), () => true);
    expect(await f.saver.save(draft, access(), () => true)).toEqual({ kind: 'busy' });
    pending.resolve([]); await first; expect(f.write).toHaveBeenCalledOnce();
  });
  it('edited draft during read cannot be written', async () => {
    const f = setup(), pending = deferred<FoodLog[]>(); let current = true; f.read.mockReturnValue(pending.promise);
    const result = f.saver.save(draft, access(), () => current); current = false; pending.resolve([]);
    expect(await result).toEqual({ kind: 'stale' }); expect(f.write).not.toHaveBeenCalled();
  });
  for (const reason of ['edited', 'unmounted', 'account changed']) {
    it(`late successful PUT after ${reason} cannot report current draft success`, async () => {
      const f = setup(), pending = deferred<void>(); let current = true;
      f.write.mockReturnValue(pending.promise); const a = access();
      if (reason !== 'edited') a.isCurrent = () => current;
      const result = f.saver.save(draft, a, () => reason === 'edited' ? current : true);
      await vi.waitFor(() => expect(f.write).toHaveBeenCalledOnce()); current = false; pending.resolve();
      expect(await result).toEqual({ kind: 'stale' });
    });
  }
  it('uncertain committed 80g cannot become a new 90g record on edited retry', async () => {
    const f = setup(), a = access(); let remote: FoodLog[] = [];
    f.read.mockImplementation(async () => remote);
    f.write.mockImplementationOnce(async (rows) => { remote = rows; throw new Error('response lost'); });
    await expect(f.saver.save(draft, a, () => true)).rejects.toThrow('response lost');
    await expect(f.saver.save({ ...draft, grams: '90', generation: 1 }, a, () => true)).rejects.toThrow('尚未核对');
    expect(remote).toHaveLength(1); expect(remote[0].grams).toBe(80); expect(f.id).toHaveBeenCalledOnce();
    // The original unchanged draft remains recoverable, without a second write.
    expect((await f.saver.save(draft, a, () => true)).kind).toBe('saved');
    expect(f.write).toHaveBeenCalledOnce();
  });
  it('same-content generation changes cannot replace an unconfirmed pending record', async () => {
    const f = setup(), a = access(); f.write.mockRejectedValueOnce(new Error('offline'));
    await expect(f.saver.save({ ...draft, generation: 1 }, a, () => true)).rejects.toThrow();
    await expect(f.saver.save({ ...draft, generation: 2 }, a, () => true)).rejects.toThrow('尚未核对');
    expect(f.id).toHaveBeenCalledOnce();
  });
  it('editing is safe after a read failure that never attempted PUT', async () => {
    const f = setup(), a = access(); f.read.mockRejectedValueOnce(new Error('GET offline'));
    await expect(f.saver.save(draft, a, () => true)).rejects.toThrow();
    await f.saver.save({ ...draft, grams: '90' }, a, () => true);
    expect(f.write).toHaveBeenCalledOnce();
  });
  it('a different binding never reuses the previous pending ID', async () => {
    const f = setup(); f.write.mockRejectedValueOnce(new Error('offline'));
    await expect(f.saver.save(draft, access(), () => true)).rejects.toThrow();
    await f.saver.save(draft, { ...access(), revision: 2 }, () => true);
    expect(f.id).toHaveBeenCalledTimes(2);
  });
  it('does not overwrite a changed record carrying the pending ID', async () => {
    const f = setup(), a = access(); f.write.mockRejectedValueOnce(new Error('unknown'));
    await expect(f.saver.save(draft, a, () => true)).rejects.toThrow();
    const row = f.write.mock.calls[0][0][0]; f.read.mockResolvedValue([{ ...row, deleted: true }]);
    await expect(f.saver.save(draft, a, () => true)).rejects.toThrow('已变化');
    expect(f.write).toHaveBeenCalledOnce();
  });
});

describe('captured body write access (legacy callers unchanged)', () => {
  it('new path rejects missing credentials instead of resolving no-op', async () => {
    await expect(saveFoodLogs([], { ...access(), config: null as never })).rejects.toThrow('绑定');
    expect(io.put).not.toHaveBeenCalled();
  });
  it('uses strict settings and captured identity, rejects no-baseline overwrites', async () => {
    const a = access(); await loadFoodLogs(a);
    await saveFoodLogs([], a);
    expect(io.settings).toHaveBeenCalledWith(a.config, true, a.revision, true);
    expect(io.create).toHaveBeenCalledWith(a.config);
    expect(io.put).not.toHaveBeenCalled(); // identical empty collection is a no-op
  });
  for (const action of ['sign out', 'switch account']) {
    it(`cancels when ${action} occurs while settings load`, async () => {
      const a = access(); await loadFoodLogs(a);
      const wait = deferred<{ bills: string; planner: string; body: string }>(); let current = true;
      a.isCurrent = () => current; io.settings.mockReturnValueOnce(wait.promise);
      const result = saveFoodLogs([], a);
      const rejected = expect(result).rejects.toThrow('取消');
      current = false; wait.resolve({ bills: 'shared', planner: 'private', body: 'private' });
      await rejected; expect(io.put).not.toHaveBeenCalled();
    });
  }
  it('strict GET failure prevents the default saver from issuing PUT', async () => {
    io.get.mockRejectedValue(new Error('GET offline'));
    await expect(createRecognizedFoodSaver().save(draft, access(), () => true)).rejects.toThrow('读取失败');
    expect(io.put).not.toHaveBeenCalled();
  });
  it('late PUT after identity invalidation rejects instead of acknowledging success', async () => {
    const a = access(); await loadFoodLogs(a);
    const wait = deferred<boolean>(); let current = true; a.isCurrent = () => current;
    io.put.mockReturnValueOnce(wait.promise);
    const row = { id: 'new-1', date: '2026-10-30', food: '米饭', kcal: 120, grams: 100, createdAt: 1, updatedAt: 1, deleted: false };
    const result = saveFoodLogs([row], a);
    const rejected = expect(result).rejects.toThrow('取消');
    await vi.waitFor(() => expect(io.put).toHaveBeenCalledOnce()); current = false; wait.resolve(true);
    await rejected;
  });
});

// Execute the actual page handler with explicit UI ports (not a DOM/browser claim).
function pageHandler(ports: Record<string, unknown>, name = 'confirmRecResult') {
  const source = pageSource;
  const ast = ts.createSourceFile('index.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let body: ts.Expression | undefined;
  function find(node: ts.Node) { if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) body = node.initializer; ts.forEachChild(node, find); }
  find(ast); if (!body) throw new Error('confirmation handler missing');
  const js = ts.transpileModule(`const handler = ${body.getText(ast)}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  ports = { trackUse: vi.fn(), ...ports };
  return Function(...Object.keys(ports), `${js}; return handler;`)(...Object.values(ports)) as (file?: unknown) => Promise<void>;
}
function pagePorts(save: () => Promise<unknown>) {
  const p = { trackUse: vi.fn(), recResult: draft.result, recGrams: draft.grams, logDate: draft.date, meal: draft.meal,
    recSaverRef: { current: { isSaving: () => false, save } }, mountedRef: { current: true }, recDraftGenerationRef: { current: 0 }, recSaveRequestRef: { current: 0 }, currentRecDraftRef: { current: recognizedFoodDraftKey(draft) },
    getConfig: () => cfg, getConfigRevision: () => 1, recognizedFoodDraftKey,
    withFoodWrite: async (work: () => Promise<void>) => { await work(); return true; },
    setRecSaving: vi.fn(), setRecSaveError: vi.fn(), setFoods: vi.fn(), setViewDate: vi.fn(), setRecResult: vi.fn(), clearPendingRec: vi.fn(), showToast: vi.fn(), mergeFoodLogs: vi.fn(), inheritFoodBaseline: (_before: FoodLog[], next: FoodLog[]) => next,
  }; return p;
}
describe('page confirmation callback', () => {
  for (const kind of ['offline', '401', '503', 'timeout']) it(`${kind}: preserves pending result and never toasts success`, async () => {
    const p = pagePorts(vi.fn().mockRejectedValue(new Error(kind))); await pageHandler(p)();
    expect(p.setRecResult).not.toHaveBeenCalled(); expect(p.clearPendingRec).not.toHaveBeenCalled(); expect(p.showToast).not.toHaveBeenCalled(); expect(p.setFoods).not.toHaveBeenCalled();
    expect(p.setRecSaveError).toHaveBeenLastCalledWith(expect.stringContaining('草稿已保留'));
  });
  it('clears pending and displays success only after a confirmed save', async () => {
    const p = pagePorts(vi.fn().mockResolvedValue({ kind: 'saved', record: { id: 'confirmed' } })); await pageHandler(p)();
    expect(p.clearPendingRec).toHaveBeenCalledOnce(); expect(p.setRecResult).toHaveBeenCalledWith(null); expect(p.showToast).toHaveBeenCalledOnce();
  });
  it('missing binding does not invoke save', async () => {
    const save = vi.fn(), p = pagePorts(save); p.getConfig = () => null as never; await pageHandler(p)();
    expect(save).not.toHaveBeenCalled(); expect(p.clearPendingRec).not.toHaveBeenCalled(); expect(p.setRecSaveError).toHaveBeenCalledWith(expect.stringContaining('绑定'));
  });
  it('same-content new draft generation is not cleared by a late result', async () => {
    const wait = deferred<unknown>(), p = pagePorts(() => wait.promise); const result = pageHandler(p)();
    p.recDraftGenerationRef.current += 1; wait.resolve({ kind: 'saved', record: { id: 'old' } }); await result;
    expect(p.clearPendingRec).not.toHaveBeenCalled(); expect(p.showToast).not.toHaveBeenCalled();
  });
  it('edited draft is not cleared by a late result', async () => {
    const wait = deferred<unknown>(), p = pagePorts(() => wait.promise); const result = pageHandler(p)();
    p.currentRecDraftRef.current = 'new draft'; wait.resolve({ kind: 'saved', record: { id: 'old' } }); await result;
    expect(p.clearPendingRec).not.toHaveBeenCalled(); expect(p.setFoods).not.toHaveBeenCalled(); expect(p.showToast).not.toHaveBeenCalled();
  });
});


describe('photo recognition identity and actual edit callbacks', () => {
  function photoPorts() {
    let revision = 1;
    const p = { recDraftLocked: false, recDraftGenerationRef: { current: 0 }, recSaverRef: { current: createRecognizedFoodSaver() },
      mountedRef: { current: true }, getConfigRevision: () => revision, createRecognizedFoodSaver,
      setRecognizing: vi.fn(), setRecError: vi.fn(), setRecSaveError: vi.fn(), setRecResult: vi.fn(), setRecGrams: vi.fn(), savePendingRec: vi.fn(),
      compressImage: vi.fn().mockResolvedValue('synthetic'), recognizeFood: vi.fn().mockResolvedValue(draft.result),
    }; return { p, switchAccount: () => { revision += 1; } };
  }
  it('does not start another photo while the confirmation needs reconciliation', async () => {
    const { p } = photoPorts(); p.recDraftLocked = true;
    await pageHandler(p, 'handlePhoto')({ name: 'synthetic.png' }); expect(p.compressImage).not.toHaveBeenCalled();
  });
  it('binding change during compression prevents the AI request', async () => {
    const { p, switchAccount } = photoPorts(), wait = deferred<string>(); p.compressImage.mockReturnValue(wait.promise);
    const result = pageHandler(p, 'handlePhoto')({ name: 'synthetic.png' }); switchAccount(); wait.resolve('bytes'); await result;
    expect(p.recognizeFood).not.toHaveBeenCalled(); expect(p.savePendingRec).not.toHaveBeenCalled();
  });
  for (const stale of ['binding', 'generation', 'unmount']) it(`late photo after ${stale} cannot replace or persist a draft`, async () => {
    const { p, switchAccount } = photoPorts(), wait = deferred<unknown>(); p.recognizeFood.mockReturnValue(wait.promise);
    const result = pageHandler(p, 'handlePhoto')({ name: 'synthetic.png' }); await vi.waitFor(() => expect(p.recognizeFood).toHaveBeenCalledOnce());
    if (stale === 'binding') switchAccount(); else if (stale === 'generation') p.recDraftGenerationRef.current += 1; else p.mountedRef.current = false;
    wait.resolve(draft.result); await result;
    expect(p.setRecResult.mock.calls).toEqual([[null]]); expect(p.savePendingRec).not.toHaveBeenCalled();
  });
  function editControl(marker: string, attribute: string, ports: Record<string, unknown>) {
    const ast = ts.createSourceFile('index.tsx', pageSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let expression: ts.Expression | undefined, disabled = '';
    function visit(node: ts.Node) {
      if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.attributes.getText(ast).includes(marker)) {
        for (const attr of node.attributes.properties) if (ts.isJsxAttribute(attr) && attr.initializer && ts.isJsxExpression(attr.initializer)) {
          if (attr.name.getText(ast) === attribute) expression = attr.initializer.expression;
          if (attr.name.getText(ast) === 'disabled') disabled = attr.initializer.expression?.getText(ast) ?? '';
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(ast); if (!expression) throw new Error('control not found');
    const js = ts.transpileModule(`const fn = ${expression.getText(ast)}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    return { disabled, run: Function(...Object.keys(ports), js + '; return fn;')(...Object.values(ports)) };
  }
  it('photo recognition itself locks date, meal and grams until its loading is cleared', async () => {
    const ast = ts.createSourceFile('index.tsx', pageSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let expression = '';
    function visit(node: ts.Node) { if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'recDraftLocked') expression = node.initializer?.getText(ast) ?? ''; ts.forEachChild(node, visit); }
    visit(ast);
    expect(Function('recognizing', 'recSaving', 'recResult', 'recSaveError', 'return ' + expression)(true, false, null, '')).toBe(true);
    const { p } = photoPorts(); await pageHandler(p, 'handlePhoto')({ name: 'synthetic.png' });
    expect(p.setRecognizing.mock.calls).toEqual([[true], [false]]); expect(p.savePendingRec).toHaveBeenCalledOnce();
  });
  it('closing a pending confirmation makes its late result unable to clear a newer loading state', async () => {
    const wait = deferred<unknown>(), p = pagePorts(() => wait.promise);
    const result = pageHandler(p)();
    const close = editControl('recSaverRef.current = createRecognizedFoodSaver()', 'onClick', { ...p, createRecognizedFoodSaver });
    close.run(); p.setRecSaving.mockClear(); p.clearPendingRec.mockClear(); p.setRecResult.mockClear();
    // A new explicit operation owns the UI now.
    p.recSaveRequestRef.current += 1;
    wait.resolve({ kind: 'saved', record: { id: 'old' } }); await result;
    expect(p.setRecSaving).not.toHaveBeenCalled(); expect(p.clearPendingRec).not.toHaveBeenCalled(); expect(p.setRecResult).not.toHaveBeenCalled();
  });
  it('clicking the already selected meal does not invalidate an idle or in-flight draft', () => {
    const generation = { current: 2 }, setMeal = vi.fn();
    const control = editControl('key={m}', 'onClick', { m: '午餐', meal: '午餐', recDraftGenerationRef: generation, setMeal });
    control.run(); expect(generation.current).toBe(2); expect(setMeal).not.toHaveBeenCalled(); expect(control.disabled).toBe('recDraftLocked || manualDraftLocked');
  });
  it('same normalized grams/date are no-ops; pending controls bind the lock', () => {
    const generation = { current: 2 }, setRecGrams = vi.fn(), setLogDate = vi.fn();
    const grams = editControl('value={recGrams}', 'onChange', { recGrams: '80', recDraftGenerationRef: generation, setRecGrams });
    grams.run({ target: { value: '80克' } });
    const date = editControl('value={logDate}', 'onChange', { logDate: '2026-10-25', recDraftGenerationRef: generation, setLogDate });
    date.run({ target: { value: '2026-10-25' } });
    expect(generation.current).toBe(2); expect(setRecGrams).not.toHaveBeenCalled(); expect(setLogDate).not.toHaveBeenCalled();
    expect(grams.disabled).toBe('recDraftLocked'); expect(date.disabled).toBe('recDraftLocked || manualDraftLocked');
  });
});
