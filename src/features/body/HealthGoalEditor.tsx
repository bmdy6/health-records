import { assertRecordedDate } from './health-writer';
import { validateDraft } from '../../lib/health-model';
import { useRef, useState } from 'react';
import type { HealthGoal, HealthGoalDraft } from '../../lib/health-model';
import { createBrowserHealthStore } from '../../lib/health';
import { localToday } from '../../lib/date';
import { useHealthWriter } from './use-health-writer';

interface GoalWrite { mutation_id:string; expected:HealthGoal|null; draft:HealthGoalDraft }
export default function HealthGoalEditor({goal,currentKg,onSaved,onClose,onPendingChange,canStart=true}:{onPendingChange?:(pending:boolean)=>void;canStart?:boolean;goal:HealthGoal|null;currentKg?:number;onSaved:(goal:HealthGoal)=>void;onClose:()=>void}) {
  const baseline = useRef(goal).current;
  const [start,setStart] = useState(goal ? String(goal.startKg*2) : currentKg ? String(currentKg*2) : '');
  const [target,setTarget] = useState(goal ? String(goal.targetKg*2) : '');
  const [date,setDate] = useState(goal?.date ?? localToday());
  const [carbs,setCarbs] = useState(goal?.carbsG === undefined ? '' : String(goal.carbsG));
  const [fat,setFat] = useState(goal?.fatG === undefined ? '' : String(goal.fatG));
  const writer = useHealthWriter<GoalWrite,HealthGoal>(onPendingChange);
  const save = () => writer.save(() => {
    if(!canStart) throw new Error('请等待读取结束');
    assertRecordedDate(date);
    const startKg=Number(start)/2,targetKg=Number(target)/2;
    if(!start.trim() || !target.trim() || !Number.isFinite(startKg) || !Number.isFinite(targetKg) || startKg<=0 || targetKg<=0) throw new Error('请填写有效的起点和目标体重');
    const draft:HealthGoalDraft={id:'primary',date,startKg,targetKg,...(carbs!==''?{carbsG:Number(carbs)}:{}),...(fat!==''?{fatG:Number(fat)}:{})};
    validateDraft('goals',draft);
    return {mutation_id:crypto.randomUUID(),expected:baseline,draft};
  }, async request => {
    const store=createBrowserHealthStore();
    if(request.expected) { const {id: _id, ...patch} = request.draft; return store.updateGoal({mutation_id:request.mutation_id,id:'primary',expected:request.expected,patch:{...patch,carbsG:request.draft.carbsG,fatG:request.draft.fatG}}); }
    return (await store.addGoals({mutation_id:request.mutation_id,items:[request.draft]}))[0];
  }, saved=>{onSaved(saved);onClose();});
  return <section className="card mt-3 p-5" aria-label="编辑健康目标">
    <h2 className="text-base font-semibold">我的健康目标</h2><p className="mt-1 text-xs leading-5 text-neutral-500">体重用斤填写。热量和蛋白目标仍在<a href="/settings#body" className="underline">个人资料</a>中设置。</p>
    <fieldset disabled={writer.locked || !canStart} className="mt-3 grid grid-cols-2 gap-3 disabled:opacity-60">
      <label className="text-xs text-neutral-600">起点体重（斤）<input aria-label="起点体重（斤）" inputMode="decimal" value={start} onChange={e=>setStart(e.target.value)} className="input mt-1 w-full"/></label>
      <label className="text-xs text-neutral-600">目标体重（斤）<input aria-label="目标体重（斤）" inputMode="decimal" value={target} onChange={e=>setTarget(e.target.value)} className="input mt-1 w-full"/></label>
      <label className="col-span-2 text-xs text-neutral-600">目标开始日期<input aria-label="目标开始日期" type="date" value={date} onChange={e=>setDate(e.target.value)} max={localToday()} className="input mt-1 w-full"/></label>
      <label className="text-xs text-neutral-600">碳水目标（g，可选）<input aria-label="碳水目标（g，可选）" inputMode="decimal" value={carbs} onChange={e=>setCarbs(e.target.value)} placeholder="不填则不算缺口" className="input mt-1 w-full"/></label>
      <label className="text-xs text-neutral-600">脂肪目标（g，可选）<input aria-label="脂肪目标（g，可选）" inputMode="decimal" value={fat} onChange={e=>setFat(e.target.value)} placeholder="不填则不算缺口" className="input mt-1 w-full"/></label>
    </fieldset>
    {writer.error && <p role="alert" className="mt-3 text-xs leading-5 text-neutral-600">{writer.error}</p>}
    <div className="mt-4 flex flex-wrap gap-2"><button type="button" onClick={save} disabled={writer.busy || (!canStart && !writer.locked)} className="btn-primary min-h-11 flex-1 px-3 text-sm">{writer.busy?'保存中…':writer.locked?'重试核对目标':'保存目标'}</button><button type="button" disabled={writer.busy} onClick={()=>{writer.discard();onClose();}} className="btn-secondary min-h-11 px-3 text-sm">{writer.locked?'放弃草稿':'取消'}</button></div>
  </section>;
}
