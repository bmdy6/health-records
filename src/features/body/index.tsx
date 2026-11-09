import { useEffect, useMemo, useRef, useState } from 'react';
import { Camera, Plus, ChevronDown, ChevronUp } from 'lucide-react';
import EmptyState from '../../components/EmptyState';
import SyncStatus from '../../components/SyncStatus';
import { useToast } from '../../components/Toast';
import { loadFoodLogs, saveFoodLogs, inheritFoodBaseline, foodBaselinePath } from '../../lib/body';
import { findFood, findFoodExact, searchFoods, UNITS, type Unit } from '../../lib/nutrition';
import { compressImage, recognizeFood, savePendingRec, getPendingRec, clearPendingRec, type RecognizeResult } from '../../lib/vision';
import { draftToFoodLog, mergeFoodLogs, type OralFoodDraft } from '../../lib/food-narration';
import OralFoodRecorder from './OralFoodRecorder';
import { localToday as today } from '../../lib/date';
import type { BodyProfile, FoodLog } from '../../types';
import { getConfig, getConfigRevision, subscribeConfigChanges } from '../../lib/webdav';
import { createRecognizedFoodSaver, recognizedFoodDraftKey } from './recognized-food-save';
import { createManualFoodSaver } from './manual-food-save';

import { createBrowserHealthStore } from '../../lib/health';
import type { HealthGoal, HealthWeight, WorkoutLog } from '../../lib/health-model';
import { summarizeNutrition, summarizeProgress, summarizeWeek } from '../../lib/health-summary';
import { GoalCard, NutritionCard } from './HealthCards';
import HealthGoalEditor from './HealthGoalEditor';
import TrainingRecords from './TrainingRecords';
import WeightRecorder from './WeightRecorder';
import HealthReview from './HealthReview';

const MEALS = ['早餐', '午餐', '晚餐', '加餐'] as const;

