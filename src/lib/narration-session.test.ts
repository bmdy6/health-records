// 口述任务会话快照（定稿批次 2）：恢复/严格校验/立即写时机/abort 决策/request id 纯函数单测
// localStorage 读写是临时态（不是数据真源），用 stub 隔离；恢复侧纯函数直接测
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  NARRATION_SNAPSHOT_KEY, NARRATION_SNAPSHOT_VERSION,
  parseSnapshot, restoreFromSnapshot, buildSnapshot,
  shouldPersistImmediately, shouldAbortOnPhase, canStartParse, isStaleRequest,
  saveSnapshot, clearSnapshot,
  type NarrationSnapshot,
} from './narration-session';
import type { OralFoodDraft } from './food-narration';

// 合法草稿（与 vision-prompts NARRATION_PROMPT 契约一致）
const VALID_ITEMS: Array<Omit<OralFoodDraft, 'id'>> = [
  { meal: '早餐', name: '水煮蛋', amount: 2, unit: '个', grams: 110, kcal: 154, protein_g: 12.6, carbs_g: 1.1, fat_g: 10.6 },
  { meal: '午餐', name: '黄焖鸡米饭', amount: 1, unit: '份', grams: 400, kcal: 650, protein_g: 30, carbs_g: 80, fat_g: 25 },
];

function snapDrafts(items: Array<Omit<OralFoodDraft, 'id'>> = VALID_ITEMS): OralFoodDraft[] {
  return items.map((it, i) => ({ ...it, id: `snap-${i}` }));
}

// 构造快照 JSON（默认 editing / 原文 / 空草稿 / recordDate=2026-08-07），overrides 用于坏快照用例
function rawSnapshot(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: NARRATION_SNAPSHOT_VERSION,
    phase: 'editing',
    text: '早上吃了两个水煮蛋，中午吃了黄焖鸡米饭',
    drafts: [],
    recordDate: '2026-08-07',
    updatedAt: 1780000000000,
    ...overrides,
  });
}

const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
});

beforeEach(() => {
  store.clear();
});

