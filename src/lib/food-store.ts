import { DEFAULT_SETTINGS, isSharedAccount, moduleDir } from './data-path';
import type { FoodLog } from '../types';
import type { FoodDraft, FoodPatch } from './food-model';
import { FoodError, canonical, fingerprint, object, patchFood, requireFood, validateFoodDraft, validateFoodLogs } from './food-model';

export interface FoodConfig { url: string; username: string; password: string }
export interface FoodSnapshot { records: FoodLog[]; path: string; etag: string | null; exists: boolean }
export interface AddFoodRequest { mutation_id: string; items: FoodDraft[] }
export interface UpdateFoodRequest { mutation_id: string; id: string; expected: FoodLog; patch: FoodPatch }
const MAX_BYTES = 4 * 1024 * 1024;
function mutationId(id: unknown) { requireFood(typeof id === 'string' && /^[\w-]{1,100}$/.test(id), '需要稳定、安全的 mutation_id'); }

export function createFoodStore(config: FoodConfig, fetcher: typeof fetch = fetch, now = Date.now) {
  requireFood(config && typeof config.url === 'string' && /^[\w-]+$/.test(config.username) &&
    !isSharedAccount(config.username) && typeof config.password === 'string' && config.password.length > 0, '需要个人工作台身份');
  let base: URL;
  try { base = new URL(config.url.endsWith('/') ? config.url : `${config.url}/`); }
  catch { throw new FoodError('auth', 'WebDAV 地址无效'); }
  requireFood((base.protocol === 'https:' || (base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname))) &&
    !base.username && !base.password && !base.search && !base.hash, '需要可信的 HTTPS WebDAV 地址');
  const credentials = btoa(config.username + ':' + config.password);

  async function request(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers); headers.set('Authorization', `Basic ${credentials}`);
    headers.set('Cache-Control', 'no-cache, no-store');
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetcher(new URL(path, base), { ...init, headers, redirect: 'error', cache: 'no-store', signal: controller.signal });
      if (response.status === 412) throw new FoodError('conflict', '记录已变化，请重新查询后修改');
      if (!response.ok && response.status !== 404) throw new FoodError('http', `饮食服务返回 HTTP ${response.status}`, init.method === 'PUT');
      let size = 0; const chunks: Uint8Array[] = [];
      if (response.body) {
        const reader = response.body.getReader();
        try { while (true) { const { value, done } = await reader.read(); if (done) break;
          size += value.byteLength; if (size > MAX_BYTES) { await reader.cancel(); throw new FoodError('data', '饮食文件超过大小限制'); }
          chunks.push(value);
        } } finally { reader.releaseLock(); }
      }
      const merged = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
      return { status: response.status, headers: response.headers, text: new TextDecoder().decode(merged) };
    } catch (error) {
      if (error instanceof FoodError) throw error;
      throw new FoodError('network', init.method === 'PUT' ? '尚未确认保存，请保留原请求并查询原 ID' : '读取失败，未写入饮食记录', init.method === 'PUT');
    } finally { clearTimeout(timer); }
  }
  function parse(text: string): unknown {
    try { return JSON.parse(text); } catch { throw new FoodError('data', '服务端 JSON 无效，停止写入'); }
  }
  async function target() {
    const response = await request('bills/_settings.json');
    let body = DEFAULT_SETTINGS.body;
    if (response.status !== 404) {
      const settings = parse(response.text);
      if (!object(settings) || (settings.body !== undefined && settings.body !== 'private' && settings.body !== 'shared')) throw new FoodError('data', '身材共享设置无效');
      body = settings.body as typeof body ?? body;
    }
    return `${moduleDir('body', config.username, { ...DEFAULT_SETTINGS, body })}/food.json`;
  }
  async function read(): Promise<FoodSnapshot> {
    const path = await target(); const response = await request(path);
    if (response.status === 404) return { records: [], path, etag: null, exists: false };
    const records = parse(response.text); validateFoodLogs(records);
    const tag = response.headers.get('etag');
    return { records, path, exists: true, etag: tag && /^"[^"\r\n]*"$/.test(tag) ? tag : null };
  }
  async function replace(snapshot: FoodSnapshot, records: FoodLog[]): Promise<FoodSnapshot> {
    validateFoodLogs(records);
    if (snapshot.path !== await target()) throw new FoodError('conflict', '饮食存储位置已变化，请重新查询');
    if (snapshot.exists && !snapshot.etag) throw new FoodError('version', '缺少同次读取的强 ETag，拒绝覆盖');
    const body = JSON.stringify(records);
    requireFood(new TextEncoder().encode(body).length <= MAX_BYTES, '饮食文件超过大小限制');
    const result = await request(snapshot.path, { method: 'PUT', headers: {
      'Content-Type': 'application/json', ...(snapshot.exists ? { 'If-Match': snapshot.etag! } : { 'If-None-Match': '*' }),
    }, body });
    if (result.status === 404) throw new FoodError('http', '饮食目录尚未初始化');
    let after: FoodSnapshot;
    try { after = await read(); }
    catch { throw new FoodError('uncertain', '写入后未能核对，请保留原请求并查询原 ID', true); }
    // A concurrent change after PUT must never be mistaken for a confirmed exact snapshot.
    if (after.path !== snapshot.path || canonical(after.records) !== canonical(records)) throw new FoodError('uncertain', '记录已被其他客户端更新，请查询原 ID 核对', true);
    return after;
  }
  async function add(input: AddFoodRequest): Promise<FoodLog[]> {
    requireFood(object(input) && Object.keys(input).every(k => ['mutation_id', 'items'].includes(k)), '新增请求无效');
    mutationId(input.mutation_id);
    requireFood(Array.isArray(input.items) && input.items.length > 0 && input.items.length <= 30, '一餐需要 1–30 项食物');
    input.items.forEach(validateFoodDraft);
    requireFood(new Set(input.items.map(r => r.id)).size === input.items.length, '食物 ID 重复');
    const mark = { id: input.mutation_id, fingerprint: await fingerprint(input) };
    const snapshot = await read();
    const sameMutation = snapshot.records.filter(r => r.agentMutation?.id === mark.id);
    if (sameMutation.length) {
      if (sameMutation.length !== input.items.length || sameMutation.some(r => r.deleted || r.agentMutation?.fingerprint !== mark.fingerprint) ||
        input.items.some(d => !sameMutation.some(r => r.id === d.id && Object.keys(d).every(k => canonical(r[k as keyof FoodLog]) === canonical(d[k as keyof FoodDraft]))))) throw new FoodError('conflict', '原请求记录已变化或 mutation_id 已用于其他内容');
      return input.items.map(d => sameMutation.find(r => r.id === d.id)!);
    }
    if (input.items.some(d => snapshot.records.some(r => r.id === d.id))) throw new FoodError('conflict', '记录 ID 已存在，请查询原 ID 核对');
    const stamp = now();
    const additions: FoodLog[] = input.items.map(d => ({ ...d, createdAt: stamp, updatedAt: stamp, deleted: false, agentMutation: mark }));
    const after = await replace(snapshot, [...snapshot.records, ...additions]);
    return input.items.map(d => after.records.find(r => r.id === d.id)!);
  }
  async function update(input: UpdateFoodRequest): Promise<FoodLog> {
    requireFood(object(input) && Object.keys(input).every(k => ['mutation_id', 'id', 'expected', 'patch'].includes(k)), '修改请求无效');
    mutationId(input.mutation_id); validateFoodLogs([input.expected]);
    requireFood(input.id === input.expected.id && !input.expected.deleted, '修改目标无效');
    const desired = patchFood(input.expected, input.patch);
    const mark = { id: input.mutation_id, fingerprint: await fingerprint(input) };
    const snapshot = await read(); const before = snapshot.records.find(r => r.id === input.id);
    if (snapshot.records.some(r => r.agentMutation?.id === mark.id && r.id !== input.id)) throw new FoodError('conflict', 'mutation_id 已被其他记录使用');
    if (before?.agentMutation?.id === mark.id && before.agentMutation.fingerprint === mark.fingerprint && !before.deleted) {
      if (canonical({ ...before, agentMutation: undefined, updatedAt: 0 }) !== canonical({ ...desired, agentMutation: undefined, updatedAt: 0 })) throw new FoodError('conflict', '原修改结果已变化');
      return before;
    }
    if (!before || before.deleted || canonical(before) !== canonical(input.expected)) throw new FoodError('conflict', '记录已变化，请重新查询后修改');
    if (before.agentMutation?.id === mark.id) throw new FoodError('conflict', '同一 mutation_id 不能用于不同修改');
    const record = { ...desired, agentMutation: mark, updatedAt: Math.max(now(), before.updatedAt + 1) };
    const after = await replace(snapshot, snapshot.records.map(r => r.id === input.id ? record : r));
    return after.records.find(r => r.id === input.id)!;
  }
  return { read, replace, add, update };
}
