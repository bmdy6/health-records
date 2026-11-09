// 口述饮食记录：输入 → 解析 → 待确认列表 → 批量确认回调
// 状态与在途请求由 App 级 NarrationProvider 持有：切路由不 abort，回来继续；
// 只有用户点"取消/关闭"才 abort。本组件只消费 context + 执行保存回调
import { useEffect, useState } from 'react';
import { MessageSquareText, Check } from 'lucide-react';
import {
  MEAL_OPTIONS, scaleByAmount, scaleByGrams,
  type Meal, type OralFoodDraft,
} from '../../lib/food-narration';
import { useNarration } from './NarrationProvider';
import { localToday as today } from '../../lib/date';

const MAX_LEN = 500;

interface Props {
  onConfirm: (drafts: OralFoodDraft[], date: string) => Promise<void>;
}

export default function OralFoodRecorder({ onConfirm }: Props) {
  const {
    phase, text, setText, drafts, editDraft, removeDraft, error, waitSec, notice, recordDate,
    startNarration, close, cancelParsing, parse, finishSave,
  } = useNarration();
  const [saving, setSaving] = useState(false);
  // 确认日期：默认口述开始那天（跨天确认仍记那天），用户可改；初始今天兑底
  const [confirmDate, setConfirmDate] = useState(today());
  useEffect(() => {
    if (phase === 'review') setConfirmDate(recordDate || today());
  }, [phase, recordDate]);

  const confirmAll = async (date: string) => {
    if (saving || drafts.length === 0) return;
    setSaving(true);
    try {
      await onConfirm(drafts, date || today());
      finishSave(); // 保存成功：Provider 复位并清快照
    } catch {
      // 保存失败：保留 review 草稿与快照（父组件已置 sync=error 并提示）
    } finally {
      setSaving(false);
    }
  };

  if (phase === 'closed') {
    return (
      <button onClick={startNarration} className="btn-primary w-full h-11 text-sm">
        <MessageSquareText size={16} strokeWidth={1.5} />
        口述记录
      </button>
    );
  }

  return (
    <div className="card mt-3 border border-neutral-100 p-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">口述今天吃了什么</span>
        <button onClick={close} disabled={saving} className="text-xs text-neutral-400 disabled:opacity-40" aria-label="关闭">✕</button>
      </div>

      {(phase === 'editing') && (
        <>
          {notice === 'refresh-interrupted' && (
            <div className="mt-1 text-xs text-neutral-600">上次分析被页面刷新中断，原话已保留，点一下可重新分析</div>
          )}
          <textarea
            value={text}
            onChange={(e) => { setText(e.target.value.slice(0, MAX_LEN)); }}
            maxLength={MAX_LEN}
            rows={4}
            placeholder="用一句话说今天吃了什么，可以一次说好几餐，比如：早上吃了两个水煮蛋一杯牛奶，中午吃了一份黄焖鸡米饭加一个苹果，下午喝了一杯珍珠奶茶三分糖，晚上吃了一碗米饭一份青椒炒肉"
            className="input mt-2 w-full resize-none text-sm leading-relaxed"
          />
          <div className="mt-1 text-right text-[11px] text-neutral-400 tabular-nums">{text.length}/{MAX_LEN}</div>
          {error && (
            <div className="mt-1 text-xs text-neutral-600">
              <div>{error.message}</div>
              {error.summary && (
                <details className="mt-0.5">
                  <summary className="cursor-pointer text-[11px] text-neutral-400">技术摘要</summary>
                  <p className="mt-0.5 break-all text-[11px] text-neutral-400">返回摘要：{error.summary}</p>
                </details>
              )}
            </div>
          )}
          <div className="mt-2 flex gap-2">
            <button onClick={close} className="btn-secondary h-9 flex-1 text-sm">取消</button>
            <button onClick={parse} disabled={!text.trim()} className="btn-primary h-9 flex-1 text-sm disabled:opacity-40">
              解析并预览
            </button>
          </div>
        </>
      )}

      {phase === 'parsing' && (
        <div className="mt-3">
          <div className="flex items-center gap-2 text-sm text-neutral-600">
            <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-900" />
            正在分析今日饮食…（通常约 15-18 秒，已等待 {waitSec} 秒）
          </div>
          <button onClick={cancelParsing} className="btn-secondary mt-3 h-9 w-full text-sm">取消</button>
        </div>
      )}

      {phase === 'repairing' && (
        <div className="mt-3">
          <div className="flex items-center gap-2 text-sm text-neutral-600">
            <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-900" />
            正在重试解析…（已等待 {waitSec} 秒）
          </div>
          <button onClick={cancelParsing} className="btn-secondary mt-3 h-9 w-full text-sm">取消</button>
        </div>
      )}

      {phase === 'review' && (
        <>
          <div className="mt-2 space-y-2">
            {drafts.map((d) => (
              <div key={d.id} className="rounded-xl bg-neutral-50 px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm">{d.name}</span>
                      <span className="shrink-0 text-[11px] text-neutral-400">原述 {d.amount}{d.unit}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs text-neutral-500 tabular-nums">
                      <select
                        value={d.meal}
                        onChange={(e) => editDraft(d.id, (x) => ({ ...x, meal: e.target.value as Meal }))}
                        className="h-7 rounded-md border border-neutral-200 bg-white px-1 text-xs"
                      >
                        {MEAL_OPTIONS.map((m) => <option key={m} value={m}>{m}</option>)}
                      </select>
                      <label className="flex items-center gap-1">
                        <input
                          type="text" inputMode="decimal"
                          value={d.amount}
                          onChange={(e) => {
                            const v = parseFloat(e.target.value.replace(/[^\d.]/g, ''));
                            editDraft(d.id, (x) => (Number.isFinite(v) && v > 0 ? scaleByAmount(x, v) : { ...x, amount: x.amount }));
                          }}
                          className="h-7 w-12 rounded-md border border-neutral-200 bg-white px-1 text-center text-xs"
                        />
                        <span>{d.unit}</span>
                      </label>
                      <label className="flex items-center gap-1">
                        <input
                          type="text" inputMode="decimal"
                          value={d.grams}
                          onChange={(e) => {
                            const v = parseFloat(e.target.value.replace(/[^\d.]/g, ''));
                            editDraft(d.id, (x) => (Number.isFinite(v) && v > 0 ? scaleByGrams(x, v) : { ...x, grams: x.grams }));
                          }}
                          className="h-7 w-14 rounded-md border border-neutral-200 bg-white px-1 text-center text-xs"
                        />
                        <span>克</span>
                      </label>
                      <span className="text-neutral-400">{Math.round(d.kcal)}千卡 P{d.protein_g.toFixed(1)} C{d.carbs_g.toFixed(1)} F{d.fat_g.toFixed(1)}</span>
                    </div>
                  </div>
                  <button onClick={() => removeDraft(d.id)} disabled={saving} className="btn-sm text-neutral-300 hover:text-neutral-900 disabled:opacity-40" aria-label="删除">✕</button>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <span className="text-xs text-neutral-500">记录日期</span>
            <input
              type="date"
              value={confirmDate}
              onChange={(e) => setConfirmDate(e.target.value)}
              className="input h-8 w-36 text-sm"
            />
            {recordDate && recordDate !== confirmDate && (
              <span className="text-[11px] text-neutral-400">口述于 {recordDate.slice(5)}</span>
            )}
          </div>
          <div className="mt-3 flex gap-2">
            <button onClick={close} disabled={saving} className="btn-secondary h-9 flex-1 text-sm disabled:opacity-40">取消</button>
            <button onClick={() => confirmAll(confirmDate)} disabled={saving || drafts.length === 0} className="btn-primary h-9 flex-1 text-sm disabled:opacity-40">
              {saving ? '保存中…' : (
                <span className="flex items-center justify-center gap-1">
                  <Check size={15} strokeWidth={2} /> 批量加入今日记录（{drafts.length} 条）
                </span>
              )}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