export default function BodyPage() {
  const [profile, setProfile] = useState<BodyProfile | null>(null);
  const [weights, setWeights] = useState<HealthWeight[]>([]);
  const [foods, setFoods] = useState<FoodLog[]>([]);
  const [sync, setSync] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  // 食物表单
  const [foodName, setFoodName] = useState('');
  const [amount, setAmount] = useState('100');
  const [unit, setUnit] = useState<Unit>('g');
  const [aiEstimating, setAiEstimating] = useState(false);
  const [manualSaving, setManualSaving] = useState(false);
  const [manualSaveError, setManualSaveError] = useState('');
  const manualSaverRef = useRef(createManualFoodSaver());
  const manualDraftGenerationRef = useRef(0);
  const foodWriteRef = useRef<symbol | null>(null);
  const [foodWriting, setFoodWriting] = useState(false);
  const [meal, setMeal] = useState<(typeof MEALS)[number]>('早餐');
  const [workouts, setWorkouts] = useState<WorkoutLog[]>([]);
  const [goal, setGoal] = useState<HealthGoal | null>(null);
  const [goalOpen, setGoalOpen] = useState(false);
  const [trainingPending, setTrainingPending] = useState(false);
  const [weightPending, setWeightPending] = useState(false);
  const [goalPending, setGoalPending] = useState(false);
  const [trainingRequest, setTrainingRequest] = useState(0);
  const [loadErrors, setLoadErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [readySources, setReadySources] = useState({profile:false,weights:false,foods:false,workouts:false,goals:false});
  const [reload, setReload] = useState(0);
  // 更多方式折叠（手输/拍照）
  const [moreOpen, setMoreOpen] = useState(false);
  const [entryOpen, setEntryOpen] = useState(false);
  // 拍照识别
  const [recognizing, setRecognizing] = useState(false);
  const [recResult, setRecResult] = useState<RecognizeResult | null>(null);
  const [recGrams, setRecGrams] = useState('');
  const [recError, setRecError] = useState('');
  const [recSaving, setRecSaving] = useState(false);
  const [recSaveError, setRecSaveError] = useState('');
  const [bindingRevision, setBindingRevision] = useState(getConfigRevision);
  const mountedRef = useRef(true);
  const initialBindingRevisionRef = useRef(bindingRevision);
  const recSaverRef = useRef(createRecognizedFoodSaver());
  const currentRecDraftRef = useRef('');
  const recDraftGenerationRef = useRef(0);
  const recSaveRequestRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toastEl, showToast } = useToast();
  // 查看日期：列表与顶部摄入跟随；新增日期：手输/拍照补记用（默认今天）
  const [viewDate, setViewDate] = useState(today());
  const [logDate, setLogDate] = useState(today());

  const manualDraftLocked = manualSaving || manualSaverRef.current.hasUnconfirmedWrite();
  const recDraftLocked = recognizing || recSaving || Boolean(recResult && recSaveError);
  currentRecDraftRef.current = recResult
    ? recognizedFoodDraftKey({ result: recResult, grams: recGrams, date: logDate, meal, generation: recDraftGenerationRef.current }) : '';

  useEffect(() => {
    mountedRef.current = true;
    const unsubscribe = subscribeConfigChanges(() => {
      setBindingRevision(getConfigRevision());
      recSaverRef.current = createRecognizedFoodSaver();
      recSaveRequestRef.current += 1;
      manualSaverRef.current = createManualFoodSaver();
      manualDraftGenerationRef.current += 1;
      foodWriteRef.current = null;
      setFoodWriting(false); setManualSaving(false); setAiEstimating(false);
      setManualSaveError(''); setFoodName(''); setAmount('100'); setUnit('g'); setSync('idle');
      setRecognizing(false);
      recDraftGenerationRef.current += 1;
      setRecResult(null);
      setRecSaveError('');
      setRecSaving(false);
      setFoods([]); setWeights([]); setProfile(null); setWorkouts([]); setGoal(null); setGoalOpen(false); setTrainingPending(false); setWeightPending(false); setGoalPending(false); setLoadErrors([]); setLoading(true); setReadySources({profile:false,weights:false,foods:false,workouts:false,goals:false});
    });
    return () => { mountedRef.current = false; unsubscribe(); };
  }, []);

  useEffect(() => {
    let current = true;
    setLoading(true); setLoadErrors([]);
    const cfg = getConfig();
    if (!cfg) { setLoading(false); setLoadErrors(['请先在设置中绑定个人工作台']); return; }
    const config = { ...cfg };
    const access = { config, revision: bindingRevision, isCurrent: () => current && getConfigRevision() === bindingRevision };
    (async () => {
      try {
        const store = createBrowserHealthStore(access);
        const results = await Promise.allSettled([store.readProfile(), store.readWeights(), loadFoodLogs(access), store.readWorkouts(), store.readGoals()] as const);
        if (!access.isCurrent()) return;
        const [p, ws, fs, ts, gs] = results;
        const paths = [ws.status === 'fulfilled' ? ws.value.path : undefined, fs.status === 'fulfilled' ? foodBaselinePath(fs.value) : undefined, ts.status === 'fulfilled' ? ts.value.path : undefined, gs.status === 'fulfilled' ? gs.value.path : undefined].filter((path): path is string => Boolean(path));
        if(new Set(paths.map(path => path.slice(0,path.lastIndexOf('/')))).size > 1) throw new Error('健康数据位置已变化，已停止组合展示，请重新读取');
        if(p.status === 'fulfilled') setProfile(p.value);
        if(ws.status === 'fulfilled') setWeights(ws.value.records.filter(r => !r.deleted));
        if(fs.status === 'fulfilled') setFoods(fs.value);
        if(ts.status === 'fulfilled') setWorkouts(ts.value.records.filter(r => !r.deleted));
        if(gs.status === 'fulfilled') setGoal(gs.value.records.find(r => r.id === 'primary' && !r.deleted) ?? null);
        setReadySources({profile:p.status === 'fulfilled',weights:ws.status === 'fulfilled',foods:fs.status === 'fulfilled',workouts:ts.status === 'fulfilled',goals:gs.status === 'fulfilled'});
        const labels = ['个人资料', '体重', '饮食', '训练', '目标'];
        setLoadErrors(results.flatMap((result, i) => result.status === 'rejected' ? [`${labels[i]}读取失败，请重试；当前摘要不完整`] : []));
        const pending = bindingRevision === initialBindingRevisionRef.current ? getPendingRec() : null;
        if (pending) { setRecResult(pending); setRecGrams(String(pending.weight_g)); }
      } catch (cause) {
        if (access.isCurrent()) { setLoadErrors([cause instanceof Error ? cause.message : '健康数据读取失败']); setReadySources({profile:false,weights:false,foods:false,workouts:false,goals:false}); }
      } finally { if (access.isCurrent()) setLoading(false); }
    })();
    return () => { current = false; };
  }, [bindingRevision, reload]);

  const viewFoods = useMemo(() => foods.filter(f => !f.deleted && f.date === viewDate), [foods, viewDate]);
  const viewWorkouts = useMemo(() => workouts.filter(r => !r.deleted && r.date === viewDate), [workouts, viewDate]);
  const nutrition = useMemo(() => summarizeNutrition(viewFoods, profile, goal, viewDate < today() ? viewDate : today()), [viewFoods, profile, goal, viewDate]);
  const progress = useMemo(() => summarizeProgress(weights, goal, today()), [weights, goal]);
  const week = useMemo(() => summarizeWeek(foods, workouts, today()), [foods, workouts]);
  const matches = useMemo(() => searchFoods(foodName), [foodName]);
  // A synchronous lock also covers the adjacent legacy food writers while manual
  // confirmation is in flight. It is not a queue and does not change their recovery contract.
  const withFoodWrite = async (work: () => Promise<void>, manual = false) => {
    if (foodWriteRef.current || (!manual && manualSaverRef.current.hasUnconfirmedWrite())) {
      showToast({ text: '请先等待当前保存，或重试核对手输草稿' });
      return false;
    }
    const token = Symbol();
    foodWriteRef.current = token;
    setFoodWriting(true);
    try { await work(); return true; }
    finally {
      if (foodWriteRef.current === token) {
        foodWriteRef.current = null;
        if (mountedRef.current) setFoodWriting(false);
      }
    }
  };

  const addFood = async (name: string) => {
    const n = name.trim();
    if (!n || manualSaverRef.current.isSaving()) return;
    const config = getConfig();
    if (!config) { setManualSaveError('请先绑定账号，手输草稿仍保留在本页'); return; }
    const revision = getConfigRevision();
    const generation = manualDraftGenerationRef.current;
    const saver = manualSaverRef.current;
    const draft = { name: n, amount, unit, date: logDate, meal, generation };
    const isCurrent = () => mountedRef.current && getConfigRevision() === revision;
    const isDraftCurrent = () => manualDraftGenerationRef.current === generation;
    await withFoodWrite(async () => {
      setManualSaving(true); setManualSaveError('');
      try {
        const result = await saver.save(draft, { config: { ...config }, revision, isCurrent }, isDraftCurrent, setAiEstimating);
        if (result.kind !== 'saved' || !isCurrent() || !isDraftCurrent()) return;
        manualDraftGenerationRef.current += 1;
        setFoods((current) => inheritFoodBaseline(current, mergeFoodLogs(current, [result.record])));
        setViewDate(draft.date);
        setFoodName(''); setAmount('100'); setUnit('g');
        showToast({ text: `已添加「${result.record.food}」` });
      } catch (error) {
        if (isCurrent() && isDraftCurrent()) {
          setManualSaveError(saver.hasUnconfirmedWrite()
            ? '暂未确认保存，草稿已保留。请按原草稿重试核对；离开本页不会撤销可能已保存的记录。'
            : `尚未保存，草稿已保留。${error instanceof Error ? error.message : '请重试'}`);
        }
      } finally {
        if (isCurrent() && manualSaverRef.current === saver) { setManualSaving(false); setAiEstimating(false); }
      }
    }, true);
  };

  const delFood = async (f: FoodLog) => withFoodWrite(async () => {
    const before = foods;
    const next = inheritFoodBaseline(foods, foods.filter((x) => x.id !== f.id));
    try {
      await saveFoodLogs(next, undefined, before);
      setFoods(next);
      showToast({ text: `已删除「${f.food}」`, undo: () => { void withFoodWrite(async () => {
        try { await saveFoodLogs(before, undefined, next); setFoods(before); }
        catch (error) { showToast({ text: error instanceof Error ? error.message : '恢复失败，请刷新核对' }); }
      }); } });
    } catch (error) {
      showToast({ text: error instanceof Error ? error.message : '删除失败，请刷新核对' });
    }
  });

  const handlePhoto = async (file: File | null) => {
    if (!file || recDraftLocked) return;
    const revision = getConfigRevision();
    const generation = ++recDraftGenerationRef.current;
    const isCurrent = () => mountedRef.current && getConfigRevision() === revision
      && recDraftGenerationRef.current === generation;
    recSaverRef.current = createRecognizedFoodSaver();
    setRecognizing(true);
    setRecError('');
    setRecSaveError('');
    setRecResult(null);
    try {
      const b64 = await compressImage(file);
      if (!isCurrent()) return;
      const result = await recognizeFood(b64);
      if (!isCurrent()) return;
      if (!result.name) {
        setRecError('没识别到食物，请重拍或手动输入');
      } else {
        setRecResult(result);
        setRecGrams(String(result.weight_g));
        savePendingRec(result);
      }
    } catch (e) {
      if (isCurrent()) setRecError(e instanceof Error ? e.message : '识别失败');
    } finally {
      if (isCurrent()) setRecognizing(false);
    }
  };

  const handleNarrationConfirm = async (drafts: OralFoodDraft[], date: string) => {
    const accepted = await withFoodWrite(async () => {
      const now = Date.now();
      // date 由口述确认框传入：默认口述开始那天（跨午夜仍记那天），用户可改为其他日期
      const additions = drafts.map((d) => draftToFoodLog(d, date, now));
      const next = inheritFoodBaseline(foods, mergeFoodLogs(foods, additions));
      setFoods(next);
      setSync('saving');
      try {
        await saveFoodLogs(next, undefined, foods);
        setSync('saved');
        setViewDate(date); // 口述确认后跳到记录日期，避免“记了但看不到”
        showToast({ text: `已添加 ${additions.length} 条食物记录` });
      } catch {
        setSync('error');
        showToast({ text: '保存失败，请重试' });
        throw new Error('save failed'); // 让 recorder 保留草稿
      }
    });
    if (!accepted) throw new Error('请先完成当前保存'); // recorder must retain its own draft
  };

  const confirmRecResult = async () => {
    if (!recResult || recSaverRef.current.isSaving()) return;
    const config = getConfig();
    if (!config) { setRecSaveError('请先绑定账号，识别草稿仍保留在本页'); return; }
    const revision = getConfigRevision();
    const request = ++recSaveRequestRef.current;
    const draft = { result: recResult, grams: recGrams, date: logDate, meal, generation: recDraftGenerationRef.current };
    const key = recognizedFoodDraftKey(draft);
    const isCurrent = () => mountedRef.current && getConfigRevision() === revision;
    const isDraftCurrent = () => currentRecDraftRef.current === key && recDraftGenerationRef.current === draft.generation;
    await withFoodWrite(async () => {
      setRecSaving(true);
      setRecSaveError('');
      try {
        const result = await recSaverRef.current.save(draft, { config: { ...config }, revision, isCurrent }, isDraftCurrent);
        if (result.kind !== 'saved' || !isCurrent() || !isDraftCurrent()) return;
        recDraftGenerationRef.current += 1;
        // Do not replace unrelated in-memory edits with the freshly read remote collection.
        setFoods((current) => inheritFoodBaseline(current, mergeFoodLogs(current, [result.record])));
        setViewDate(draft.date);
        setRecResult(null);
        clearPendingRec();
        showToast({ text: `已添加「${draft.result.name}」` });
      } catch {
        if (isCurrent() && isDraftCurrent()) {
          setRecSaveError('暂未确认保存，草稿已保留。请先按原草稿重试核对，再修改或新增；关闭草稿不会撤销可能已保存的记录。');
        }
      } finally {
        if (isCurrent() && recSaveRequestRef.current === request) setRecSaving(false);
      }
    });
  };

  const showEntry = entryOpen || !!recResult || !!recError || !!manualSaveError;
  const mealGroups = [...new Set(viewFoods.map((f) => f.meal ?? '其他'))].map((name) => ({ name, items: viewFoods.filter((f) => (f.meal ?? '其他') === name) }));

  return (
    <div className="p-5 pt-6 md:p-10 max-w-3xl mx-auto">
      {toastEl}
      <div className="flex items-center justify-between pr-10">
        <div>
          <h1 className="page-title">健康</h1>
        </div>
        <SyncStatus state={sync} onRetry={() => { void withFoodWrite(async () => { setSync('saving'); await saveFoodLogs(foods).then(() => setSync('saved')).catch(() => setSync('error')); }); }} />
      </div>

      {loading && <p role="status" className="mt-4 text-sm text-neutral-500">正在读取健康记录…</p>}
      {loadErrors.length > 0 && <div role="alert" className="card mt-4 p-4 text-sm leading-6 text-neutral-600">{loadErrors.map(error => <p key={error}>{error}</p>)}<button type="button" disabled={trainingPending || weightPending || goalPending || foodWriting || manualDraftLocked} onClick={() => { setLoading(true); setReload(n => n + 1); }} className="btn-secondary mt-2 min-h-11 px-3 text-xs">重新读取健康记录</button>{(trainingPending || weightPending || goalPending) && <p className="mt-1 text-xs">请先核对保存结果或放弃当前草稿，再重新读取。</p>}</div>}
      {!loading && readySources.weights && readySources.goals && <GoalCard progress={progress} onEdit={() => { if(!goalPending) setGoalOpen(open => !open); }} />}
      <div id="health-goal-editor">{goalOpen && <HealthGoalEditor canStart={!loading} onPendingChange={setGoalPending} key={`goal-${bindingRevision}`} goal={goal} currentKg={progress.currentKg} onSaved={setGoal} onClose={() => setGoalOpen(false)} />}</div>

      <>
        <div className="mt-4 flex items-center justify-between gap-3 px-1"><label htmlFor="health-view-date" className="text-xs text-[var(--wb-muted)]">查看日期</label><input id="health-view-date" type="date" max={today()} value={viewDate} onChange={e => { if(e.target.value) setViewDate(e.target.value); }} className="input h-8 w-auto border-transparent bg-transparent px-1 text-right text-xs text-[var(--wb-muted)]"/></div>
        {readySources.foods && readySources.profile && readySources.goals && <NutritionCard onEditGoal={() => {if(!loading && readySources.goals) setGoalOpen(true)}} workoutsAvailable={readySources.workouts} summary={nutrition} date={viewDate} calories={viewWorkouts.flatMap(r => r.calories ? [r.calories] : [])} missingCalories={viewWorkouts.filter(r => !r.calories).length} />}
        {!readySources.workouts && <p className="mt-2 text-xs text-neutral-500">训练尚未读全，运动消耗不可用。</p>}
        <TrainingRecords canStart={!loading} onPendingChange={setTrainingPending} recordsAvailable={readySources.workouts} openRequest={trainingRequest} key={`training-${bindingRevision}`} records={viewWorkouts} onSaved={row => { setWorkouts(rows => [...rows.filter(r => r.id !== row.id), row]); setViewDate(row.date); }} />
      </>

      {/* 食物记录列表：可按日期查看（默认今天） */}
      {readySources.foods && <div className="list-card mt-3">
        <div className="flex items-center justify-between px-4 py-3">
          <span className="text-sm font-medium">{viewDate === today() ? '今天吃了' : `${viewDate.slice(5)} 吃了`}</span>
        </div>
        {viewFoods.length === 0 && (
          <EmptyState
            icon={<Plus size={40} strokeWidth={1} />}
            title={viewDate === today() ? '今天还没记录食物' : `${viewDate} 没有记录`}
            hint="让 AI 记一句，或在页面底部手动记录"
          />
        )}
        {mealGroups.map((group) => (
          <div key={group.name}>
            <div className="flex items-baseline justify-between bg-neutral-50/60 px-4 py-1.5 text-xs text-[var(--wb-muted)]">
              <span>{group.name}</span>
              <span className="tabular-nums">{group.items.reduce((sum, f) => sum + f.kcal, 0)} kcal</span>
            </div>
            {group.items.map((f) => (
              <div key={f.id} className="list-row">
                <div className="min-w-0 flex-1">
                  <div className="text-sm">{f.food}</div>
                  <div className="mt-0.5 text-xs text-neutral-400 tabular-nums">蛋白 {f.protein ?? '—'}g · 碳水 {f.carbs ?? '—'}g · 脂肪 {f.fat ?? '—'}g</div>
                </div>
                <span className="text-sm tabular-nums">{f.kcal}</span>
                <button onClick={() => delFood(f)} className="btn-sm text-neutral-300 hover:text-neutral-900" aria-label="删除">✕</button>
              </div>
            ))}
          </div>
        ))}
      </div>}

      <><WeightRecorder available={readySources.weights && !loading} onPendingChange={setWeightPending} key={`weight-${bindingRevision}`} weights={weights} onSaved={row => setWeights(rows => [...rows.filter(r => r.id !== row.id), row])} />{readySources.weights && readySources.foods && readySources.workouts && <HealthReview weights={weights} week={week} today={today()} />}</>

      {/* 录入放在页面最后：页面先展示，AI 是主入口，这里是补充 */}
      <div className="card mt-3 p-4">
        <button type="button" onClick={() => setEntryOpen(!entryOpen)} className="flex min-h-9 w-full items-center justify-between text-sm text-[var(--wb-muted)]" aria-expanded={showEntry}>
          手动记录
          {showEntry ? <ChevronUp size={15} strokeWidth={1.5} /> : <ChevronDown size={15} strokeWidth={1.5} />}
        </button>
        {/* 只隐藏不卸载：口述识别和待确认草稿要继续保留 */}
        <div hidden={!showEntry} className="mt-3">
        <OralFoodRecorder onConfirm={handleNarrationConfirm} />
        <p className="mt-2 text-center text-xs text-neutral-500">口述饮食，或让已授权的 AI 帮你记健康。</p>
        <div className="mt-2 grid grid-cols-2 gap-2"><button type="button" id="training-add-action" onClick={() => { setTrainingRequest(n => n + 1); requestAnimationFrame(() => document.getElementById('training-records')?.scrollIntoView({behavior:'smooth',block:'start'})); }} className="btn-secondary min-h-11 text-sm">记录训练</button><button onClick={() => setMoreOpen(!moreOpen)} className="btn-secondary min-h-11 text-sm">
          {moreOpen ? <ChevronUp size={15} strokeWidth={1.5} /> : <ChevronDown size={15} strokeWidth={1.5} />}
          {moreOpen ? '收起其他方式' : '其他饮食方式'}
        </button></div>
        {moreOpen && (
          <>
            <div className="mt-2 flex items-center gap-2">
              <span className="text-xs text-neutral-500">记录日期</span>
              <input
                type="date"
                value={logDate}
                disabled={recDraftLocked || manualDraftLocked}
                onChange={(e) => { if (e.target.value !== logDate && !manualSaverRef.current.isSaving() && !manualSaverRef.current.hasUnconfirmedWrite()) { manualDraftGenerationRef.current += 1; setManualSaveError(''); recDraftGenerationRef.current += 1; setLogDate(e.target.value); } }}
                className="input h-9 w-36 text-sm"
              />
            </div>
            <div className="relative mt-2">
              <div className="flex gap-2">
                <input
                  disabled={manualDraftLocked} value={foodName} onChange={(e) => { if (e.target.value !== foodName && !manualSaverRef.current.isSaving() && !manualSaverRef.current.hasUnconfirmedWrite()) { manualDraftGenerationRef.current += 1; setManualSaveError(''); setFoodName(e.target.value); } }}
                  placeholder="输入食物（如 苹果 / 鸡胸肉）" enterKeyHint="search"
                  className="input flex-1 text-sm"
                />
                <input
                  type="text" inputMode="decimal"
                  disabled={manualDraftLocked} value={amount} onChange={(e) => { const value = e.target.value.replace(/[^\d.]/g, ''); if (value !== amount && !manualSaverRef.current.isSaving() && !manualSaverRef.current.hasUnconfirmedWrite()) { manualDraftGenerationRef.current += 1; setManualSaveError(''); setAmount(value); } }}
                  placeholder="数量" enterKeyHint="done" className="input w-14 text-center text-sm"
                />
            <select disabled={manualDraftLocked} value={unit} onChange={(e) => { if (e.target.value !== unit && !manualSaverRef.current.isSaving() && !manualSaverRef.current.hasUnconfirmedWrite()) { manualDraftGenerationRef.current += 1; setManualSaveError(''); setUnit(e.target.value as Unit); } }} className="input h-11 w-14 rounded-lg border border-neutral-200 bg-white px-1 text-center text-sm">
              {UNITS.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
            </select>
            <button
              onClick={() => {
                const n = foodName.trim();
                if (!n) return;
                if (findFoodExact(n)) {
                  // 精确命中 → 直接添加
                  addFood(n);
                } else if (searchFoods(n).length > 0) {
                  // 有模糊候选 → 必须用户选，不自动匹配
                  showToast({ text: '请从下方列表选择具体食物' });
                } else {
                  // 库外 → AI 估算
                  addFood(n);
                }
              }}
              disabled={foodWriting || !foodName.trim()}
              className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-neutral-900 text-white transition active:scale-[0.95] disabled:opacity-40"
              aria-label="添加"
            >
              <Plus size={20} strokeWidth={2} />
            </button>
          </div>
          {foodName.trim() && !findFood(foodName.trim()) && !aiEstimating && (
            <div className="mt-1 text-[11px] text-neutral-400">库外食物，点 ➕ 用 AI 估算（首次约 20 秒，请留在本页等待确认）</div>
          )}
          {manualSaving && !aiEstimating && <div className="mt-1 text-[11px] text-neutral-400">保存中…</div>}
          {aiEstimating && <div className="mt-1 text-[11px] text-neutral-400">AI 估算中…（首次约 20 秒）</div>}
          {matches.length > 0 && !manualDraftLocked && (
            <div className="absolute inset-x-0 top-full z-10 mt-1 overflow-hidden rounded-xl border border-neutral-100 bg-white shadow-lg">
              {matches.map((f) => (
                <button key={f.name} disabled={foodWriting} onClick={() => { if (foodWriteRef.current || manualSaverRef.current.hasUnconfirmedWrite()) return; if (f.name !== foodName) manualDraftGenerationRef.current += 1; setFoodName(f.name); addFood(f.name); }} className="flex w-full items-center justify-between px-4 py-2.5 text-sm active:bg-neutral-50">
                  <span>{f.name}</span>
                  <span className="text-xs text-neutral-400">{f.kcal} 千卡/100g</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="mt-2.5 flex gap-1.5">
          {MEALS.map((m) => (
            <button key={m} disabled={recDraftLocked || manualDraftLocked} onClick={() => { if (m !== meal && !manualSaverRef.current.isSaving() && !manualSaverRef.current.hasUnconfirmedWrite()) { manualDraftGenerationRef.current += 1; setManualSaveError(''); recDraftGenerationRef.current += 1; setMeal(m); } }} className={`rounded-full px-3 py-1 text-xs transition ${meal === m ? 'bg-neutral-900 text-white' : 'border border-neutral-200 text-neutral-600'}`}>
              {m}
            </button>
          ))}
        </div>
        <input
          ref={fileInputRef} type="file" accept="image/*" capture="environment" className="hidden"
          onChange={(e) => { handlePhoto(e.target.files?.[0] ?? null); e.target.value = ''; }}
        />
        <button onClick={() => fileInputRef.current?.click()} disabled={recognizing || recDraftLocked} className="btn-secondary mt-2.5 w-full h-9 text-sm">
          <Camera size={15} strokeWidth={1.5} />
          {recognizing ? '识别中…（约 10-20 秒）' : '拍照识别食物'}
        </button>
          </>
        )}
        {manualSaveError && (
          <div role="alert" className="mt-2 text-xs text-neutral-600">
            <p>{manualSaveError}</p>
            <button onClick={() => addFood(foodName)} disabled={foodWriting || !foodName.trim()} className="mt-1 underline underline-offset-2 disabled:opacity-40">重试手输保存</button>
          </div>
        )}
        {recError && (
          <div className="mt-2 flex items-center justify-between text-xs text-neutral-600">
            <span>{recError}</span>
            <button onClick={() => fileInputRef.current?.click()} className="underline underline-offset-2">重拍</button>
          </div>
        )}
        {recResult && (
          <div className="mt-3 rounded-xl bg-neutral-50 p-4">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">{recResult.name}</span>
              <button onClick={() => { recDraftGenerationRef.current += 1; recSaveRequestRef.current += 1; recSaverRef.current = createRecognizedFoodSaver(); setRecSaving(false); setRecResult(null); setRecSaveError(''); clearPendingRec(); }} className="text-xs text-neutral-400">✕</button>
            </div>
            <div className="mt-3 grid grid-cols-4 gap-2 text-center">
              {[
                ['热量', `${recResult.kcal}`],
                ['蛋白', `${recResult.protein_g}g`],
                ['碳水', `${recResult.carbs_g}g`],
                ['脂肪', `${recResult.fat_g}g`],
              ].map(([k, v]) => (
                <div key={k}>
                  <div className="text-base font-semibold tabular-nums">{v}</div>
                  <div className="text-xs text-neutral-400">{k}</div>
                </div>
              ))}
            </div>
            <div className="mt-3 flex items-center gap-2">
              <input type="text" inputMode="decimal" value={recGrams} disabled={recDraftLocked} onChange={(e) => { const value = e.target.value.replace(/[^\d.]/g, ''); if (value !== recGrams) { recDraftGenerationRef.current += 1; setRecGrams(value); } }} className="input h-9 w-24 text-center text-sm" placeholder="克" />
              <span className="text-xs text-neutral-400">克</span>
              <button onClick={confirmRecResult} disabled={foodWriting || manualDraftLocked} className="btn-primary ml-auto h-9 px-4 text-sm disabled:opacity-40">{recSaving ? '保存中…' : recSaveError ? '重试保存' : '确认添加'}</button>
            </div>
            {recSaveError && <p role="alert" className="mt-2 text-xs text-neutral-600">{recSaveError}</p>}
          </div>
        )}
        </div>
      </div>
    </div>
  );
}
