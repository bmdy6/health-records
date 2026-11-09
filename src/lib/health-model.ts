import type { WeightRecord } from '../types';
import { object, requireFood } from './food-model';
export { FoodError as HealthError } from './food-model';
export interface HealthMetadata {
    createdAt: number;
    updatedAt: number;
    deleted: boolean;
    agentMutation?: {
        id: string;
        fingerprint: string;
    };
}
export interface WorkoutDraft {
    id: string;
    date: string;
    title: string;
    durationMin?: number;
    intensity?: 'light' | 'moderate' | 'vigorous';
    feeling?: string;
    discomfort?: string;
    exercises?: {
        name: string;
        sets?: number;
        reps?: number;
        weightKg?: number;
    }[];
    calories?: {
        min: number;
        max: number;
        source: string;
    };
}
export interface WorkoutLog extends WorkoutDraft, HealthMetadata {
}
export interface HealthGoalDraft {
    id: string;
    date: string;
    startKg: number;
    targetKg: number;
    carbsG?: number;
    fatG?: number;
}
export interface HealthGoal extends HealthGoalDraft, HealthMetadata {
}
export type HealthWeight = WeightRecord & Pick<HealthMetadata, 'agentMutation'>;
export type WeightDraft = Pick<HealthWeight, 'id' | 'date' | 'kg'>;
export type HealthRecord = WorkoutLog | HealthGoal | HealthWeight;
export function validDate(value: unknown): asserts value is string { requireFood(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number(value.slice(0, 4)) >= 1900 && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value, '日期无效'); }
const common = ['id', 'date'];
export const draftFields = { workouts: [...common, 'title', 'durationMin', 'intensity', 'feeling', 'discomfort', 'exercises', 'calories'], goals: [...common, 'startKg', 'targetKg', 'carbsG', 'fatG'], weights: [...common, 'kg'] };
export type HealthKind = keyof typeof draftFields;
function num(v: unknown, min: number, max: number) { requireFood(typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max, '健康数值无效'); }
function text(v: unknown, max: number, required = false) { requireFood(typeof v === 'string' && v.length <= max && (!required || v.trim().length > 0), '健康文字无效'); }
export function validateDraft(kind: HealthKind, value: unknown): void {
    requireFood(object(value) && Object.keys(value).every(k => draftFields[kind].includes(k)), '健康记录字段无效');
    requireFood(typeof value.id === 'string' && /^[\w-]{1,100}$/.test(value.id), '记录 ID 无效');
    validDate(value.date);
    if (kind === 'weights')
        num(value.kg, 1, 1000);
    if (kind === 'goals') {
        num(value.startKg, 1, 1000);
        num(value.targetKg, 1, 1000);
        for (const k of ['carbsG', 'fatG'])
            if (value[k] !== undefined)
                num(value[k], 0, 10000);
    }
    if (kind === 'workouts') {
        text(value.title, 200, true);
        if (value.durationMin !== undefined)
            num(value.durationMin, 1, 1440);
        requireFood(value.intensity === undefined || typeof value.intensity === 'string' && ['light', 'moderate', 'vigorous'].includes(value.intensity), '运动强度无效');
        for (const k of ['feeling', 'discomfort'])
            if (value[k] !== undefined)
                text(value[k], 2000);
        if (value.exercises !== undefined) {
            requireFood(Array.isArray(value.exercises) && value.exercises.length <= 100, '动作列表无效');
            for (const e of value.exercises) {
                requireFood(object(e) && Object.keys(e).every(k => ['name', 'sets', 'reps', 'weightKg'].includes(k)), '动作字段无效');
                text(e.name, 200, true);
                for (const k of ['sets', 'reps', 'weightKg'])
                    if (e[k] !== undefined) {
                        num(e[k], k === 'weightKg' ? 0 : 1, 10000);
                        if (k !== 'weightKg')
                            requireFood(Number.isInteger(e[k]), '组数次数必须为整数');
                    }
            }
        }
        if (value.calories !== undefined) {
            const c = value.calories;
            requireFood(object(c) && Object.keys(c).every(k => ['min', 'max', 'source'].includes(k)), '运动热量无效');
            num(c.min, 0, 100000);
            num(c.max, 0, 100000);
            requireFood(Number(c.min) <= Number(c.max), '热量区间无效');
            text(c.source, 500, true);
        }
    }
}
export function validateRecords(kind: HealthKind, value: unknown): asserts value is HealthRecord[] {
    requireFood(Array.isArray(value) && value.length <= 20000, '健康文件格式无效');
    const ids = new Set();
    for (const r of value) {
        requireFood(object(r), '健康记录无效');
        requireFood(Object.keys(r).every(k => [...draftFields[kind], 'createdAt', 'updatedAt', 'deleted', 'agentMutation'].includes(k)), '健康记录包含未知字段');
        validateDraft(kind, Object.fromEntries(draftFields[kind].filter(k => r[k] !== undefined).map(k => [k, r[k]])));
        requireFood(!ids.has(r.id) && typeof r.deleted === 'boolean' && Number.isSafeInteger(r.createdAt) && Number(r.createdAt) >= 0 && Number.isSafeInteger(r.updatedAt) && Number(r.updatedAt) >= Number(r.createdAt), '记录元数据无效');
        ids.add(r.id);
        if (r.agentMutation !== undefined)
            requireFood(object(r.agentMutation) && Object.keys(r.agentMutation).every(k => ['id', 'fingerprint'].includes(k)) && typeof r.agentMutation.id === 'string' && /^[\w-]{1,100}$/.test(r.agentMutation.id) && typeof r.agentMutation.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(r.agentMutation.fingerprint), '修改回执无效');
    }
}
