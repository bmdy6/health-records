// 身材数据层单测（方案批次 1 安全网）
import { describe, it, expect, vi, beforeEach } from 'vitest';

// mock webdav 模块：getConfig 返回固定配置，createDavClient 返回可控 client
const calls: { method: string; path: string }[] = [];
const fakeClient = {
  getFileContents: vi.fn(async (path: string) => {
    calls.push({ method: 'get', path });
    if (path.endsWith('profile.json')) throw new Error('404'); // 未绑定 fallback 场景
    return JSON.stringify([{ id: 'w1', date: '2026-08-03', kg: 79 }]);
  }),
  putFileContents: vi.fn(async (path: string) => {
    calls.push({ method: 'put', path });
  }),
};

const mockGetConfig = vi.fn(() => ({
  url: 'https://dav.example.com/webdav/wb/',
  username: 'wb-personal',
  password: 'test-password',
}));

vi.mock('./webdav', () => ({
  getConfig: mockGetConfig,
  getConfigRevision: () => 0,
  createDavClient: () => fakeClient,
}));

// settings 模块返回默认设置（body 默认 private）
vi.mock('./settings', () => ({
  loadSettings: async () => ({ bills: 'shared', planner: 'private', body: 'private' }),
}));

beforeEach(() => {
  calls.length = 0;
  fakeClient.getFileContents.mockClear();
  fakeClient.putFileContents.mockClear();
});

describe('body 数据层', () => {
  it('loadWeights 读取 personal/{username}/body/weights.json', async () => {
    const { loadWeights } = await import('./body');
    const list = await loadWeights();
    expect(calls.some((c) => c.method === 'get' && c.path === 'personal/wb-personal/body/weights.json')).toBe(true);
    expect(list).toHaveLength(1);
    expect(list[0].kg).toBe(79);
  });

  it('saveWeights 只 PUT 目标文件', async () => {
    const { saveWeights } = await import('./body');
    await saveWeights([{ id: 'w1', date: '2026-08-03', kg: 80, createdAt: 1, updatedAt: 1, deleted: false }]);
    expect(calls).toEqual([
      { method: 'put', path: 'personal/wb-personal/body/weights.json' },
    ]);
  });

  it('loadProfile 404 时返回 null（fallback）', async () => {
    const { loadProfile } = await import('./body');
    expect(await loadProfile()).toBeNull();
  });

  it('saveProfile 写入 profile.json', async () => {
    const { saveProfile } = await import('./body');
    await saveProfile({ heightCm: 182, weightKg: 79, age: 22, sex: 'male', activity: 1.55, updatedAt: 1 });
    expect(calls.some((c) => c.method === 'put' && c.path === 'personal/wb-personal/body/profile.json')).toBe(true);
  });

  it('saveFoodLogs refuses writes without a preceding snapshot', async () => {
    const { saveFoodLogs } = await import('./body');
    await expect(saveFoodLogs([])).rejects.toThrow('快照');
    expect(calls.some(c => c.method === 'put')).toBe(false);
  });

  it('未绑定（getConfig null）时读写安全返回', async () => {
    mockGetConfig.mockReturnValueOnce(null as unknown as { url: string; username: string; password: string });
    const { loadWeights, saveWeights } = await import('./body');
    expect(await loadWeights()).toEqual([]);
    await expect(saveWeights([])).resolves.toBeUndefined();
  });
});
