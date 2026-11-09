// 口述任务会话 Provider：App 级持有 phase/text/drafts/error/recordDate/在途请求 AbortController
// - 包住 Routes：切路由 Provider 不卸载、不 abort，回来继续显示进度/结果
// - 只有用户点"取消/关闭"才 abort（决策收敛在 shouldAbortOnPhase，纯函数可测）
// - 快照（B3）：text/drafts/phase 变化 debounce 250ms 写；parse 开始、phase 迁移（如 parsing→review）立即写
// - 保存成功/显式放弃 → 清快照；保存失败 → 保留 review 草稿；recordDate 随草稿保留（跨午夜确认仍写口述开始那天）
// Provider 不渲染任何 UI，只提供 context
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from 'react';
import { recognizeFoodNarration, NarrationError } from '../../lib/vision';
import { toDrafts, type OralFoodDraft } from '../../lib/food-narration';
import {
  NARRATION_SNAPSHOT_KEY, NARRATION_DEBOUNCE_MS,
  restoreFromSnapshot, saveSnapshot, clearSnapshot, buildSnapshot,
  shouldPersistImmediately, shouldAbortOnPhase, canStartParse, isStaleRequest,
  localDateString, type NarrationPhase, type RestoreOk, type RestoreNotice,
} from '../../lib/narration-session';

// 失败提示：NarrationError.message（人话）+ safeSummary（≤120 字，可折叠展示）
export interface NarrationErrorInfo {
  message: string;
  summary?: string;
}

export interface NarrationContextValue {
  phase: NarrationPhase;
  text: string;
  setText: (t: string) => void;
  drafts: OralFoodDraft[];
  editDraft: (id: string, patch: (d: OralFoodDraft) => OralFoodDraft) => void;
  removeDraft: (id: string) => void;
  error: NarrationErrorInfo | null;
  recordDate: string;
  waitSec: number;
  notice: RestoreNotice | null;
  startNarration: () => void;
  close: () => void;
  cancelParsing: () => void;
  parse: () => void;
  finishSave: () => void;
}

const NarrationContext = createContext<NarrationContextValue | null>(null);

// 挂载时一次性恢复：坏快照/版本不支持 → 安全清除回 closed
function initFromSnapshot(): RestoreOk | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(NARRATION_SNAPSHOT_KEY);
  } catch {
    return null;
  }
  const r = restoreFromSnapshot(raw);
  if (!r.ok) {
    if (raw !== null) clearSnapshot();
    return null;
  }
  return r;
}