describe('定稿批次 2 场景（快照恢复 + 跨路由会话）', () => {
  it('场景1: editing 快照恢复原文（草稿不继承、无降级提示）', () => {
    const raw = rawSnapshot({ drafts: snapDrafts() }); // editing 快照即使残留草稿也只恢复原文
    const r = restoreFromSnapshot(raw);
    expect(r).toEqual({
      ok: true,
      phase: 'editing',
      text: '早上吃了两个水煮蛋，中午吃了黄焖鸡米饭',
      drafts: [],
      recordDate: '2026-08-07',
      notice: null,
    });
  });

  it('场景2: review 草稿严格校验后恢复（重新分配 id 防撞已保存 FoodLog）；非法草稿/空草稿按坏快照拒绝', () => {
    // 合法草稿 → 恢复 review，原文保留、id 全部重新生成（不沿用历史 id）
    const r = restoreFromSnapshot(rawSnapshot({ phase: 'review', drafts: snapDrafts() }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.phase).toBe('review');
    expect(r.text).toBe('早上吃了两个水煮蛋，中午吃了黄焖鸡米饭');
    expect(r.drafts.length).toBe(2);
    expect(r.drafts.map((d) => d.name)).toEqual(['水煮蛋', '黄焖鸡米饭']);
    expect(r.drafts.some((d) => d.id === 'snap-0')).toBe(false); // 防历史 id 与已保存 FoodLog 撞 id 被 merge 去重吞掉
    expect(r.notice).toBeNull();
    // 非法草稿（meal 不在白名单）→ 整批拒绝
    const badMeal = snapDrafts() as unknown as Array<Record<string, unknown>>;
    badMeal[0].meal = '夜宵';
    expect(restoreFromSnapshot(rawSnapshot({ phase: 'review', drafts: badMeal }))).toEqual({ ok: false });
    // 缺字段草稿 → 拒绝
    const missing = [{ meal: '早餐', name: '鸡蛋', amount: 1, unit: '个', grams: 55, kcal: 77, protein_g: 6, carbs_g: 0, fat_g: 5, id: 'x' }];
    delete (missing[0] as Record<string, unknown>).carbs_g;
    expect(restoreFromSnapshot(rawSnapshot({ phase: 'review', drafts: missing }))).toEqual({ ok: false });
    // 空草稿数组（无食物）→ review 无内容可确认，按坏快照拒绝
    expect(restoreFromSnapshot(rawSnapshot({ phase: 'review', drafts: [] }))).toEqual({ ok: false });
  });

  it('场景3: parsing/repairing 快照刷新后降级 editing + notice=refresh-interrupted', () => {
    for (const phase of ['parsing', 'repairing']) {
      const r = restoreFromSnapshot(rawSnapshot({ phase, drafts: snapDrafts() }));
      expect(r).toEqual({
        ok: true,
        phase: 'editing',
        text: '早上吃了两个水煮蛋，中午吃了黄焖鸡米饭',
        drafts: [], // 中间结果不可恢复，只保原文
        recordDate: '2026-08-07',
        notice: 'refresh-interrupted',
      });
    }
  });

  it('场景4: 坏 JSON/坏版本/坏字段快照 → {ok:false}（调用方安全清除回 closed）', () => {
    // 坏 JSON / 空值
    expect(restoreFromSnapshot(null)).toEqual({ ok: false });
    expect(restoreFromSnapshot('')).toEqual({ ok: false });
    expect(restoreFromSnapshot('{not json')).toEqual({ ok: false });
    expect(restoreFromSnapshot('null')).toEqual({ ok: false });
    expect(restoreFromSnapshot('"str"')).toEqual({ ok: false });
    expect(restoreFromSnapshot('[1,2]')).toEqual({ ok: false });
    // 坏版本
    expect(restoreFromSnapshot(rawSnapshot({ v: 2 }))).toEqual({ ok: false });
    // 坏 phase
    expect(restoreFromSnapshot(rawSnapshot({ phase: 'bogus' }))).toEqual({ ok: false });
    // 坏/缺字段
    expect(restoreFromSnapshot(rawSnapshot({ text: 123 }))).toEqual({ ok: false });
    expect(restoreFromSnapshot(rawSnapshot({ text: undefined }))).toEqual({ ok: false }); // 序列化后缺 text
    expect(restoreFromSnapshot(rawSnapshot({ recordDate: '2026/08/07' }))).toEqual({ ok: false });
    expect(restoreFromSnapshot(rawSnapshot({ drafts: 'nope' }))).toEqual({ ok: false });
    expect(restoreFromSnapshot(rawSnapshot({ updatedAt: 'x' }))).toEqual({ ok: false });
    expect(restoreFromSnapshot(rawSnapshot({ updatedAt: undefined }))).toEqual({ ok: false }); // 缺 updatedAt
    // parseSnapshot 同规则：坏输入一律 null
    expect(parseSnapshot('{bad')).toBeNull();
    expect(parseSnapshot(rawSnapshot({ v: 99 }))).toBeNull();
  });

  it('场景5: recordDate 跨午夜保留（恢复原快照日期，不取"今天"）', () => {
    const r = restoreFromSnapshot(rawSnapshot({ phase: 'editing', recordDate: '2026-08-07' }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.recordDate).toBe('2026-08-07');
    // review 恢复同样保留口述开始那天
    const r2 = restoreFromSnapshot(rawSnapshot({ phase: 'review', drafts: snapDrafts(), recordDate: '2026-08-07' }));
    if (r2.ok) expect(r2.recordDate).toBe('2026-08-07');
    // parseSnapshot 原样读出 recordDate
    expect(parseSnapshot(rawSnapshot({ recordDate: '2026-08-06' }))?.recordDate).toBe('2026-08-06');
  });

  it('场景6: 保存成功/显式放弃后清快照（clearSnapshot 移除 localStorage）', () => {
    const rm = vi.spyOn(localStorage, 'removeItem');
    const snap: NarrationSnapshot = {
      v: NARRATION_SNAPSHOT_VERSION, phase: 'review', text: '早上吃了两个水煮蛋',
      drafts: snapDrafts(), recordDate: '2026-08-07', updatedAt: 1780000000000,
    };
    saveSnapshot(snap);
    expect(localStorage.getItem(NARRATION_SNAPSHOT_KEY)).toBe(JSON.stringify(snap));
    // 写后读：快照能恢复出原文（Provider 挂载路径）
    const r = restoreFromSnapshot(localStorage.getItem(NARRATION_SNAPSHOT_KEY));
    expect(r.ok).toBe(true);
    // 显式放弃（close/finishSave 路径）→ 清快照
    clearSnapshot();
    expect(rm).toHaveBeenCalledWith(NARRATION_SNAPSHOT_KEY);
    expect(localStorage.getItem(NARRATION_SNAPSHOT_KEY)).toBeNull();
  });

  it('场景7: request id 防旧结果覆盖（isStaleRequest：旧请求结果丢弃，仅最新采用）', () => {
    expect(isStaleRequest(1, 2)).toBe(true);  // 旧请求（1）回来时最新已是 2 → 丢弃
    expect(isStaleRequest(2, 2)).toBe(false); // 最新请求 → 采用
    expect(isStaleRequest(3, 2)).toBe(true);
    // 连续点解析只允许一个在途请求：仅 editing 可发起
    expect(canStartParse('editing')).toBe(true);
    expect(canStartParse('parsing')).toBe(false);
    expect(canStartParse('repairing')).toBe(false);
    expect(canStartParse('review')).toBe(false);
    expect(canStartParse('closed')).toBe(false);
  });

  it('场景8: 用户取消触发 abort，路由卸载/结果正常返回不 abort（shouldAbortOnPhase）', () => {
    // 用户点取消/关闭（进行中 → editing/closed）→ abort
    expect(shouldAbortOnPhase('parsing', 'editing')).toBe(true);
    expect(shouldAbortOnPhase('parsing', 'closed')).toBe(true);
    expect(shouldAbortOnPhase('repairing', 'editing')).toBe(true);
    expect(shouldAbortOnPhase('repairing', 'closed')).toBe(true);
    // 结果正常返回（→ review）→ 不 abort
    expect(shouldAbortOnPhase('parsing', 'review')).toBe(false);
    expect(shouldAbortOnPhase('repairing', 'review')).toBe(false);
    // 路由切换不改变 phase（同 phase）→ 永不 abort
    expect(shouldAbortOnPhase('parsing', 'parsing')).toBe(false);
    expect(shouldAbortOnPhase('review', 'review')).toBe(false);
    expect(shouldAbortOnPhase('editing', 'editing')).toBe(false);
    // 无在途请求的阶段 → 不 abort
    expect(shouldAbortOnPhase('editing', 'parsing')).toBe(false);
    expect(shouldAbortOnPhase('editing', 'closed')).toBe(false);
    expect(shouldAbortOnPhase('review', 'closed')).toBe(false);
    expect(shouldAbortOnPhase('closed', 'editing')).toBe(false);
  });

  it('B3: 立即写时机 —— parse 开始/phase 迁移立即写，同 phase 的 text/drafts 变化走 250ms 防抖', () => {
    // 立即写：parse 开始（editing→parsing）与进行中阶段间迁移（parsing→repairing/review 等）
    expect(shouldPersistImmediately('editing', 'parsing')).toBe(true);
    expect(shouldPersistImmediately('parsing', 'repairing')).toBe(true);
    expect(shouldPersistImmediately('parsing', 'review')).toBe(true);
    expect(shouldPersistImmediately('repairing', 'review')).toBe(true);
    // 防抖：同 phase 变化（Provider 侧 setTimeout 250ms 后落盘）
    expect(shouldPersistImmediately('editing', 'editing')).toBe(false);
    expect(shouldPersistImmediately('parsing', 'parsing')).toBe(false);
    expect(shouldPersistImmediately('review', 'review')).toBe(false);
    // closed 由 close/finishSave 显式清快照，不走写路径
    expect(shouldPersistImmediately('editing', 'closed')).toBe(false);
    expect(shouldPersistImmediately('review', 'closed')).toBe(false);
    expect(shouldPersistImmediately('parsing', 'closed')).toBe(false);
  });

  it('buildSnapshot 默认 updatedAt=当前时间、startedAt 可携带', () => {
    const s = buildSnapshot('parsing', '早上吃了两个水煮蛋', [], '2026-08-07');
    expect(s.v).toBe(NARRATION_SNAPSHOT_VERSION);
    expect(s.phase).toBe('parsing');
    expect(s.text).toBe('早上吃了两个水煮蛋');
    expect(s.recordDate).toBe('2026-08-07');
    expect(s.startedAt).toBeUndefined();
    expect(typeof s.updatedAt).toBe('number');
    expect(s.updatedAt).toBeGreaterThan(0);
    // 带 startedAt（parse 开始时间）
    const s2 = buildSnapshot('parsing', 'x', [], '2026-08-07', 1000, 2000);
    expect(s2.startedAt).toBe(1000);
    expect(s2.updatedAt).toBe(2000);
  });
});
