import { describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import pageSource from './index.tsx?raw';
import { createManualFoodSaver, type ManualFoodDraft } from './manual-food-save';
import type { BodyProfileAccess } from '../../lib/body';
import type { FoodLog } from '../../types';
import { mergeFoodLogs } from '../../lib/food-narration';

const cfg = { url: 'https://dav.invalid', username: 'synthetic', password: 'not-a-secret' };
const access = (): BodyProfileAccess => ({ config: { ...cfg }, revision: 1, isCurrent: () => true });
const draft: ManualFoodDraft = { name: '鸡胸肉', amount: '2', unit: '个', date: '2026-10-24', meal: '午餐', generation: 0 };
const estimated = { name: '合成库外食物', weight_g: 150, kcal: 101.9, protein_g: 3.12, carbs_g: 20, fat_g: 1.1 };
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function setup() {
  const read = vi.fn(async (): Promise<FoodLog[]> => []);
  const write = vi.fn(async (_rows: FoodLog[], _access: BodyProfileAccess): Promise<void> => {});
  const estimate = vi.fn(async () => estimated), id = vi.fn(() => `manual-${id.mock.calls.length}`);
  return { read, write, estimate, id, saver: createManualFoodSaver({ read, write, estimate, id, now: () => 123 }) };
}

describe('same-page manual food recovery', () => {
  for (const error of ['offline', '401', '503', 'timeout']) it(`${error}: retry keeps the ID, original contents and timestamps`, async () => {
    const f = setup(), a = access(); f.write.mockRejectedValueOnce(new Error(error));
    await expect(f.saver.save(draft, a, () => true)).rejects.toThrow(error);
    const first = f.write.mock.calls[0][0][0];
    expect(f.saver.hasUnconfirmedWrite()).toBe(true); expect(f.saver.isSaving()).toBe(false);
    const result = await f.saver.save(draft, a, () => true);
    expect(result).toEqual({ kind: 'saved', record: first }); expect(f.id).toHaveBeenCalledOnce();
    expect(f.write.mock.calls[1][0]).toEqual([first]); expect(f.saver.hasUnconfirmedWrite()).toBe(false);
  });
  it('an uncertain but committed PUT is reconciled without a duplicate write', async () => {
    const f = setup(), a = access(); let remote: FoodLog[] = [];
    f.read.mockImplementation(async () => remote);
    f.write.mockImplementationOnce(async (rows) => { remote = rows; throw new Error('ACK lost'); });
    await expect(f.saver.save(draft, a, () => true)).rejects.toThrow('ACK lost');
    expect((await f.saver.save(draft, a, () => true)).kind).toBe('saved');
    expect(remote).toHaveLength(1); expect(f.write).toHaveBeenCalledOnce();
  });
  it('an uncertain original cannot be silently replaced by an edited intent', async () => {
    const f = setup(), a = access(); f.write.mockRejectedValueOnce(new Error('unknown'));
    await expect(f.saver.save(draft, a, () => true)).rejects.toThrow();
    await expect(f.saver.save({ ...draft, amount: '3', generation: 1 }, a, () => true)).rejects.toThrow('尚未核对');
    expect(f.id).toHaveBeenCalledOnce(); expect(f.write).toHaveBeenCalledOnce();
    expect((await f.saver.save(draft, a, () => true)).kind).toBe('saved');
  });
  it('strict GET failure does not write and permits safe editing before any PUT', async () => {
    const f = setup(), a = access(); f.read.mockRejectedValueOnce(new Error('GET 503'));
    await expect(f.saver.save(draft, a, () => true)).rejects.toThrow('GET 503');
    expect(f.write).not.toHaveBeenCalled(); expect(f.saver.hasUnconfirmedWrite()).toBe(false);
    expect((await f.saver.save({ ...draft, amount: '3', generation: 1 }, a, () => true)).kind).toBe('saved');
    expect(f.write).toHaveBeenCalledOnce();
  });
  it('retains a completed AI estimate through saving failure and retries', async () => {
    const f = setup(), a = access(), unknown = { ...draft, name: '合成库外食物xyz' };
    f.write.mockRejectedValueOnce(new Error('503'));
    await expect(f.saver.save(unknown, a, () => true)).rejects.toThrow();
    await f.saver.save(unknown, a, () => true);
    expect(f.estimate).toHaveBeenCalledOnce(); expect(f.id).toHaveBeenCalledOnce();
    expect(f.write.mock.calls[0][0][0]).toMatchObject({ food: estimated.name, kcal: 102, protein: 3.12, grams: 150 });
  });
  it('failed AI releases the lock, performs no write and permits a corrected draft', async () => {
    const f = setup(); f.estimate.mockRejectedValueOnce(new Error('AI offline'));
    await expect(f.saver.save({ ...draft, name: '合成库外xyz' }, access(), () => true)).rejects.toThrow('AI offline');
    expect(f.write).not.toHaveBeenCalled(); expect(f.saver.isSaving()).toBe(false);
    expect((await f.saver.save(draft, access(), () => true)).kind).toBe('saved');
  });
  for (const phase of ['AI', 'GET', 'PUT']) it(`duplicates during ${phase} cannot issue a second operation`, async () => {
    const f = setup(), gate = deferred<any>();
    const input = phase === 'AI' ? { ...draft, name: '合成库外xyz' } : draft;
    if (phase === 'AI') f.estimate.mockReturnValue(gate.promise);
    else if (phase === 'GET') f.read.mockReturnValue(gate.promise); else f.write.mockReturnValue(gate.promise);
    const first = f.saver.save(input, access(), () => true);
    await vi.waitFor(() => expect(phase === 'AI' ? f.estimate : phase === 'GET' ? f.read : f.write).toHaveBeenCalledOnce());
    expect(await f.saver.save(input, access(), () => true)).toEqual({ kind: 'busy' });
    gate.resolve(phase === 'AI' ? estimated : phase === 'GET' ? [] : undefined);
    expect((await first).kind).toBe('saved'); expect(f.write).toHaveBeenCalledOnce();
  });
  for (const phase of ['AI', 'GET', 'PUT']) it(`account invalidation during ${phase} cannot acknowledge or start a later write`, async () => {
    const f = setup(), gate = deferred<any>(); let current = true;
    const a = { ...access(), isCurrent: () => current };
    const input = phase === 'AI' ? { ...draft, name: '合成库外xyz' } : draft;
    if (phase === 'AI') f.estimate.mockReturnValue(gate.promise);
    else if (phase === 'GET') f.read.mockReturnValue(gate.promise); else f.write.mockReturnValue(gate.promise);
    const first = f.saver.save(input, a, () => true);
    await vi.waitFor(() => expect(phase === 'AI' ? f.estimate : phase === 'GET' ? f.read : f.write).toHaveBeenCalledOnce());
    current = false; gate.resolve(phase === 'AI' ? estimated : phase === 'GET' ? [] : undefined);
    expect(await first).toEqual({ kind: 'stale' });
    expect(f.write).toHaveBeenCalledTimes(phase === 'PUT' ? 1 : 0);
  });
  it('does not reuse another binding pending identity', async () => {
    const f = setup(); f.write.mockRejectedValueOnce(new Error('unknown'));
    await expect(f.saver.save(draft, access(), () => true)).rejects.toThrow();
    await f.saver.save(draft, { ...access(), revision: 2, config: { ...cfg, username: 'other' } }, () => true);
    expect(f.id).toHaveBeenCalledTimes(2); expect(f.write.mock.calls[1][1].config.username).toBe('other');
  });
  it('conflicting same-ID content is not overwritten or acknowledged', async () => {
    const f = setup(), a = access(); f.write.mockRejectedValueOnce(new Error('unknown'));
    await expect(f.saver.save(draft, a, () => true)).rejects.toThrow();
    f.read.mockResolvedValue([{ ...f.write.mock.calls[0][0][0], deleted: true }]);
    await expect(f.saver.save(draft, a, () => true)).rejects.toThrow('已变化');
    expect(f.write).toHaveBeenCalledOnce(); expect(f.saver.hasUnconfirmedWrite()).toBe(true);
  });
  it('preserves unrelated fresh remote records and allocates a new ID only after confirmed completion', async () => {
    const f = setup(), a = access(), existing = { id: 'remote' } as FoodLog; f.read.mockResolvedValue([existing]);
    await f.saver.save(draft, a, () => true);
    expect(f.write.mock.calls[0][0][0]).toEqual(existing);
    await f.saver.save({ ...draft, generation: 1 }, a, () => true);
    expect(f.id).toHaveBeenCalledTimes(2);
  });
});

// Execute actual page callbacks with synthetic ports: these are not browser tests.
function handler(ports: Record<string, unknown>, name: string) {
  ports = { trackUse: vi.fn(), ...ports };
  const ast = ts.createSourceFile('index.tsx', pageSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let body: ts.Expression | undefined;
  function visit(n: ts.Node) { if (ts.isVariableDeclaration(n) && n.name.getText(ast) === name) body = n.initializer; ts.forEachChild(n, visit); }
  visit(ast); if (!body) throw new Error(`missing ${name}`);
  const js = ts.transpileModule(`const fn = ${body.getText(ast)}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return Function(...Object.keys(ports), `${js};return fn`)(...Object.values(ports));
}
function pagePorts(saver = setup().saver) {
  let revision = 1;
  const p = { trackUse: vi.fn(), amount: draft.amount, unit: draft.unit, logDate: draft.date, meal: draft.meal,
    manualSaverRef: { current: saver }, manualDraftGenerationRef: { current: 0 }, mountedRef: { current: true },
    foodWriteRef: { current: null as symbol | null }, setFoodWriting: vi.fn(), getConfig: () => cfg,
    getConfigRevision: () => revision, setManualSaving: vi.fn(), setManualSaveError: vi.fn(), setAiEstimating: vi.fn(),
    setFoods: vi.fn(), setViewDate: vi.fn(), setFoodName: vi.fn(), setAmount: vi.fn(), setUnit: vi.fn(), showToast: vi.fn(), mergeFoodLogs, inheritFoodBaseline: (_before: FoodLog[], next: FoodLog[]) => next,
    withFoodWrite: null as any,
  };
  p.withFoodWrite = handler(p, 'withFoodWrite');
  return { p, switchAccount: () => { revision += 1; p.manualSaverRef.current = setup().saver; p.manualDraftGenerationRef.current += 1; p.foodWriteRef.current = null; } };
}

describe('actual manual page save callbacks', () => {
  for (const error of ['offline', '401', '503', 'timeout']) it(`${error}: preserves all fields, list and view date, never toasts success`, async () => {
    const f = setup(); f.write.mockRejectedValue(new Error(error)); const { p } = pagePorts(f.saver);
    await handler(p, 'addFood')(draft.name);
    for (const setter of [p.setFoodName, p.setAmount, p.setUnit, p.setFoods, p.setViewDate, p.showToast]) expect(setter).not.toHaveBeenCalled();
    expect(p.trackUse).not.toHaveBeenCalled();
    expect(p.setManualSaveError).toHaveBeenLastCalledWith(expect.stringContaining('暂未确认保存'));
    expect(p.setManualSaving).toHaveBeenLastCalledWith(false); expect(p.foodWriteRef.current).toBe(null);
  });
  it('successful original retry clears fields and merges only the confirmed record', async () => {
    const f = setup(), { p } = pagePorts(f.saver); f.write.mockRejectedValueOnce(new Error('offline'));
    const save = handler(p, 'addFood'); await save(draft.name); await save(draft.name);
    expect(p.trackUse).not.toHaveBeenCalled(); // standalone has no tracking
    expect(p.setFoodName).toHaveBeenCalledOnce(); expect(p.setFoodName).toHaveBeenCalledWith('');
    expect(p.setAmount).toHaveBeenCalledWith('100'); expect(p.setUnit).toHaveBeenCalledWith('g');
    expect(p.setViewDate).toHaveBeenCalledWith(draft.date); expect(p.showToast).toHaveBeenCalledOnce();
    expect(p.setFoods.mock.calls[0][0]([{ id: 'unrelated' }])).toHaveLength(2); expect(f.id).toHaveBeenCalledOnce();
  });
  it('missing binding keeps draft and performs no IO', async () => {
    const f = setup(), { p } = pagePorts(f.saver); p.getConfig = () => null as never;
    await handler(p, 'addFood')(draft.name); expect(f.read).not.toHaveBeenCalled(); expect(p.setFoodName).not.toHaveBeenCalled();
    expect(p.setManualSaveError).toHaveBeenCalledWith(expect.stringContaining('绑定'));
  });
  for (const stale of ['account', 'unmount', 'edit']) it(`late save after ${stale} cannot clear input or show success`, async () => {
    const f = setup(), gate = deferred<void>(), { p, switchAccount } = pagePorts(f.saver); f.write.mockReturnValue(gate.promise);
    const save = handler(p, 'addFood')(draft.name); await vi.waitFor(() => expect(f.write).toHaveBeenCalledOnce());
    if (stale === 'account') switchAccount(); else if (stale === 'unmount') p.mountedRef.current = false; else p.manualDraftGenerationRef.current += 1;
    p.setManualSaving.mockClear(); gate.resolve(); await save;
    expect(p.setFoodName).not.toHaveBeenCalled(); expect(p.setFoods).not.toHaveBeenCalled(); expect(p.showToast).not.toHaveBeenCalled();
    if (stale !== 'edit') expect(p.setManualSaving).not.toHaveBeenCalled();
  });
  it('same-render duplicate clicks execute one pending submission', async () => {
    const f = setup(), gate = deferred<FoodLog[]>(), { p } = pagePorts(f.saver); f.read.mockReturnValue(gate.promise);
    const save = handler(p, 'addFood'), first = save(draft.name); await save(draft.name); gate.resolve([]); await first;
    expect(f.write).toHaveBeenCalledOnce(); expect(p.showToast).toHaveBeenCalledOnce();
  });
  it('mutex blocks adjacent writes while busy or uncertain and allows original retry', async () => {
    const f = setup(), gate = deferred<void>(), { p } = pagePorts(f.saver); f.write.mockReturnValueOnce(gate.promise);
    const save = handler(p, 'addFood'), first = save(draft.name); await vi.waitFor(() => expect(f.write).toHaveBeenCalledOnce());
    const adjacent = vi.fn(async () => {}); expect(await p.withFoodWrite(adjacent)).toBe(false);
    gate.reject(new Error('unknown')); await first;
    expect(await p.withFoodWrite(adjacent)).toBe(false); expect(adjacent).not.toHaveBeenCalled();
    await save(draft.name); expect(await p.withFoodWrite(adjacent)).toBe(true); expect(adjacent).toHaveBeenCalledOnce();
  });
  it('manual cannot overlap an adjacent operation and a failed adjacent operation releases the mutex', async () => {
    const f = setup(), { p } = pagePorts(f.saver), gate = deferred<void>();
    const adjacent = p.withFoodWrite(() => gate.promise); await handler(p, 'addFood')(draft.name);
    expect(f.read).not.toHaveBeenCalled(); gate.reject(new Error('old writer failed'));
    await expect(adjacent).rejects.toThrow('old writer failed'); expect(p.foodWriteRef.current).toBe(null);
    await handler(p, 'addFood')(draft.name); expect(f.write).toHaveBeenCalledOnce();
  });
  it('old finally cannot unlock another account operation', async () => {
    const { p, switchAccount } = pagePorts(), old = deferred<void>(), next = deferred<void>();
    const first = p.withFoodWrite(() => old.promise); switchAccount();
    const second = p.withFoodWrite(() => next.promise), token = p.foodWriteRef.current;
    old.resolve(); await first; expect(p.foodWriteRef.current).toBe(token);
    next.resolve(); await second; expect(p.foodWriteRef.current).toBe(null);
  });
  it('adjacent legacy entry points use the mutex; a rejected narration admission retains recorder draft', async () => {
    expect(pageSource).toContain('const delFood = async (f: FoodLog) => withFoodWrite');
    expect(pageSource).toContain('undo: () => { void withFoodWrite');
    expect(pageSource).toContain("onRetry={() => { void withFoodWrite");
    const { p } = pagePorts(); p.foodWriteRef.current = Symbol();
    await expect(handler(p, 'handleNarrationConfirm')([], draft.date)).rejects.toThrow('请先完成当前保存');
    expect(p.setFoods).not.toHaveBeenCalled();
  });
});

function control(marker: string, attr: string, ports: Record<string, unknown>) {
  const ast = ts.createSourceFile('index.tsx', pageSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression: ts.Expression | undefined, disabled = '';
  function visit(n: ts.Node) {
    if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && n.attributes.getText(ast).includes(marker)) {
      for (const a of n.attributes.properties) if (ts.isJsxAttribute(a) && a.initializer && ts.isJsxExpression(a.initializer)) {
        if (a.name.getText(ast) === attr) expression = a.initializer.expression;
        if (a.name.getText(ast) === 'disabled') disabled = a.initializer.expression?.getText(ast) ?? '';
      }
    }
    ts.forEachChild(n, visit);
  }
  visit(ast); if (!expression) throw new Error(`missing control ${marker}`);
  const js = ts.transpileModule(`const fn = ${expression.getText(ast)}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return { disabled, run: Function(...Object.keys(ports), `${js};return fn`)(...Object.values(ports)) };
}

describe('actual manual field callbacks', () => {
  for (const field of ['foodName', 'amount', 'unit', 'logDate', 'meal']) {
    const marker = field === 'meal' ? 'key={m}' : `value={${field}}`, attr = field === 'meal' ? 'onClick' : 'onChange';
    for (const phase of ['busy', 'unconfirmed', 'editable']) it(`${field} keeps original intent while ${phase}`, () => {
      const { p } = pagePorts();
      const setters = { setFoodName: p.setFoodName, setAmount: p.setAmount, setUnit: p.setUnit, setLogDate: vi.fn(), setMeal: vi.fn() };
      const ports = { ...p, ...setters, foodName: '鸡胸肉', recDraftGenerationRef: { current: 0 }, m: '晚餐',
        manualSaverRef: { current: { isSaving: () => phase === 'busy', hasUnconfirmedWrite: () => phase === 'unconfirmed' } } };
      const widget = control(marker, attr, ports);
      widget.run({ target: { value: field === 'amount' ? '3' : field === 'logDate' ? '2026-10-23' : field === 'unit' ? 'g' : '牛奶' } });
      expect(p.manualDraftGenerationRef.current).toBe(phase === 'editable' ? 1 : 0);
      expect(Object.values(setters).reduce((n, setter) => n + setter.mock.calls.length, 0)).toBe(phase === 'editable' ? 1 : 0);
      expect(widget.disabled).toContain('manualDraftLocked');
    });
  }
});

describe('food delete and undo keep confirmed state on conflict', () => {
  it('keeps the visible food and reports a failed deletion', async () => {
    const food = { id: 'rice', food: '米饭' } as FoodLog;
    const setFoods = vi.fn(), showToast = vi.fn();
    const ports = { foods: [food], setFoods, showToast, inheritFoodBaseline: (_a: FoodLog[], b: FoodLog[]) => b,
      withFoodWrite: async (run: () => Promise<void>) => { await run(); return true; }, saveFoodLogs: vi.fn().mockRejectedValue(new Error('食物已被其他客户端修改')) };
    await expect(handler(ports, 'delFood')(food)).resolves.toBe(true);
    expect(setFoods).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith({ text: expect.stringContaining('其他客户端') });
  });
  it('shows deletion only after save and preserves it when undo fails', async () => {
    const food = { id: 'rice', food: '米饭' } as FoodLog;
    const setFoods = vi.fn(), showToast = vi.fn(), saveFoodLogs = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('恢复冲突'));
    const ports = { foods: [food], setFoods, showToast, saveFoodLogs, inheritFoodBaseline: (_a: FoodLog[], b: FoodLog[]) => b,
      withFoodWrite: async (run: () => Promise<void>) => { await run(); return true; } };
    await handler(ports, 'delFood')(food); expect(setFoods).toHaveBeenCalledWith([]);
    showToast.mock.calls[0][0].undo(); await vi.waitFor(() => expect(showToast).toHaveBeenLastCalledWith({ text: '恢复冲突' }));
    expect(setFoods).toHaveBeenCalledOnce();
  });
});
