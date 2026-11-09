import { loadProfile, saveProfile, type BodyProfileAccess } from '../../../lib/body';
import { isSharedAccount } from '../../../lib/data-path';
import { ACTIVITY_LEVELS, GOAL_MODES, type GoalModeValue } from '../../../lib/nutrition';
import { getConfig, getConfigRevision, type WebDavConfig } from '../../../lib/webdav';
import type { BodyProfile } from '../../../types';

export interface BodyForm {
  h: string; w: string; age: string; sex: BodyProfile['sex']; activity: BodyProfile['activity'];
  goalMode: GoalModeValue; kcalOverride: string; proteinOverride: string;
}
export interface BodySettingsSnapshot {
  phase: 'loading' | 'ready' | 'saving' | 'error';
  form: Readonly<BodyForm>;
  profile: BodyProfile | null;
  message: string;
}
const DEFAULT_FORM: BodyForm = { h: '175', w: '70', age: '28', sex: 'male', activity: 1.375,
  goalMode: 'maintain', kcalOverride: '', proteinOverride: '' };

function formFromProfile(profile: BodyProfile): BodyForm {
  return { h: String(profile.heightCm), w: String(profile.weightKg), age: String(profile.age),
    sex: profile.sex, activity: profile.activity, goalMode: profile.goalMode ?? 'maintain',
    kcalOverride: profile.kcalOverride === undefined ? '' : String(profile.kcalOverride),
    proteinOverride: profile.proteinOverride === undefined ? '' : String(profile.proteinOverride) };
}
function profileFromForm(form: Readonly<BodyForm>): BodyProfile | null {
  const heightCm = Number(form.h), weightKg = Number(form.w), age = Number(form.age);
  const kcalOverride = form.kcalOverride === '' ? undefined : Number(form.kcalOverride);
  const proteinOverride = form.proteinOverride === '' ? undefined : Number(form.proteinOverride);
  if (![heightCm, weightKg, age].every(value => Number.isFinite(value) && value > 0) ||
      !Number.isInteger(age) || !['male', 'female'].includes(form.sex) ||
      !ACTIVITY_LEVELS.some(level => level.value === form.activity) ||
      !GOAL_MODES.some(mode => mode.value === form.goalMode) ||
      [kcalOverride, proteinOverride].some(value => value !== undefined && (!Number.isFinite(value) || value <= 0))) return null;
  return { heightCm, weightKg, age, sex: form.sex, activity: form.activity, goalMode: form.goalMode,
    kcalOverride, proteinOverride, updatedAt: Date.now() };
}

// 身材设置私有流程：表单和已确认资料分开；操作全程绑定同一账号版本。
class BodySettingsController {
  private snapshot: BodySettingsSnapshot = { phase: 'loading', form: { ...DEFAULT_FORM }, profile: null, message: '' };
  private readonly listeners = new Set<() => void>();
  private disposed = false;
  private loadVersion = 0;
  private messageTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly access: BodyProfileAccess | null;

  constructor(binding: WebDavConfig | null) {
    const config = binding ? { ...binding } : null;
    const revision = getConfigRevision();
    this.access = config && !isSharedAccount(config.username) ? { config, revision, isCurrent: () => {
      const current = getConfig();
      return !this.disposed && getConfigRevision() === revision && current?.url === config.url &&
        current.username === config.username && current.password === config.password;
    } } : null;
  }
  getSnapshot = (): BodySettingsSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  };
  private isCurrent(): boolean { return Boolean(this.access?.isCurrent()); }
  private publish(next: Partial<BodySettingsSnapshot>): void {
    if (!this.isCurrent()) return;
    this.snapshot = { ...this.snapshot, ...next };
    this.listeners.forEach(listener => listener());
  }
  private clearMessageTimer(): void {
    if (this.messageTimer !== null) clearTimeout(this.messageTimer);
    this.messageTimer = null;
  }
  start = (): Promise<boolean> => this.reload();
  reload = async (): Promise<boolean> => {
    if (!this.access || !this.isCurrent() || this.snapshot.phase === 'saving') return false;
    const version = ++this.loadVersion;
    this.clearMessageTimer();
    this.publish({ phase: 'loading', message: '' });
    try {
      const profile = await loadProfile(this.access);
      if (!this.isCurrent() || version !== this.loadVersion) return false;
      const form = profile === null ? { ...DEFAULT_FORM } : formFromProfile(profile);
      if (profile !== null && !profileFromForm(form)) throw new Error('资料格式无效');
      this.publish({ phase: 'ready', form, profile });
      return true;
    } catch {
      if (version === this.loadVersion) this.publish({ phase: 'error', message: '资料加载失败，请重试' });
      return false;
    }
  };
  updateField = <K extends keyof BodyForm>(key: K, value: BodyForm[K]): void => {
    if (this.snapshot.phase !== 'ready' || !this.isCurrent()) return;
    this.publish({ form: { ...this.snapshot.form, [key]: value } });
  };
  save = async (): Promise<boolean> => {
    if (!this.access || !this.isCurrent() || this.snapshot.phase !== 'ready') return false;
    this.clearMessageTimer();
    const profile = profileFromForm(this.snapshot.form);
    if (!profile) {
      this.publish({ message: '请填写有效的身高 / 体重 / 年龄及目标' });
      return false;
    }
    this.publish({ phase: 'saving', message: '' });
    try {
      await saveProfile(profile, this.access);
      if (!this.isCurrent()) return false;
      this.publish({ phase: 'ready', profile, message: '已保存，每日目标已更新' });
      this.messageTimer = setTimeout(() => this.publish({ message: '' }), 2500);
      return true;
    } catch {
      this.publish({ phase: 'ready', message: '保存失败，请重试' });
      return false;
    }
  };
  dispose = (): void => {
    this.disposed = true; this.loadVersion++; this.clearMessageTimer(); this.listeners.clear();
  };
}

export function createBodySettingsController(binding: WebDavConfig | null): BodySettingsController {
  return new BodySettingsController(binding);
}
