import { describe, it, expect } from 'vitest';
import { createFoodStore } from './food-store';
import type { FoodLog } from '../types';

const cfg = { url: 'https://dav.example/wb/', username: 'owner', password: 'test-only' };
const item = { id: 'rice-1', date: '2026-10-30', meal: '午餐', food: '米饭', grams: 200, kcal: 240, protein: 5, carbs: 52, fat: 1, note: '照片估算，待核实' };
function fixture(initial: unknown = []) {
  let rows = initial, revision = 1, puts = 0;
  let fault = '', omitTag = false;
  const requests: { method: string; path: string; headers: Headers }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers); requests.push({ method, path: url.pathname, headers });
    if (url.pathname.endsWith('_settings.json')) return new Response('{"body":"private"}');
    if (fault === 'read' && method === 'GET') return new Response('failure', { status: 503 });
    if (method === 'GET') return new Response(JSON.stringify(rows), { headers: omitTag ? {} : { ETag: `"v${revision}"` } });
    if (method === 'PUT') {
      if (headers.get('If-Match') !== `"v${revision}"`) return new Response('', { status: 412 });
      rows = JSON.parse(String(init?.body)); revision++; puts++;
      if (fault === 'lost') throw new Error('secret upstream URL');
      return new Response(null, { status: 204 });
    }
    throw new Error('unexpected request');
  };
  return { store: createFoodStore(cfg, fetcher, () => 1000), requests, rows: () => rows as FoodLog[], puts: () => puts,
    fail: (v: string) => { fault = v; }, omit: () => { omitTag = true; }, external: (v: unknown) => { rows = v; revision++; } };
}

describe('food tools: existing single data source', () => {
  it('adds a photo estimate, reads it back, and replays without duplication', async () => {
    const f = fixture(); const request = { mutation_id: 'photo-1', items: [item] };
    const a = await f.store.add(request); const b = await f.store.add(request);
    expect(a).toEqual(b); expect(f.rows()).toHaveLength(1); expect(f.puts()).toBe(1);
    expect(a[0]).toMatchObject(item);
    expect(f.requests.some(r => r.path === '/wb/personal/owner/body/food.json')).toBe(true);
  });
  it('updates rice to half once, keeping another food unchanged', async () => {
    const f = fixture(); const [rice, egg] = await f.store.add({ mutation_id: 'photo-1', items: [item, { ...item, id: 'egg-1', food: '鸡蛋' }] });
    const request = { mutation_id: 'half-1', id: rice.id, expected: rice, patch: { grams: 100 } };
    const changed = await f.store.update(request); const replay = await f.store.update(request);
    expect(changed).toMatchObject({ grams: 100, kcal: 120, protein: 2.5, carbs: 26, fat: 0.5 });
    expect(replay).toEqual(changed); expect(f.rows().find(r => r.id === egg.id)).toEqual(egg); expect(f.puts()).toBe(2);
  });
  it('rejects changed targets and same mutation ID with different payload', async () => {
    const f = fixture(); const [record] = await f.store.add({ mutation_id: 'a', items: [item] });
    await expect(f.store.add({ mutation_id: 'a', items: [{ ...item, grams: 20 }] })).rejects.toThrow();
    f.external([{ ...record, note: 'phone edit' }]);
    await expect(f.store.update({ mutation_id: 'b', id: record.id, expected: record, patch: { grams: 100 } })).rejects.toThrow();
    expect(f.puts()).toBe(1);
  });
  it('does not treat failed or malformed reads as an empty collection', async () => {
    const f = fixture(); f.fail('read');
    await expect(f.store.add({ mutation_id: 'a', items: [item] })).rejects.toThrow(); expect(f.puts()).toBe(0);
    f.fail(''); f.external({ invalid: true });
    await expect(f.store.add({ mutation_id: 'a', items: [item] })).rejects.toThrow(); expect(f.puts()).toBe(0);
  });
  it('requires strong ETag and refuses a stale browser snapshot', async () => {
    const f = fixture(); const snapshot = await f.store.read(); f.external([]);
    await expect(f.store.replace(snapshot, [])).rejects.toThrow(); expect(f.puts()).toBe(0);
    f.omit(); await expect(f.store.add({ mutation_id: 'a', items: [item] })).rejects.toThrow();
    expect(f.puts()).toBe(0);
  });
  it('recovers a lost write receipt with the exact original mutation', async () => {
    const f = fixture(); const request = { mutation_id: 'a', items: [item] }; f.fail('lost');
    await expect(f.store.add(request)).rejects.toThrow(); f.fail('');
    const recovered = await f.store.add(request); expect(recovered).toHaveLength(1); expect(f.puts()).toBe(1);
  });
  it('rejects shared billing identity and invalid payloads before a write', async () => {
    const f = fixture();
    expect(() => createFoodStore({ ...cfg, username: 'shared-viewer' }, fetch)).toThrow();
    for (const invalid of [{ ...item, kcal: -1 }, { ...item, date: '2026-02-30' }, { ...item, food: '' }, { ...item, grams: NaN }]) {
      await expect(f.store.add({ mutation_id: 'a', items: [invalid] })).rejects.toThrow();
    }
    expect(f.puts()).toBe(0);
  });
});

