// 共享/独立开关配置单测（方案批次 1 安全网）
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DEFAULT_SETTINGS } from './data-path';

const mockGetConfig = vi.fn<() => { url: string; username: string; password: string } | null>(() => ({
  url: 'https://dav.example.com/webdav/wb/',
  username: 'wb-personal',
  password: 'test-password',
}));
const mockGetRevision = vi.fn(() => 0);

const fakeClient = {
  getFileContents: vi.fn(async (_path: string): Promise<string> => {
    throw new Error('404');
  }),
  putFileContents: vi.fn(async (_path: string, _data: string): Promise<void> => {}),
};

vi.mock('./webdav', () => ({
  getConfig: mockGetConfig,
  getConfigRevision: mockGetRevision,
  createDavClient: () => fakeClient,
}));

beforeEach(() => {
  // loadSettings 在模块内缓存读取结果，测试之间需要重置模块状态
  vi.resetModules();
  mockGetConfig.mockClear();
  mockGetRevision.mockReset().mockReturnValue(0);
  mockGetConfig.mockReturnValue({
    url: 'https://dav.example.com/webdav/wb/',
    username: 'wb-personal',
    password: 'test-password',
  });
  fakeClient.getFileContents.mockReset().mockResolvedValue('{}');
  fakeClient.putFileContents.mockReset().mockResolvedValue(undefined);
});

describe('loadSettings', () => {
  it('未绑定时返回 DEFAULT_SETTINGS', async () => {
    mockGetConfig.mockReturnValueOnce(null);
    const { loadSettings } = await import('./settings');
    expect(await loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('读取 bills/_settings.json', async () => {
    const { loadSettings } = await import('./settings');
    await loadSettings();
    expect(fakeClient.getFileContents).toHaveBeenCalledWith('bills/_settings.json', { format: 'text' });
  });

  it('远端部分配置与默认值合并', async () => {
    fakeClient.getFileContents.mockResolvedValueOnce(JSON.stringify({ planner: 'shared' }));
    const { loadSettings } = await import('./settings');
    expect(await loadSettings()).toEqual({ ...DEFAULT_SETTINGS, planner: 'shared' });
  });

  it('坏 JSON 回退默认值', async () => {
    fakeClient.getFileContents.mockResolvedValueOnce('{broken');
    const { loadSettings } = await import('./settings');
    expect(await loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('网络错误回退默认值', async () => {
    fakeClient.getFileContents.mockRejectedValueOnce(new Error('network'));
    const { loadSettings } = await import('./settings');
    expect(await loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('同一会话内重复读取只请求一次', async () => {
    fakeClient.getFileContents.mockResolvedValue(JSON.stringify({ planner: 'shared' }));
    const { loadSettings } = await import('./settings');
    await loadSettings();
    await loadSettings();
    expect(fakeClient.getFileContents).toHaveBeenCalledTimes(1);
  });

  it('读取失败不缓存，下次调用重新请求', async () => {
    fakeClient.getFileContents.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce('{}');
    const { loadSettings } = await import('./settings');
    await loadSettings();
    await loadSettings();
    expect(fakeClient.getFileContents).toHaveBeenCalledTimes(2);
  });
});

describe('saveSettings', () => {
  it('未绑定时拒绝，不把无写入当成功', async () => {
    mockGetConfig.mockReturnValue(null);
    const { saveSettings } = await import('./settings');
    await expect(saveSettings(DEFAULT_SETTINGS)).rejects.toThrow('未绑定账号');
    expect(fakeClient.putFileContents).not.toHaveBeenCalled();
  });

  it('拒绝旧绑定快照和相同凭据重新绑定后的旧版本', async () => {
    const { saveSettings } = await import('./settings');
    const config = mockGetConfig()!;
    const access = { config, revision: 0, isCurrent: () => true };
    mockGetConfig.mockReturnValue({ ...config, username: 'fixture-b' });
    await expect(saveSettings(DEFAULT_SETTINGS, access)).rejects.toThrow('账号绑定已变化');
    mockGetConfig.mockReturnValue(config); mockGetRevision.mockReturnValue(2);
    await expect(saveSettings(DEFAULT_SETTINGS, access)).rejects.toThrow('账号绑定已变化');
    expect(fakeClient.putFileContents).not.toHaveBeenCalled();
  });

  it.each(['offline', '401', '503', 'timeout'])('传播 %s 保存失败并使读缓存失效', async message => {
    const { loadSettings, saveSettings } = await import('./settings');
    await loadSettings();
    fakeClient.putFileContents.mockRejectedValueOnce(new Error(message));
    await expect(saveSettings(DEFAULT_SETTINGS)).rejects.toThrow(message);
    await loadSettings(); expect(fakeClient.getFileContents).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, 2])('旧写入回执不能清掉新绑定版本的读缓存（revision=%s）或报成功', async readRevision => {
    const { loadSettings, saveSettings } = await import('./settings');
    let resolve!: () => void;
    fakeClient.putFileContents.mockReturnValueOnce(new Promise<void>(r => { resolve = r; }));
    const saving = saveSettings(DEFAULT_SETTINGS);
    mockGetRevision.mockReturnValue(2);
    await loadSettings(mockGetConfig(), true, readRevision);
    resolve(); await expect(saving).rejects.toThrow('账号绑定已变化');
    await loadSettings(mockGetConfig(), true, readRevision);
    expect(fakeClient.getFileContents).toHaveBeenCalledTimes(1);
  });

  it('固定写入 bills/_settings.json', async () => {
    const { saveSettings } = await import('./settings');
    await saveSettings({ ...DEFAULT_SETTINGS, bills: 'private' });
    expect(fakeClient.putFileContents).toHaveBeenCalledWith(
      'bills/_settings.json',
      expect.stringContaining('"planner"'),
    );
  });

  it('写入后缓存失效，下次读取重新请求', async () => {
    const { loadSettings, saveSettings } = await import('./settings');
    await loadSettings();
    await saveSettings({ ...DEFAULT_SETTINGS, bills: 'private' });
    await loadSettings();
    expect(fakeClient.getFileContents).toHaveBeenCalledTimes(2);
  });
});


it('fresh strict reads observe another device changing the body directory', async () => {
  const { loadSettings } = await import('./settings');
  const config=mockGetConfig()!;
  fakeClient.getFileContents.mockResolvedValueOnce('{"body":"private"}').mockResolvedValueOnce('{"body":"shared"}');
  expect((await loadSettings(config,true,0)).body).toBe('private');
  expect((await loadSettings(config,true,0,true)).body).toBe('shared');
  expect(fakeClient.getFileContents).toHaveBeenCalledTimes(2);
});
