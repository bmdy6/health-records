import { assertRecordedDate } from './health-writer';
import { validateDraft } from '../../lib/health-model';
import { useState } from 'react';
import { createBrowserHealthStore } from '../../lib/health';
import type { HealthWeight, WeightDraft } from '../../lib/health-model';
import { localToday } from '../../lib/date';
import { useHealthWriter } from './use-health-writer';
interface WeightWrite {mutation_id:string;expected:HealthWeight|null;draft:WeightDraft}
export default function WeightRecorder({weights,onSaved,onPendingChange,available=true}:{onPendingChange?:(pending:boolean)=>void;available?:boolean;weights:HealthWeight[];onSaved:(row:HealthWeight)=>void}) {
  const [value,setValue]=useState('');const [date,setDate]=useState(localToday());const [message,setMessage]=useState('');
  const writer=useHealthWriter<WeightWrite,HealthWeight>(onPendingChange);
  const sameDate=weights.filter(w=>w.date===date&&!w.deleted).sort((a,b)=>b.updatedAt-a.updatedAt)[0];
  const save=()=>writer.save(()=>{
    if(!available) throw new Error('请先成功读取体重记录');
    assertRecordedDate(date);
    const kg=Number(value)/2;if(!value.trim()||!Number.isFinite(kg)||kg<=0)throw new Error('请填写有效体重');
    const draft={id:sameDate?.id??crypto.randomUUID(),date,kg}; validateDraft('weights',draft);
    return {mutation_id:crypto.randomUUID(),expected:sameDate??null,draft};
  },async request=>{
    const store=createBrowserHealthStore();return request.expected ? store.updateWeight({mutation_id:request.mutation_id,id:request.draft.id,expected:request.expected,patch:{kg:request.draft.kg,date:request.draft.date}}) : (await store.addWeights({mutation_id:request.mutation_id,items:[request.draft]}))[0];
  },row=>{onSaved(row);setValue('');setMessage('体重已保存并核对');});
  return <details className="card mt-3 p-4"><summary className="cursor-pointer text-sm font-medium">记录体重</summary><div className="mt-3 grid grid-cols-2 gap-3"><label className="text-xs text-neutral-600">日期<input aria-label="体重记录日期" disabled={writer.locked || !available} type="date" value={date} max={localToday()} onChange={e=>{setDate(e.target.value);setMessage('');}} className="input mt-1 w-full"/></label><label className="text-xs text-neutral-600">体重（斤）<input aria-label="体重（斤）" disabled={writer.locked || !available} inputMode="decimal" value={value} onChange={e=>{setValue(e.target.value);setMessage('');}} className="input mt-1 w-full" placeholder="例如 148"/></label></div>
    {!available&&<p className="mt-2 text-xs text-neutral-500">体重尚未读全，成功读取后再记，避免同一天重复新增。</p>}
    {sameDate&&<p className="mt-2 text-xs text-neutral-500">该日已有 {sameDate.kg*2} 斤，保存将更新这一条记录。</p>}
    {writer.error&&<p role="alert" className="mt-2 text-xs leading-5 text-neutral-600">{writer.error}</p>}{message&&<p role="status" className="mt-2 text-xs text-neutral-600">{message}</p>}
    <div className="mt-3 flex gap-2"><button type="button" disabled={writer.busy||(!writer.locked&&(!value||!available))} onClick={save} className="btn-primary min-h-11 flex-1 text-sm">{writer.busy?'保存中…':writer.locked?'重试核对体重':'保存体重'}</button>{writer.locked&&!writer.busy&&<button type="button" onClick={writer.discard} className="btn-secondary px-3 text-xs">放弃草稿</button>}</div>
  </details>;
}