export function NarrationProvider({ children }: { children: ReactNode }) {
  const [initial] = useState(initFromSnapshot);
  const [phase, setPhase] = useState<NarrationPhase>(initial?.phase ?? 'closed');
  const [text, setTextState] = useState(initial?.text ?? '');
  const [drafts, setDrafts] = useState<OralFoodDraft[]>(initial?.phase === 'review' ? initial.drafts : []);
  const [error, setError] = useState<NarrationErrorInfo | null>(null);
  const [recordDate, setRecordDate] = useState(initial?.recordDate ?? '');
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [waitSec, setWaitSec] = useState(0);
  const [notice, setNotice] = useState<RestoreNotice | null>(initial?.notice ?? null);
  const abortRef = useRef<AbortController | null>(null);
  const reqIdRef = useRef(0);
  const timerRef = useRef<number | null>(null);

  const stopTimer = useCallback(() => {
    if (timerRef.current) { window.clearInterval(timerRef.current); timerRef.current = null; }
    setWaitSec(0);
  }, []);
  const startTimer = useCallback(() => {
    stopTimer();
    setWaitSec(0);
    timerRef.current = window.setInterval(() => setWaitSec((s) => s + 1), 1000);
  }, [stopTimer]);

  // 快照持久化（B3）：closed 清快照；立即写场景立即落盘；其余 debounce 250ms
  const prevPhaseRef = useRef(phase);
  useEffect(() => {
    const prev = prevPhaseRef.current;
    prevPhaseRef.current = phase;
    if (phase === 'closed') {
      clearSnapshot();
      return;
    }
    const snap = () => buildSnapshot(phase, text, drafts, recordDate, startedAt ?? undefined);
    if (shouldPersistImmediately(prev, phase)) {
      saveSnapshot(snap());
      return;
    }
    const t = window.setTimeout(() => saveSnapshot(snap()), NARRATION_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [phase, text, drafts, recordDate, startedAt]);

  const setText = useCallback((t: string) => {
    setTextState(t);
    setError(null); // 用户改原文 → 清掉上次失败提示
  }, []);

  const startNarration = useCallback(() => {
    if (phase !== 'closed') return;
    setRecordDate(localDateString()); // 口述开始那天；跨午夜确认仍写这天
    setPhase('editing');
  }, [phase]);

  const close = useCallback(() => {
    // 用户点"关闭/放弃"：进行中才 abort；结束后清快照（effect 处理）
    if (shouldAbortOnPhase(phase, 'closed')) abortRef.current?.abort();
    abortRef.current = null;
    stopTimer();
    setPhase('closed');
    setTextState('');
    setDrafts([]);
    setError(null);
    setNotice(null);
    setRecordDate('');
    setStartedAt(null);
  }, [phase, stopTimer]);

  const cancelParsing = useCallback(() => {
    // 用户点"取消"：abort 在途请求，保留原文回编辑态（快照随之 debounce 更新）
    if (shouldAbortOnPhase(phase, 'editing')) abortRef.current?.abort();
    abortRef.current = null;
    stopTimer();
    setError(null);
    setNotice(null);
    setPhase('editing');
    setStartedAt(null);
  }, [phase, stopTimer]);

  const parse = useCallback(() => {
    const t = text.trim();
    if (!t || !canStartParse(phase)) return; // 只允许一个在途请求
    setError(null);
    setNotice(null);
    setPhase('parsing');
    setStartedAt(Date.now());
    startTimer();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const reqId = ++reqIdRef.current;
    void (async () => {
      try {
        const items = await recognizeFoodNarration(t, {
          signal: ctrl.signal, // 真取消：批次 1 已接通 fetch
          onStage: (stage) => {
            if (stage === 'correcting') setPhase('repairing'); // 只在此时切 repairing，不切回
            if (stage === 'fallback') setPhase('repairing'); // 主模型不可用，切备用模型重试
          },
        });
        if (ctrl.signal.aborted || isStaleRequest(reqId, reqIdRef.current)) return;
        stopTimer();
        if (items.length === 0) {
          setError({ message: '没识别到可记录的食物，请补充食物/餐别再试' });
          setPhase('editing');
          return;
        }
        setDrafts(toDrafts(items));
        setPhase('review');
      } catch (e) {
        stopTimer();
        if (ctrl.signal.aborted || isStaleRequest(reqId, reqIdRef.current)) return;
        if (e instanceof NarrationError) {
          setError({ message: e.message, summary: e.summary });
        } else {
          setError({ message: e instanceof Error ? e.message : '解析失败，请重试' });
        }
        setPhase('editing');
      } finally {
        if (abortRef.current === ctrl) abortRef.current = null;
      }
    })();
  }, [text, phase, startTimer, stopTimer]);

  const editDraft = useCallback((id: string, patch: (d: OralFoodDraft) => OralFoodDraft) => {
    setDrafts((ds) => ds.map((d) => (d.id === id ? patch(d) : d)));
  }, []);

  const removeDraft = useCallback((id: string) => {
    setDrafts((ds) => ds.filter((d) => d.id !== id));
  }, []);

  // 保存成功 → 清快照回 closed；保存失败路径由调用方保留 review（不调用本函数）
  const finishSave = useCallback(() => {
    setPhase('closed');
    setTextState('');
    setDrafts([]);
    setError(null);
    setNotice(null);
    setRecordDate('');
    setStartedAt(null);
  }, []);

  const value = useMemo<NarrationContextValue>(() => ({
    phase, text, setText, drafts, editDraft, removeDraft, error, recordDate, waitSec, notice,
    startNarration, close, cancelParsing, parse, finishSave,
  }), [phase, text, setText, drafts, editDraft, removeDraft, error, recordDate, waitSec, notice,
      startNarration, close, cancelParsing, parse, finishSave]);

  return <NarrationContext.Provider value={value}>{children}</NarrationContext.Provider>;
}

export function useNarration(): NarrationContextValue {
  const ctx = useContext(NarrationContext);
  if (!ctx) throw new Error('useNarration 必须在 NarrationProvider 内使用');
  return ctx;
}
