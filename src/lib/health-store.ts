import { DEFAULT_SETTINGS, isSharedAccount, moduleDir } from './data-path';
import type { BodyProfile } from '../types';
import type { FoodConfig } from './food-store';
import { FoodError, canonical, fingerprint, object, requireFood } from './food-model';
import { validateDraft, validateRecords, validDate, draftFields, type HealthKind, type HealthRecord, type WorkoutDraft, type WorkoutLog, type HealthGoalDraft, type HealthGoal, type WeightDraft, type HealthWeight } from './health-model';
export interface HealthSnapshot<T> {
    records: T[];
    path: string;
    etag: string | null;
    exists: boolean;
}
export interface AddHealthRequest<T> {
    mutation_id: string;
    items: T[];
}
export interface UpdateHealthRequest<T, P> {
    mutation_id: string;
    id: string;
    expected: T;
    patch: Partial<Omit<P, 'id'>>;
}
const MAX_BYTES = 4 * 1024 * 1024;
export function createHealthStore(initialConfig: FoodConfig, fetcher: typeof fetch = fetch, now = Date.now) {
    const config = { ...initialConfig };
    requireFood(config && typeof config.url === 'string' && typeof config.username === 'string' && /^[\w-]+$/.test(config.username) && !isSharedAccount(config.username) && typeof config.password === 'string' && config.password.length > 0, '需要个人工作台身份');
    let base: URL;
    try {
        base = new URL(config.url.endsWith('/') ? config.url : config.url + '/');
    }
    catch {
        throw new FoodError('auth', 'WebDAV 地址无效');
    }
    requireFood((base.protocol === 'https:' || base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) && !base.username && !base.password && !base.search && !base.hash, '需要可信 HTTPS WebDAV 地址');
    const credentials = btoa(config.username + ':' + config.password);
    async function request(path: string, init: RequestInit = {}) {
        const headers = new Headers(init.headers);
        headers.set('Authorization', `Basic ${credentials}`);
        headers.set('Cache-Control', 'no-cache, no-store');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        try {
            const response = await fetcher(new URL(path, base), { ...init, headers, redirect: 'error', cache: 'no-store', signal: controller.signal });
            if (response.status === 412)
                throw new FoodError('conflict', '记录已变化，请重新查询后修改');
            if (!response.ok && response.status !== 404)
                throw new FoodError('http', `健康服务返回 HTTP ${response.status}`, init.method === 'PUT');
            let size = 0;
            const chunks: Uint8Array[] = [];
            if (response.body) {
                const reader = response.body.getReader();
                try {
                    while (true) {
                        const { value, done } = await reader.read();
                        if (done)
                            break;
                        size += value.byteLength;
                        if (size > MAX_BYTES) {
                            await reader.cancel();
                            throw new FoodError('data', '健康文件超过大小限制', init.method === 'PUT');
                        }
                        chunks.push(value);
                    }
                }
                finally {
                    reader.releaseLock();
                }
            }
            const merged = new Uint8Array(size);
            let offset = 0;
            for (const chunk of chunks) {
                merged.set(chunk, offset);
                offset += chunk.byteLength;
            }
            return { status: response.status, headers: response.headers, text: new TextDecoder().decode(merged) };
        }
        catch (error) {
            if (error instanceof FoodError)
                throw error;
            throw new FoodError('network', init.method === 'PUT' ? '尚未确认保存，请保留原请求并查询原 ID' : '读取失败，未写入健康记录', init.method === 'PUT');
        }
        finally {
            clearTimeout(timer);
        }
    }
    function parse(text: string): unknown {
        try {
            return JSON.parse(text);
        }
        catch {
            throw new FoodError('data', '服务端 JSON 无效，停止写入');
        }
    }
    async function target() {
        const response = await request('bills/_settings.json');
        let body = DEFAULT_SETTINGS.body;
        if (response.status !== 404) {
            const settings = parse(response.text);
            if (!object(settings) || (settings.body !== undefined && settings.body !== 'private' && settings.body !== 'shared'))
                throw new FoodError('data', '身材共享设置无效');
            body = settings.body as typeof body ?? body;
        }
        return moduleDir('body', config.username, { ...DEFAULT_SETTINGS, body });
    }
    async function read<T extends HealthRecord>(kind: HealthKind): Promise<HealthSnapshot<T>> {
        const path = `${await target()}/${kind === 'goals' ? 'health-goals' : kind}.json`;
        const response = await request(path);
        if (response.status === 404)
            return { records: [], path, etag: null, exists: false };
        let records: unknown;
        try {
            records = parse(response.text);
            validateRecords(kind, records);
        }
        catch {
            throw new FoodError('data', '健康记录文件无效，停止写入');
        }
        const tag = response.headers.get('etag');
        return { records: records as T[], path, etag: tag && /^"[^"\r\n]*"$/.test(tag) ? tag : null, exists: true };
    }
    async function replace<T extends HealthRecord>(kind: HealthKind, snapshot: HealthSnapshot<T>, records: T[]) {
        validateRecords(kind, records);
        if (snapshot.path !== `${await target()}/${kind === 'goals' ? 'health-goals' : kind}.json`)
            throw new FoodError('conflict', '健康数据位置已变化，请重新查询');
        if (snapshot.exists && !snapshot.etag)
            throw new FoodError('version', '缺少强 ETag，拒绝覆盖');
        const body = JSON.stringify(records);
        requireFood(new TextEncoder().encode(body).length <= MAX_BYTES, '健康文件超过大小限制');
        const response = await request(snapshot.path, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...(snapshot.exists ? { 'If-Match': snapshot.etag! } : { 'If-None-Match': '*' }) }, body });
        if (response.status === 404)
            throw new FoodError('http', '健康目录尚未初始化');
        try {
            const after = await read<T>(kind);
            if (after.path !== snapshot.path || canonical(after.records) !== canonical(records))
                throw Error('changed');
            return after;
        }
        catch {
            throw new FoodError('uncertain', '写入后未确认，请保留原请求并查询原 ID', true);
        }
    }
    function mutation(input: unknown, fields: string[]): asserts input is Record<string, unknown> { requireFood(object(input) && Object.keys(input).every(k => fields.includes(k)) && typeof input.mutation_id === 'string' && /^[\w-]{1,100}$/.test(input.mutation_id), '健康修改请求无效'); }
    // These files contain completed activity and measured weights, never future plans.
    function validateActualDate(kind: HealthKind, date: string) {
        if (kind === 'goals') return;
        const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now());
        const today = ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)!.value).join('-');
        requireFood(date <= today, '实际训练和体重不能记录在未来日期');
    }
    async function add<T extends HealthRecord, D>(kind: HealthKind, input: AddHealthRequest<D>): Promise<T[]> {
        mutation(input, ['mutation_id', 'items']);
        requireFood(Array.isArray(input.items) && input.items.length > 0 && input.items.length <= 30, '一次需要 1–30 条记录');
        input.items.forEach(r => { validateDraft(kind, r); validateActualDate(kind, (r as {date:string}).date); });
        const items = input.items as (D & {
            id: string;
        })[];
        requireFood(new Set(items.map(r => r.id)).size === items.length, '记录 ID 重复');
        const mark = { id: input.mutation_id, fingerprint: await fingerprint(input) };
        const snapshot = await read<T>(kind);
        const replay = snapshot.records.filter(r => r.agentMutation?.id === mark.id);
        if (replay.length) {
            if (replay.length !== items.length || replay.some(r => r.deleted || r.agentMutation?.fingerprint !== mark.fingerprint) || items.some(d => !replay.some(r => r.id === d.id && canonical(Object.fromEntries(draftFields[kind].filter(k => (r as unknown as Record<string, unknown>)[k] !== undefined).map(k => [k, (r as unknown as Record<string, unknown>)[k]]))) === canonical(d))))
                throw new FoodError('conflict', '原请求已变化或 mutation_id 被复用');
            return items.map(d => replay.find(r => r.id === d.id)!);
        }
        if (items.some(d => snapshot.records.some(r => r.id === d.id)))
            throw new FoodError('conflict', '记录 ID 已存在');
        const stamp = now();
        const additions = items.map(d => ({ ...d, createdAt: stamp, updatedAt: stamp, deleted: false, agentMutation: mark })) as unknown as T[];
        const after = await replace(kind, snapshot, [...snapshot.records, ...additions]);
        return items.map(d => after.records.find(r => r.id === d.id)!);
    }
    async function update<T extends HealthRecord, D>(kind: HealthKind, input: UpdateHealthRequest<T, D>): Promise<T> {
        mutation(input, ['mutation_id', 'id', 'expected', 'patch']);
        validateRecords(kind, [input.expected]);
        requireFood(input.id === input.expected.id && !input.expected.deleted && object(input.patch) && Object.keys(input.patch).length > 0 && Object.keys(input.patch).every(k => k !== 'id' && draftFields[kind].includes(k)), '修改字段无效');
        const desired = { ...input.expected, ...input.patch };
        validateDraft(kind, Object.fromEntries(draftFields[kind].filter(k => (desired as unknown as Record<string, unknown>)[k] !== undefined).map(k => [k, (desired as unknown as Record<string, unknown>)[k]])));
        validateActualDate(kind, desired.date);
        const mark = { id: input.mutation_id, fingerprint: await fingerprint(input) };
        const snapshot = await read<T>(kind);
        const before = snapshot.records.find(r => r.id === input.id);
        if (snapshot.records.some(r => r.agentMutation?.id === mark.id && r.id !== input.id))
            throw new FoodError('conflict', 'mutation_id 已用于其他记录');
        if (before?.agentMutation?.id === mark.id && before.agentMutation.fingerprint === mark.fingerprint && !before.deleted) {
            if (canonical({ ...before, agentMutation: undefined, updatedAt: 0 }) !== canonical({ ...desired, agentMutation: undefined, updatedAt: 0 }))
                throw new FoodError('conflict', '原修改结果已变化');
            return before;
        }
        if (!before || before.deleted || canonical(before) !== canonical(input.expected) || before.agentMutation?.id === mark.id)
            throw new FoodError('conflict', '记录已变化，请重新查询');
        const record = { ...desired, agentMutation: mark, updatedAt: Math.max(now(), before.updatedAt + 1) };
        const after = await replace(kind, snapshot, snapshot.records.map(r => r.id === input.id ? record : r));
        return after.records.find(r => r.id === input.id)!;
    }
    async function readProfile(): Promise<BodyProfile | null> {
        const directory = await target();
        const response = await request(`${directory}/profile.json`);
        if (directory !== await target()) throw new FoodError('conflict', '个人资料存储位置已变化，请重新查询');
        if (response.status === 404)
            return null;
        const p = parse(response.text);
        const number = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
        if (!object(p) || !Object.keys(p).every(k => ['heightCm', 'weightKg', 'age', 'sex', 'activity', 'goalMode', 'kcalOverride', 'proteinOverride', 'updatedAt'].includes(k)) || !number(p.heightCm, 30, 300) || !number(p.weightKg, 1, 1000) || !number(p.age, 1, 130) || !(typeof p.sex === 'string' && ['male', 'female'].includes(p.sex)) || !(typeof p.activity === 'number' && [1.2, 1.375, 1.55, 1.725, 1.9].includes(p.activity)) || !Number.isSafeInteger(p.updatedAt) || Number(p.updatedAt) < 0 || p.goalMode !== undefined && !(typeof p.goalMode === 'string' && ['maintain', 'cut-mild', 'cut-agg', 'fasting', 'bulk'].includes(p.goalMode)) || p.kcalOverride !== undefined && !number(p.kcalOverride, 1, 100000) || p.proteinOverride !== undefined && !number(p.proteinOverride, 0, 10000))
            throw new FoodError('data', '个人资料格式无效');
        return p as unknown as BodyProfile;
    }
    const readWorkouts = () => read<WorkoutLog>('workouts'), readGoals = () => read<HealthGoal>('goals'), readWeights = () => read<HealthWeight>('weights');
    async function healthContext(start: string, end: string) {
        validDate(start);
        validDate(end);
        requireFood(end >= start && (Date.parse(end) - Date.parse(start)) / 86400000 <= 366, '健康查询范围必须不超过 366 天');
        const [workouts, goals, weights, profile] = await Promise.all([readWorkouts(), readGoals(), readWeights(), readProfile()]);
        const within = <T extends HealthRecord>(rows: T[]) => rows.filter(r => !r.deleted && r.date >= start && r.date <= end);
        const directory = await target();
        if ([workouts, goals, weights].some(snapshot => snapshot.path.slice(0, snapshot.path.lastIndexOf('/')) !== directory))
            throw new FoodError('conflict', '健康数据位置已变化，请重新查询');
        const result = { start, end, workouts: within(workouts.records), goals: goals.records.filter(r => !r.deleted && r.date <= end), weights: within(weights.records), profile, coverage: { workouts: workouts.exists, goals: goals.exists, weights: weights.exists, profile: profile !== null } };
        requireFood(result.workouts.length + result.weights.length + result.goals.length <= 1000, '请缩小健康查询范围');
        return result;
    }
    return { readWorkouts, readGoals, readWeights, readProfile, healthContext,
        addWorkouts: (input: AddHealthRequest<WorkoutDraft>) => add<WorkoutLog, WorkoutDraft>('workouts', input),
        addGoals: (input: AddHealthRequest<HealthGoalDraft>) => add<HealthGoal, HealthGoalDraft>('goals', input),
        addWeights: (input: AddHealthRequest<WeightDraft>) => add<HealthWeight, WeightDraft>('weights', input),
        updateWorkout: (input: UpdateHealthRequest<WorkoutLog, WorkoutDraft>) => update('workouts', input),
        updateGoal: (input: UpdateHealthRequest<HealthGoal, HealthGoalDraft>) => update('goals', input),
        updateWeight: (input: UpdateHealthRequest<HealthWeight, WeightDraft>) => update('weights', input) };
}
