// 身材数据层：独立空间整包文件（/personal/{username}/body/）
import { createDavClient, getConfig, getConfigRevision, type WebDavConfig } from './webdav';
import { moduleDir } from './data-path';
import { loadSettings } from './settings';
import type { BodyProfile, FoodLog, WeightRecord } from '../types';
import { createFoodStore } from './food-store';
import { canonical, FoodError, mergeFoodChanges } from './food-model';

async function bodyDir(): Promise<string | null> {
  const cfg = getConfig();
  if (!cfg) return null;
  const settings = await loadSettings();
  return moduleDir('body', cfg.username, settings);
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  const cfg = getConfig();
  if (!cfg) return fallback;
  const client = createDavClient(cfg);
  try {
    const text = (await client.getFileContents(path, { format: 'text' })) as string;
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(path: string, data: unknown): Promise<void> {
  const cfg = getConfig();
  if (!cfg) return;
  const client = createDavClient(cfg);
  await client.putFileContents(path, JSON.stringify(data));
}

// —— 个人资料 ——
export interface BodyProfileAccess {
  config: WebDavConfig;
  revision?: number;
  isCurrent: () => boolean;
}

function assertProfileAccess(access?: BodyProfileAccess): void {
  if (access && !access.isCurrent()) throw new Error('身材操作已取消');
}

async function profileTarget(access?: BodyProfileAccess) {
  assertProfileAccess(access);
  const current = access?.config ?? getConfig();
  if (!current) return null;
  const config = { ...current };
  const settings = await loadSettings(config, Boolean(access), access?.revision);
  assertProfileAccess(access);
  return { client: createDavClient(config), path: `${moduleDir('body', config.username, settings)}/profile.json` };
}

export async function loadProfile(access?: BodyProfileAccess): Promise<BodyProfile | null> {
  const target = await profileTarget(access);
  if (!target) return null;
  try {
    const text = await target.client.getFileContents(target.path, { format: 'text' });
    assertProfileAccess(access);
    const profile = JSON.parse(text as string) as BodyProfile | null;
    if (access && (!profile || typeof profile !== 'object' || Array.isArray(profile))) {
      throw new Error('资料格式无效');
    }
    return profile;
  } catch (error: unknown) {
    assertProfileAccess(access);
    const status = (error as { status?: number; response?: { status?: number } } | null)?.status ??
      (error as { response?: { status?: number } } | null)?.response?.status;
    if (access && status !== 404) throw error;
    return null;
  }
}

export async function saveProfile(p: BodyProfile, access?: BodyProfileAccess): Promise<void> {
  const target = await profileTarget(access);
  if (!target) return;
  assertProfileAccess(access);
  await target.client.putFileContents(target.path, JSON.stringify(p));
}

// —— 体重记录 ——
export async function loadWeights(access?: BodyProfileAccess): Promise<WeightRecord[]> {
  if (access) return readBodyArray<WeightRecord>('weights.json', access);
  const dir = await bodyDir();
  if (!dir) return [];
  return readJson(`${dir}/weights.json`, []);
}

export async function saveWeights(list: WeightRecord[]): Promise<void> {
  const dir = await bodyDir();
  if (!dir) return;
  await writeJson(`${dir}/weights.json`, list);
}

// —— 食物记录 ——
interface FoodBaseline { records: FoodLog[]; path: string; access: BodyProfileAccess }
const foodBaselines = new WeakMap<FoodLog[], FoodBaseline>();
const foodAccessBaselines = new WeakMap<BodyProfileAccess, FoodBaseline>();

function foodAccess(access?: BodyProfileAccess): BodyProfileAccess {
  if (access) { assertProfileAccess(access); if (!access.config?.url || !access.config.username || !access.config.password) throw new Error('请先绑定个人工作台'); return access; }
  const cfg = getConfig();
  if (!cfg) throw new Error('请先绑定个人工作台');
  const config = { ...cfg };
  const revision = getConfigRevision();
  return { config, revision, isCurrent: () => { const current = getConfig(); return getConfigRevision() === revision && current?.url === config.url && current.username === config.username && current.password === config.password; } };
}

// Adapt existing WebDAV transport (including local proxy) to the shared service.
function foodStore(access: BodyProfileAccess) {
  const cfg = access.config;
  const client = createDavClient(cfg);
  const base = new URL(cfg.url.endsWith('/') ? cfg.url : `${cfg.url}/`);
  const fetcher: typeof fetch = async (input, init) => {
    assertProfileAccess(access);
    const url = new URL(String(input));
    const path = decodeURIComponent(url.pathname.slice(base.pathname.length));
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) throw new Error('饮食请求位置无效');
    try {
      if (path === 'bills/_settings.json') {
        const settings = await loadSettings(cfg, true, access.revision, true); assertProfileAccess(access);
        return new Response(JSON.stringify(settings));
      }
      if (init?.method === 'PUT') {
        const result = await client.putFileContents(path, String(init.body), { overwrite: true, headers: Object.fromEntries(new Headers(init.headers)), signal: init.signal ?? undefined });
        assertProfileAccess(access);
        if (result === false) throw new Error('服务端未确认保存食物记录');
        return new Response(null, { status: 204 });
      }
      const result = await client.getFileContents(path, { format: 'text', details: true, signal: init?.signal ?? undefined }) as unknown as { data: string; headers: Headers | Record<string, string> };
      assertProfileAccess(access);
      return new Response(result.data, { headers: result.headers });
    } catch (error) {
      assertProfileAccess(access);
      const status = (error as { status?: number; response?: { status?: number } })?.status ??
        (error as { response?: { status?: number } })?.response?.status;
      if (status && status >= 400 && status <= 599) return new Response(null, { status });
      throw error;
    }
  };
  return createFoodStore(cfg, fetcher);
}

// Transfer the displayed baseline through UI-only merges. It is not a fresh remote read.
export function inheritFoodBaseline(before: FoodLog[], next: FoodLog[]): FoodLog[] {
  const baseline = foodBaselines.get(before);
  if (baseline) foodBaselines.set(next, { ...baseline, records: structuredClone(next) });
  return next;
}

export async function loadFoodLogs(access?: BodyProfileAccess): Promise<FoodLog[]> {
  try {
    const captured = foodAccess(access);
    const snapshot = await foodStore(captured).read(); assertProfileAccess(captured);
    const rows = snapshot.records.filter(r => !r.deleted);
    const baseline = { records: structuredClone(rows), path: snapshot.path, access: captured };
    foodBaselines.set(rows, baseline);
    if (access) foodAccessBaselines.set(access, baseline);
    return rows;
  } catch (error) {
    if (access) { assertProfileAccess(access); throw error; }
    // A failed display read has no write baseline and cannot authorize a later empty overwrite.
    return [];
  }
}

export async function saveFoodLogs(list: FoodLog[], access?: BodyProfileAccess, before?: FoodLog[]): Promise<void> {
  if (access) foodAccess(access);
  const baseline = before ? foodBaselines.get(before) : (access ? foodAccessBaselines.get(access) : foodBaselines.get(list));
  if (!baseline) throw new Error('缺少饮食读取快照，请刷新核对后再保存');
  const captured = foodAccess(access ?? baseline.access); assertProfileAccess(baseline.access);
  if (canonical(captured.config) !== canonical(baseline.access.config)) throw new Error('饮食账号已变化');
  const store = foodStore(captured);
  let remote;
  try { remote = await store.read(); } catch (error) { assertProfileAccess(captured); throw error; }
  assertProfileAccess(captured);
  if (remote.path !== baseline.path) throw new FoodError('conflict', '饮食存储位置已变化，请刷新');
  // Remember the original baseline for retry, including a lost PUT receipt.
  foodBaselines.set(list, baseline);
  const merged = mergeFoodChanges(baseline.records, list, remote.records, Date.now());
  let after;
  try { after = canonical(merged) === canonical(remote.records) ? remote : await store.replace(remote, merged); }
  catch (error) { assertProfileAccess(captured); throw error; }
  assertProfileAccess(captured);
  // Update in-memory desired rows to the actual timestamps/receipts acknowledged by storage.
  for (const row of list) {
    const saved = after.records.find(r => r.id === row.id);
    if (saved) Object.assign(row, saved);
  }
  foodBaselines.set(list, { records: structuredClone(list), path: after.path, access: captured });
}

// Strict snapshot reads for callers that distinguish missing data from failed reads.
// Keep the captured account throughout settings and file requests.
async function readBodyArray<T>(filename: string, access: BodyProfileAccess): Promise<T[]> {
  assertProfileAccess(access);
  const config = { ...access.config };
  const settings = await loadSettings(config, true, access.revision);
  assertProfileAccess(access);
  try {
    const text = await createDavClient(config).getFileContents(
      `${moduleDir('body', config.username, settings)}/${filename}`, { format: 'text' },
    );
    assertProfileAccess(access);
    const value: unknown = JSON.parse(text as string);
    if (!Array.isArray(value)) throw new Error('身材记录格式无效');
    return value as T[];
  } catch (error) {
    assertProfileAccess(access);
    const status = (error as { status?: number; response?: { status?: number } })?.status
      ?? (error as { response?: { status?: number } })?.response?.status;
    if (status !== 404) throw error;
    return [];
  }
}

// Let composed readers verify that the food baseline shares the same body directory.
export function foodBaselinePath(records: FoodLog[]): string | undefined { return foodBaselines.get(records)?.path; }
