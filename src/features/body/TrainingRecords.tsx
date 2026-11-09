import { assertRecordedDate } from './health-writer';
import { validateDraft } from '../../lib/health-model';
import { useEffect, useState } from 'react';
import { Dumbbell, Plus } from 'lucide-react';
import { createBrowserHealthStore } from '../../lib/health';
import type { WorkoutDraft, WorkoutLog } from '../../lib/health-model';
import { localToday } from '../../lib/date';
import { useHealthWriter } from './use-health-writer';

type ExerciseForm={name:string;sets:string;reps:string;weightKg:string};
const emptyExercise=():ExerciseForm=>({name:'',sets:'',reps:'',weightKg:''});
const intensityLabels={light:'轻松',moderate:'适中',vigorous:'较吃力'};
export default function TrainingRecords({records,onSaved,openRequest=0,recordsAvailable=true,onPendingChange,canStart=true}:{records:WorkoutLog[];openRequest?:number;recordsAvailable?:boolean;canStart?:boolean;onPendingChange?:(pending:boolean)=>void;onSaved:(row:WorkoutLog)=>void}) {
  const [open,setOpen]=useState(false),[title,setTitle]=useState(''),[date,setDate]=useState(localToday()),[duration,setDuration]=useState('');
  const [intensity,setIntensity]=useState<WorkoutDraft['intensity']>(),[feeling,setFeeling]=useState(''),[discomfort,setDiscomfort]=useState('');
  const [exercises,setExercises]=useState<ExerciseForm[]>([]),[message,setMessage]=useState('');
  useEffect(() => { if(openRequest > 0) setOpen(true); }, [openRequest]);
  const writer=useHealthWriter<{mutation_id:string;items:WorkoutDraft[]},WorkoutLog[]>(onPendingChange);
  const save=()=>writer.save(()=>{
    if(!canStart) throw new Error('请等待读取结束');
    assertRecordedDate(date);
    if(!title.trim())throw new Error('先说说实际练了什么');
    const draft:WorkoutDraft={id:crypto.randomUUID(),date,title:title.trim(),...(duration!==''?{durationMin:Number(duration)}:{}),...(intensity?{intensity}:{}),...(feeling.trim()?{feeling:feeling.trim()}:{}),...(discomfort.trim()?{discomfort:discomfort.trim()}:{}),...(exercises.length?{exercises:exercises.map(e=>({name:e.name.trim(),...(e.sets!==''?{sets:Number(e.sets)}:{}),...(e.reps!==''?{reps:Number(e.reps)}:{}),...(e.weightKg!==''?{weightKg:Number(e.weightKg)}:{})}))}:{})};
    validateDraft('workouts',draft);
    return {mutation_id:crypto.randomUUID(),items:[draft]};
  },request=>createBrowserHealthStore().addWorkouts(request),rows=>{rows.forEach(onSaved);setTitle('');setDuration('');setFeeling('');setDiscomfort('');setIntensity(undefined);setExercises([]);setOpen(false);setMessage('训练已保存并核对');});
  return <section id="training-records" aria-label="实际训练记录" className="card mt-4 p-5">
    <div className="flex items-center justify-between gap-2"><h2 className="flex items-center gap-2 text-base font-semibold"><Dumbbell size={19}/>训练记录</h2><button type="button" aria-expanded={open} aria-controls="training-record-form" onClick={()=>setOpen(!open)} disabled={writer.busy} className="btn-secondary min-h-11 px-3 text-xs"><Plus size={15}/>{open?'收起表单':'记录训练'}</button></div>
    {message&&<p role="status" className="mt-2 text-xs text-neutral-600">{message}</p>}
    {open&&<div id="training-record-form" className="mt-4 border-t border-neutral-100 pt-4">
      <p className="text-xs leading-5 text-neutral-500">只记实际完成的训练。感受如实填写，不必每项都填；也可以让已授权的 AI 帮你记录。</p>
      <fieldset disabled={writer.locked || !canStart} className="mt-3 space-y-3 disabled:opacity-60">
        <label className="block text-xs text-neutral-600">今天练了什么<textarea aria-label="今天练了什么" value={title} maxLength={200} rows={2} onChange={e=>setTitle(e.target.value)} className="input mt-1 w-full resize-y" placeholder="比如：练肩，之后步行回家"/></label>
        <div className="grid grid-cols-2 gap-3"><label className="text-xs text-neutral-600">日期<input aria-label="训练日期" type="date" value={date} max={localToday()} onChange={e=>setDate(e.target.value)} className="input mt-1 w-full"/></label><label className="text-xs text-neutral-600">时长（分钟，可选）<input aria-label="训练时长（分钟）" inputMode="decimal" value={duration} onChange={e=>setDuration(e.target.value)} className="input mt-1 w-full"/></label></div>
        <label className="block text-xs text-neutral-600">主观强度<select aria-label="训练强度" value={intensity??''} onChange={e=>setIntensity((e.target.value||undefined) as WorkoutDraft['intensity'])} className="input mt-1 w-full"><option value="">暂不填写</option><option value="light">轻松</option><option value="moderate">适中</option><option value="vigorous">较吃力</option></select></label>
        <label className="block text-xs text-neutral-600">练完感觉怎么样？<textarea aria-label="训练感受" value={feeling} maxLength={2000} rows={2} onChange={e=>setFeeling(e.target.value)} className="input mt-1 w-full" placeholder="比如：最后一组有点吃力，整体还可以"/></label>
        <label className="block text-xs text-neutral-600">有没有不适？（可选）<input aria-label="训练不适" value={discomfort} maxLength={2000} onChange={e=>setDiscomfort(e.target.value)} className="input mt-1 w-full" placeholder="没说的内容会留空"/></label>
        <details><summary className="cursor-pointer py-2 text-xs text-neutral-600">补充动作、组次和重量</summary><div className="space-y-3">{exercises.map((exercise,index)=><div key={index} className="rounded-xl bg-neutral-50 p-3"><div className="flex gap-2"><input aria-label={`动作${index+1}名称`} value={exercise.name} onChange={e=>setExercises(rows=>rows.map((r,i)=>i===index?{...r,name:e.target.value}:r))} placeholder="动作名称" className="input min-w-0 flex-1"/><button type="button" aria-label={`移除动作${index+1}`} onClick={()=>setExercises(rows=>rows.filter((_,i)=>i!==index))} className="btn-secondary px-3">移除</button></div><div className="mt-2 grid grid-cols-3 gap-2">{([['sets','组'],['reps','每组次数'],['weightKg','重量kg']] as const).map(([key,label])=><label key={key} className="text-xs text-neutral-500">{label}<input aria-label={`动作${index+1}${label}`} inputMode="decimal" value={exercise[key]} onChange={e=>setExercises(rows=>rows.map((r,i)=>i===index?{...r,[key]:e.target.value}:r))} className="input mt-1 w-full"/></label>)}</div></div>)}<button type="button" disabled={exercises.length>=30} onClick={()=>setExercises(rows=>[...rows,emptyExercise()])} className="btn-secondary min-h-11 w-full text-xs">添加一个动作</button></div></details>
      </fieldset>
      {writer.error&&<p role="alert" className="mt-3 text-xs leading-5 text-neutral-600">{writer.error}</p>}
      <div className="mt-3 flex gap-2"><button type="button" disabled={writer.busy || (!canStart && !writer.locked)} onClick={save} className="btn-primary min-h-11 flex-1 text-sm">{writer.busy?'保存中…':writer.locked?'重试核对训练':'保存训练'}</button>{writer.locked&&!writer.busy&&<button type="button" onClick={writer.discard} className="btn-secondary px-3 text-xs">放弃草稿</button>}</div>
    </div>}
    <div className="mt-3 divide-y divide-neutral-100">{!recordsAvailable?<p className="py-3 text-sm text-neutral-500">训练记录尚未读全，请重新读取后查看。</p>:records.length===0?<p className="py-3 text-sm text-neutral-500">这天还没有训练记录。未记录不代表没有运动。</p>:records.map(row=><details key={row.id} className="py-3"><summary className="cursor-pointer text-sm"><span className="font-medium">{row.title}</span><span className="ml-2 text-xs text-neutral-500">{row.durationMin===undefined?'时长未填':`${row.durationMin} 分钟`}{row.intensity?` · ${intensityLabels[row.intensity]}`:''}</span></summary><div className="mt-2 space-y-1 text-xs leading-5 text-neutral-600"><p>感受：{row.feeling||'未填写'}</p><p>不适：{row.discomfort||'未填写'}</p>{row.exercises?.map((e,i)=><p key={i}>{e.name} · {e.sets===undefined?'组数未填':`${e.sets} 组`} · {e.reps===undefined?'次数未填':`${e.reps} 次`}{e.weightKg!==undefined?` · ${e.weightKg} kg`:''}</p>)}{row.calories?<p>消耗估算 {row.calories.min}–{row.calories.max} kcal · {row.calories.source}</p>:<p>消耗暂未估算；时长或感受本身不能直接得到准确热量。</p>}</div></details>)}</div>
  </section>;
}
