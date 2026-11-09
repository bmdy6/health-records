import { useLayoutEffect, useRef, useState } from 'react';
import Segmented from '../../../components/Segmented';
import { calcDailyNeeds, ACTIVITY_LEVELS, GOAL_MODES, type GoalModeValue } from '../../../lib/nutrition';
import type { WebDavConfig } from '../../../lib/webdav';
import { createBodySettingsController, type BodySettingsSnapshot } from './controller';

// 身材表单只依赖自己的流程快照，Settings 页面仅传当前绑定。
export default function BodySettings({ binding }: { binding: WebDavConfig }) {
  const controllerRef = useRef<ReturnType<typeof createBodySettingsController> | null>(null);
  const [snapshot, setSnapshot] = useState<BodySettingsSnapshot>(() => createBodySettingsController(binding).getSnapshot());
  useLayoutEffect(() => {
    const controller = createBodySettingsController(binding);
    controllerRef.current = controller;
    setSnapshot(controller.getSnapshot());
    const unsubscribe = controller.subscribe(() => setSnapshot(controller.getSnapshot()));
    void controller.start();
    return () => {
      unsubscribe(); controller.dispose();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [binding]);
  const { h, w, age, sex, activity, goalMode, kcalOverride, proteinOverride } = snapshot.form;
  const { profile, message: profileMsg, phase } = snapshot;
  const disabled = phase !== 'ready';
  return (
<div className="mt-6">
          <div className="px-1 text-xs font-medium uppercase tracking-wide text-neutral-400">身材资料</div>
          {phase === 'loading' && <p role="status" className="mt-2 px-1 text-xs text-neutral-500">资料加载中…</p>}
          {phase === 'error' && (
            <div role="alert" className="mt-2 rounded-xl bg-red-50 p-3 text-xs text-red-600">
              {profileMsg}
              <button onClick={() => void controllerRef.current?.reload()} className="btn-secondary mt-2 h-9">重新加载</button>
            </div>
          )}
          <fieldset disabled={disabled} className="card mt-1.5 min-w-0 p-4 space-y-3">
            <div className="grid grid-cols-3 gap-3">
              {(
                [
                  ['身高 cm', 'h', h],
                  ['体重 kg', 'w', w],
                  ['年龄', 'age', age],
                ] as const
              ).map(([label, key, val]) => (
                <label key={label} className="block">
                  <span className="mb-1 block text-xs text-neutral-500">{label}</span>
                  <input type="text" inputMode="decimal" value={val} onChange={(e) => controllerRef.current?.updateField(key, e.target.value.replace(/[^\d.]/g, ''))} className="input h-10 px-3 text-sm" />
                </label>
              ))}
            </div>
            <Segmented
              options={[
                { value: 'male', label: '男' },
                { value: 'female', label: '女' },
              ]}
              value={sex}
              onChange={(v) => controllerRef.current?.updateField('sex', v)}
            />
            <select value={activity} onChange={(e) => controllerRef.current?.updateField('activity', parseFloat(e.target.value) as typeof activity)} className="input text-sm">
              {ACTIVITY_LEVELS.map((a) => (
                <option key={a.value} value={a.value}>{a.label}</option>
              ))}
            </select>
            <div className="text-xs text-neutral-500">目标模式</div>
            <select value={goalMode} onChange={(e) => controllerRef.current?.updateField('goalMode', e.target.value as GoalModeValue)} className="input text-sm">
              {GOAL_MODES.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
            <div className="text-xs text-neutral-400">{GOAL_MODES.find((m) => m.value === goalMode)?.desc}</div>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="mb-1 block text-xs text-neutral-500">手动热量目标（千卡，留空=按模式）</span>
                <input type="text" inputMode="numeric" value={kcalOverride} onChange={(e) => controllerRef.current?.updateField('kcalOverride', e.target.value.replace(/\D/g, ''))} placeholder="如 1800" className="input h-9 px-3 text-sm" />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-neutral-500">手动蛋白质目标（克，留空=按模式）</span>
                <input type="text" inputMode="numeric" value={proteinOverride} onChange={(e) => controllerRef.current?.updateField('proteinOverride', e.target.value.replace(/\D/g, ''))} placeholder="如 140" className="input h-9 px-3 text-sm" />
              </label>
            </div>
            <button onClick={() => void controllerRef.current?.save()} className="btn-primary w-full">{phase === 'saving' ? '保存中…' : '保存资料'}</button>
            {profileMsg && phase !== 'error' && <div role="status" className="text-xs text-neutral-500">{profileMsg}</div>}
            {profile && (() => {
              const needs = calcDailyNeeds(profile);
              return (
                <div className="rounded-xl bg-neutral-50 p-3 text-sm">
                  <div className="font-medium">每日目标（按模式推算）</div>
                  <div className="mt-1.5 grid grid-cols-2 gap-1 text-xs text-neutral-500 tabular-nums">
                    <span>目标热量</span><span>{needs.targetKcal} 千卡</span>
                    <span>每日总消耗</span><span>{needs.tdee} 千卡</span>
                    <span>蛋白质目标</span><span>{needs.proteinG.min}-{needs.proteinG.max}g</span>
                    <span>脂肪建议</span><span>≈{needs.fatG}g</span>
                  </div>
                </div>
              );
            })()}
          </fieldset>
        </div>
  );
}
