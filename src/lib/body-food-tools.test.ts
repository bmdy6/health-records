import { it, expect, vi, beforeEach } from 'vitest';
import { loadFoodLogs, saveFoodLogs } from './body';
const cfg = { url: 'https://dav.example/wb/', username: 'owner', password: 'test-only' };
const io = vi.hoisted(() => ({ rows: [] as unknown[], rev: 1, puts: 0, binding: 1 }));
vi.mock('./settings', () => ({ loadSettings: async () => ({ body: 'private' }) }));
vi.mock('./webdav', () => ({ getConfig: () => cfg, getConfigRevision: () => io.binding, createDavClient: () => ({
  getFileContents: async () => ({ data: JSON.stringify(io.rows), headers: { etag: `"${io.rev}"` } }),
  putFileContents: async (_path: string, text: string, options: { headers: Record<string, string> }) => {
    if (options.headers['if-match'] !== `"${io.rev}"`) throw { status: 412 };
    io.rows = JSON.parse(text); io.rev++; io.puts++; return true;
  },
}) }));
const a = { id: 'a', date: '2026-10-30', food: '米饭', kcal: 240, grams: 200, createdAt: 1, updatedAt: 1, deleted: false };
beforeEach(() => { io.rows = [a]; io.rev = 1; io.puts = 0; io.binding++; });
it('a browser deletion preserves an unseen Dot addition as a tombstone', async () => {
  const before = await loadFoodLogs(); io.rows = [a, { ...a, id: 'dot-new' }]; io.rev++;
  await saveFoodLogs([], undefined, before);
  expect(io.rows).toEqual([expect.objectContaining({ id: 'a', deleted: true }), expect.objectContaining({ id: 'dot-new', deleted: false })]);
});
it('a browser edit never overwrites a changed Dot record', async () => {
  const before = await loadFoodLogs(); io.rows = [{ ...a, grams: 100 }]; io.rev++;
  await expect(saveFoodLogs([], undefined, before)).rejects.toThrow('其他客户端'); expect(io.puts).toBe(0);
});

it('cancels the previous read baseline after rebinding the identical account', async () => {
  const before = await loadFoodLogs(); io.binding++;
  await expect(saveFoodLogs([], undefined, before)).rejects.toThrow('取消'); expect(io.puts).toBe(0);
});
