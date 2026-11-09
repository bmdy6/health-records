import { ChevronDown, Dumbbell, Utensils } from 'lucide-react';
import type { NutritionSummary, ProgressSummary, EstimateReason } from '../../lib/health-summary';
import { localToday } from '../../lib/date';
import type { WorkoutLog } from '../../lib/health-model';

const n = (value: number) => Math.round(value * 10) / 10;
const format = (value: number) => n(value).toLocaleString('zh-CN');
const reasons: Record<EstimateReason, string> = {
  'maintenance-goal':'这是维持目标，当前体重与目标仍有差值，暂不外推期限',
  'no-data':'先记录体重，再一起看变化', 'missing-goal':'设置目标后开始跟踪进度',
  'invalid-today':'日期无效，请刷新后重试', 'stale-data':'最近体重超过 7 天未更新',
  'insufficient-observations':'需要至少 4 天的体重记录', 'short-observation-span':'需要至少 14 天的观察跨度',
  'plateau':'近期体重变化较小，继续观察', 'opposite-trend':'近期趋势尚未朝目标变化',
  'extreme-trend':'近期变化较快，暂不外推期限', 'nonsteady-trend':'近期波动较大，继续积累记录',
  'range-expired':'原有趋势已过期，请补充体重记录',
};
export function GoalCard({ progress: p, onEdit }: { progress: ProgressSummary; onEdit: () => void }) {
  return <section aria-label="健康目标进度" className="stat-card mt-5">
    <div className="flex items-center justify-between gap-3 text-xs text-[var(--wb-muted)]"><h2>我的目标</h2><button type="button" onClick={onEdit} className="min-h-10 px-2 text-xs underline underline-offset-4">{p.targetKg === undefined ? '设置我的目标' : '编辑目标'}</button></div>
    <div className="mt-1 flex items-end justify-between gap-3"><div><span className="stat-value">{p.currentKg === undefined ? '—' : format(p.currentKg * 2)}</span><span className="ml-1 text-sm text-[var(--wb-muted)]">斤</span></div>
      <div className="text-right"><div className="text-xs text-[var(--wb-muted)]">目标</div><div className="text-base font-medium tabular-nums">{p.targetKg === undefined ? '待设置' : `${format(p.targetKg * 2)} 斤`}</div></div></div>
    {p.currentDate && <p className="mt-2 text-xs text-[var(--wb-muted)]">最近记录 {p.currentDate}</p>}
    {p.progressPercent !== undefined && <><div role="progressbar" aria-label="体重目标进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(p.progressPercent)} className="mt-3 h-1.5 overflow-hidden rounded-full bg-[#ecede8]"><div className="h-full rounded-full bg-[#799182]" style={{width:`${p.progressPercent}%`}} /></div><div className="mt-2 flex flex-wrap justify-between gap-2 text-xs text-[var(--wb-muted)]"><span>起点 {format(p.startKg! * 2)} 斤 · 距目标 {format(p.remainingKg! * 2)} 斤</span><span>已完成 {Math.round(p.progressPercent)}%</span></div></>}
    <div className="mt-4 border-t border-[var(--wb-line)] pt-3 text-xs leading-5 text-[var(--wb-muted)]">
      {p.estimate.kind === 'heuristic-range' ? <><p>按近期趋势，估计还需 {Math.ceil(p.estimate.minDays / 7)}–{Math.ceil(p.estimate.maxDays / 7)} 周</p><p className="text-[var(--wb-muted)]">{p.estimate.earliestDate} 至 {p.estimate.latestDate} · 趋势外推，随记录更新</p></> : p.estimate.kind === 'achieved' ? '最近记录已达到目标，可以重新评估下一步' : <><p>暂不足以预测</p><p className="text-[var(--wb-muted)]">{reasons[p.estimate.reason]}</p></>}
    </div>
  </section>;
}
function gap(value: number | undefined, unit: string) {
  return value === undefined ? '暂不能计算' : value > 0 ? `距目标 ${format(value)} ${unit}` : value < 0 ? `超出目标 ${format(-value)} ${unit}` : '已达目标';
}
export function NutritionCard({ summary:s, date, calories, missingCalories, onEditGoal, workoutsAvailable=true }: { summary:NutritionSummary;date:string;calories:NonNullable<WorkoutLog['calories']>[];missingCalories:number;onEditGoal?:()=>void;workoutsAvailable?:boolean }) {
  const headline = s.recordCount === 0 ? '还没有饮食记录' : gap(s.deltas.kcal,'kcal');
  return <details open className="card mt-4 p-5 group" aria-label="营养摄入与目标差值">
    <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
      <div className="flex items-center justify-between gap-3"><h2 className="flex items-center gap-2 text-base font-semibold"><Utensils size={19}/>{date === localToday() ? '今日营养' : `${date.slice(5)} 营养`}</h2><ChevronDown size={18} className="text-neutral-400 transition group-open:rotate-180"/></div>
      <div className="mt-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1"><span><strong className="text-2xl font-semibold tabular-nums">{format(s.totals.kcal)}</strong><span className="ml-1 text-xs text-neutral-500">/ {s.targets.kcal === undefined ? '未设目标' : `${format(s.targets.kcal)} kcal`}</span></span><span className="text-xs text-neutral-600">{headline}</span></div>
      <p className="mt-2 text-xs leading-5 text-neutral-500">{s.recordCount > 0 && s.targets.protein !== undefined && s.missing.protein === 0 ? `蛋白质${gap(s.deltas.protein,'g')} · ` : ''}按已记录估算 · 点此展开或收起</p>
    </summary>
    <div className="mt-4 border-t border-neutral-100">
      {([['protein','蛋白质'],['carbs','碳水'],['fat','脂肪']] as const).map(([key,label]) => <div key={key} className="border-b border-neutral-100 py-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm"><span>{label}</span><span className="tabular-nums">{format(s.totals[key])}<span className="text-neutral-400"> / {s.targets[key] === undefined ? '未设目标' : format(s.targets[key]!)} g</span></span></div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-neutral-100"><div className="h-full rounded-full bg-[#799182]" style={{width:`${s.targets[key] ? Math.min(100,s.totals[key]/s.targets[key]!*100) : 0}%`}}/></div>
        <p className="mt-1.5 text-xs text-neutral-500">{s.missing[key] ? `部分记录未提供${label}（${s.missing[key]} 项），缺口暂不计算` : s.recordCount === 0 ? '尚无记录，不能代表全天摄入' : s.targets[key] === undefined ? <>{label}目标未设置，<a className="underline" href="/settings#body">设置目标</a></> : gap(s.deltas[key],'g')}</p>
      </div>)}
      <button type="button" onClick={onEditGoal} className="mt-2 min-h-11 text-xs text-neutral-600 underline">设置碳水与脂肪目标</button>
      <p className="mt-3 text-xs leading-5 text-neutral-500">目标差值依据已记录内容，不代表全天记录完整或身体缺乏。热量与蛋白目标沿用个人资料中的设置。</p>
      <div className="mt-3 rounded-xl bg-neutral-50 p-3"><div className="flex items-center gap-2 text-sm"><Dumbbell size={17}/><span>运动消耗</span><span className="ml-auto tabular-nums">{!workoutsAvailable ? '暂不可用' : calories.length ? `${format(calories.reduce((sum,c)=>sum+c.min,0))}–${format(calories.reduce((sum,c)=>sum+c.max,0))} kcal` : '暂未估算'}</span></div><p className="mt-1 text-xs leading-5 text-neutral-500">{workoutsAvailable && missingCalories > 0 && `有 ${missingCalories} 次训练未估算消耗。`}{!workoutsAvailable ? '训练记录读取失败，请重新读取。' : '单独估算，不直接抵扣饮食目标。'}</p></div>
    </div>
  </details>;
}