import { mergeFoodChanges } from './food-model';
it('browser changes preserve unseen Dot additions and reject concurrent edits', () => {
  const a = { ...item, createdAt: 1, updatedAt: 1, deleted: false };
  const b = { ...a, id: 'dot-1' };
  expect(mergeFoodChanges([a], [], [a, b], 2)).toEqual([{ ...a, deleted: true, updatedAt: 2, agentMutation: undefined }, b]);
  expect(() => mergeFoodChanges([a], [], [{ ...a, grams: 100 }, b], 2)).toThrow('其他客户端');
});
it('does not accept an old mutation receipt after another client edits its contents', async () => {
  const f = fixture(); const req = { mutation_id: 'a', items: [item] }; const [a] = await f.store.add(req);
  f.external([{ ...a, grams: 10 }]); await expect(f.store.add(req)).rejects.toThrow();
});
it('preserves undo through a matching deletion tombstone but never restores a changed tombstone', () => {
  const a = { ...item, createdAt: 1, updatedAt: 1, deleted: false };
  const deleted = { ...a, deleted: true, updatedAt: 2 };
  expect(mergeFoodChanges([], [a], [deleted], 3)[0]).toMatchObject({ deleted: false, updatedAt: 3 });
  expect(() => mergeFoodChanges([], [a], [{ ...deleted, food: 'changed' }], 3)).toThrow();
});
it('creates a missing file conditionally and never overwrites a racing creator', async () => {
  let puts = 0;
  const store = createFoodStore(cfg, async (_url, init) => {
    if (String(_url).endsWith('_settings.json')) return new Response(null, { status: 404 });
    if (init?.method === 'PUT') { puts++; expect(new Headers(init.headers).get('If-None-Match')).toBe('*'); return new Response(null, { status: 412 }); }
    return new Response(null, { status: 404 });
  });
  await expect(store.add({ mutation_id: 'create', items: [item] })).rejects.toThrow('已变化'); expect(puts).toBe(1);
});
it('rejects malformed sharing settings and weak versions', async () => {
  for (const settings of ['{', '{"body":"other"}', '[]']) {
    const store = createFoodStore(cfg, async () => new Response(settings));
    await expect(store.add({ mutation_id: 'a', items: [item] })).rejects.toThrow();
  }
  const store = createFoodStore(cfg, async url => String(url).endsWith('_settings.json') ? new Response('{}') : new Response('[]', { headers: { ETag: 'W/"weak"' } }));
  await expect(store.add({ mutation_id: 'a', items: [item] })).rejects.toThrow('强 ETag');
});
it('cannot replay a portion change after the record was subsequently edited', async () => {
  const f = fixture(); const [a] = await f.store.add({ mutation_id: 'photo', items: [item] });
  const change = { mutation_id: 'half', id: a.id, expected: a, patch: { grams: 100 } };
  const saved = await f.store.update(change); f.external([{ ...saved, kcal: 999 }]);
  await expect(f.store.update(change)).rejects.toThrow();
});
