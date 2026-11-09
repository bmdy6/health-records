// 口述任务会话：localStorage 快照校验/恢复、何时立即写、何时 abort、request id 防旧结果
// 纯函数为主（可单测）；localStorage 读写是临时态（不是数据真源，不碰 WebDAV）
// 批次 2：切路由不 abort 由 Provider 生命周期保证，这里的纯函数把"何时 abort / 何时立即写"的决策显式化
import { validateNarration, toDrafts, type OralFoodDraft } from './food-narration';
import { localDateOfTs } from './date';

export type NarrationPhase = 'closed' | 'editing' | 'parsing' | 'repairing' | 'review';
// 快照里记录的 phase（closed 不落盘，直接清快照）
export type SnapshotPhase = 'editing' | 'parsing' | 'repairing' | 'review';
// 降级提示：解析中被完整刷新，Promise 无法恢复 → 回 editing 并提示重新分析
export type RestoreNotice = 'refresh-interrupted';

export const NARRATION_SNAPSHOT_KEY = 'food-narration-session:v1';
export const NARRATION_SNAPSHOT_VERSION = 1;
// text/drafts/phase 变化的防抖写入间隔（B3）；parse 开始/phase 迁移立即写，不走防抖
export const NARRATION_DEBOUNCE_MS = 250;

export interface NarrationSnapshot {
  v: typeof NARRATION_SNAPSHOT_VERSION;
  phase: SnapshotPhase;
  text: string;
  drafts: OralFoodDraft[];
  recordDate: string; // 口述开始那天的本地日期 YYYY-MM-DD；跨午夜确认仍写这天
  startedAt?: number;
  updatedAt: number;
}

// 恢复结果：ok=false 表示坏快照/版本不支持 → 安全清除回 closed
export interface RestoreOk {
  ok: true;
  phase: 'editing' | 'review';
  text: string;
  drafts: OralFoodDraft[];
  recordDate: string;
  notice: RestoreNotice | null;
}
export type RestoreResult = RestoreOk | { ok: false };

// 本地日期 YYYY-MM-DD（口述开始那天）——统一收敛到 lib/date.ts（批次 3），导出名保持兼容
export function localDateString(ts: number = Date.now()): string {
  return localDateOfTs(ts);
}

const SNAPSHOT_PHASES: SnapshotPhase[] = ['editing', 'parsing', 'repairing', 'review'];

// 解析 + 结构校验快照（坏 JSON/坏版本/坏字段 → null，调用方安全清除）
export function parseSnapshot(raw: string | null): NarrationSnapshot | null {
  if (!raw) return null;
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof o !== 'object' || o === null) return null;
  const s = o as Record<string, unknown>;
  if (s.v !== NARRATION_SNAPSHOT_VERSION) return null;
  if (typeof s.phase !== 'string' || !SNAPSHOT_PHASES.includes(s.phase as SnapshotPhase)) return null;
  if (typeof s.text !== 'string') return null;
  if (typeof s.recordDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s.recordDate)) return null;
  if (!Array.isArray(s.drafts)) return null;
  if (typeof s.updatedAt !== 'number' || !Number.isFinite(s.updatedAt)) return null;
  return {
    v: NARRATION_SNAPSHOT_VERSION,
    phase: s.phase as SnapshotPhase,
    text: s.text,
    drafts: s.drafts as unknown as OralFoodDraft[],
    recordDate: s.recordDate,
    startedAt: typeof s.startedAt === 'number' ? s.startedAt : undefined,
    updatedAt: s.updatedAt,
  };
}

// 恢复规则（定稿批次 2）：
// editing → 恢复原文；review → 严格校验草稿后恢复（校验不过按坏快照清除）；
// parsing/repairing（完整刷新后 Promise 不可恢复）→ 降级 editing + 提示；其余 → 安全清除
export function restoreFromSnapshot(raw: string | null): RestoreResult {
  const s = parseSnapshot(raw);
  if (!s) return { ok: false };
  switch (s.phase) {
    case 'editing':
      return { ok: true, phase: 'editing', text: s.text, drafts: [], recordDate: s.recordDate, notice: null };
    case 'review': {
      const v = validateNarration(s.drafts);
      if (!v.ok || !v.items || v.items.length === 0) return { ok: false };
      // 重新分配 id：避免历史会话的 id 与已保存 FoodLog 撞 id 被 merge 去重吞掉
      return { ok: true, phase: 'review', text: s.text, drafts: toDrafts(v.items), recordDate: s.recordDate, notice: null };
    }
    case 'parsing':
    case 'repairing':
      return { ok: true, phase: 'editing', text: s.text, drafts: [], recordDate: s.recordDate, notice: 'refresh-interrupted' };
  }
}

// 构造快照（updatedAt 默认当前时间）
export function buildSnapshot(
  phase: SnapshotPhase,
  text: string,
  drafts: OralFoodDraft[],
  recordDate: string,
  startedAt?: number,
  updatedAt: number = Date.now(),
): NarrationSnapshot {
  return { v: NARRATION_SNAPSHOT_VERSION, phase, text, drafts, recordDate, startedAt, updatedAt };
}

// B3 立即写时机：parse 开始（editing→parsing）与进行中阶段间的迁移（parsing→repairing、
// parsing/repairing→review 等）立即写；同 phase 的 text/drafts 变化走 250ms 防抖；
// 到 closed 由 close/finishSave 显式清快照，不在这里写
export function shouldPersistImmediately(from: NarrationPhase, to: NarrationPhase): boolean {
  if (from === to || to === 'closed') return false;
  return from === 'editing' || from === 'parsing' || from === 'repairing';
}

// abort 决策：只有用户点"取消/关闭"（进行中 → editing/closed）才 abort；
// 路由切换不改变 Provider phase → 永不 abort；结果正常返回（→ review）也不 abort
export function shouldAbortOnPhase(from: NarrationPhase, to: NarrationPhase): boolean {
  return (from === 'parsing' || from === 'repairing') && (to === 'editing' || to === 'closed');
}

// 连续点解析只允许一个在途请求：仅 editing 可发起
export function canStartParse(phase: NarrationPhase): boolean {
  return phase === 'editing';
}

// request id 防旧结果覆盖：旧请求（requestId !== latestRequestId）的结果丢弃
export function isStaleRequest(requestId: number, latestRequestId: number): boolean {
  return requestId !== latestRequestId;
}

// —— localStorage 读写（临时态，坏数据由恢复侧兜底）——
export function saveSnapshot(s: NarrationSnapshot): void {
  try {
    localStorage.setItem(NARRATION_SNAPSHOT_KEY, JSON.stringify(s));
  } catch {
    // 存储满/不可用时忽略：快照只是临时态，不影响本次会话
  }
}

export function clearSnapshot(): void {
  try {
    localStorage.removeItem(NARRATION_SNAPSHOT_KEY);
  } catch {
    // ignore
  }
}
