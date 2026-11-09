import type { WeightRecord } from '../../types';
import type { WeekSummary } from '../../lib/health-summary';
export default function HealthReview({weights,week,today}:{weights:WeightRecord[];week:WeekSummary;today:string}) {
  const byDate=new Map<string,WeightRecord>();
  for(const row of weights.filter(w=>!w.deleted&&w.date<=today)) {const previous=byDate.get(row.date);if(!previous||previous.updatedAt<row.updatedAt)byDate.set(row.date,row);}
  const rows=[...byDate.values()].sort((a,b)=>a.date.localeCompare(b.date)).slice(-28);
  const since=Date.parse(today+'T00:00:00Z')-27*86400000;
  const recent=rows.filter(w=>Date.parse(w.date+'T00:00:00Z')>=since);
  const low=Math.min(...recent.map(w=>w.kg))-0.5,high=Math.max(...recent.map(w=>w.kg))+0.5;
  const first=Date.parse(recent[0]?.date+'T00:00:00Z'),last=Date.parse(recent[recent.length-1]?.date+'T00:00:00Z');
  const points=recent.map(w=>({x:24+((Date.parse(w.date+'T00:00:00Z')-first)/(last-first||1))*272,y:82-((w.kg-low)/(high-low||1))*60,row:w}));
  return <>
    <section className="card mt-4 p-5" aria-label="体重趋势"><h2 className="text-base font-semibold">体重趋势 · 近 4 周</h2>{recent.length<2?<p className="mt-3 text-sm leading-6 text-neutral-500">至少再记录几天体重，就能在这里看到变化。</p>:<><svg viewBox="0 0 320 112" role="img" aria-label={`近4周体重从${recent[0].kg*2}斤变化到${recent[recent.length-1].kg*2}斤`} className="mt-4 w-full text-neutral-800"><polyline points={points.map(p=>`${p.x},${p.y}`).join(' ')} fill="none" stroke="currentColor" strokeWidth={2}/>{points.map(p=><circle key={p.row.id} cx={p.x} cy={p.y} r={2.5} fill="currentColor"/>)}{[points[0],points[points.length-1]].map((p,i)=><g key={i}><text x={p.x} y={p.y-10} textAnchor="middle" fontSize={10} fill="currentColor">{Math.round(p.row.kg*20)/10}斤</text><text x={p.x} y={106} textAnchor="middle" fontSize={10} fill="currentColor">{p.row.date.slice(5)}</text></g>)}</svg><details className="mt-2"><summary className="cursor-pointer py-2 text-xs text-neutral-500">查看体重明细</summary><ul className="mt-2 space-y-2 text-xs text-neutral-600">{recent.slice().reverse().map(w=><li key={w.id} className="flex justify-between"><span>{w.date}</span><span>{Math.round(w.kg*20)/10} 斤（{w.kg} kg）</span></li>)}</ul></details></>}</section>
    <section className="card mt-4 p-5"><h2 className="text-base font-semibold">最近 7 天回顾</h2><p className="mt-2 text-sm leading-6 text-neutral-600">已记录 {week.foodDays} 天饮食、{week.workoutCount} 次训练。</p><details className="mt-2"><summary className="cursor-pointer py-2 text-xs text-neutral-500">展开记录覆盖详情</summary><p className="mt-2 text-xs leading-6 text-neutral-500">{week.startDate} 至 {week.endDate}<br/>{week.foodRecords} 项食物 · {week.workoutDays} 天有训练记录 · 已知训练时长 {week.durationMin} 分钟{week.missingDurationCount>0?`（另有 ${week.missingDurationCount} 次未填时长）`:''}<br/>这些数字只反映已记录内容，未记录不代表没有发生。可让 AI 查询同一时段，结合目标与感受一起回顾。</p></details></section>
  </>;
}
