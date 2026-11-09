// WebDAV 客户端封装单测（方案批次 1 安全网）
import { describe, it, expect, vi, beforeEach } from 'vitest';

const CFG = { url: 'https://dav.example.com/webdav/wb/', username: 'u-test', password: 'test-password' };

// 内存版 localStorage（node 环境没有 localStorage）
function fakeStorage() {
  let store: Record<string, string> = {};
  return {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
    removeItem: (k: string) => {
      delete store[k];
    },
    _reset: () => {
      store = {};
    },
  };
}

const storage = fakeStorage();

beforeEach(() => {
  storage._reset();
  vi.stubGlobal('localStorage', storage);
  vi.resetModules();
});

describe('getConfig / saveConfig / clearConfig', () => {
  it('绑定保存、清除或重新绑定都会递增会话版本', async () => {
    const { getConfigRevision, saveConfig, clearConfig } = await import('./webdav');
    const initial = getConfigRevision();

    saveConfig(CFG);
    expect(getConfigRevision()).toBe(initial + 1);
    clearConfig();
    expect(getConfigRevision()).toBe(initial + 2);
    saveConfig(CFG);
    expect(getConfigRevision()).toBe(initial + 3);
  });

  it('配置变更会通知订阅者，取消订阅后不再通知', async () => {
    const { saveConfig, clearConfig, subscribeConfigChanges } = await import('./webdav');
    const listener = vi.fn();
    const unsubscribe = subscribeConfigChanges(listener);

    saveConfig(CFG);
    clearConfig();
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    saveConfig(CFG);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('未配置时返回 null', async () => {
    const { getConfig } = await import('./webdav');
    expect(getConfig()).toBeNull();
  });

  it('保存后能读回同一配置', async () => {
    const { saveConfig, getConfig } = await import('./webdav');
    saveConfig(CFG);
    expect(getConfig()).toEqual(CFG);
  });

  it('坏 JSON 容错返回 null', async () => {
    storage.setItem('webdav-config', '{broken');
    const { getConfig } = await import('./webdav');
    expect(getConfig()).toBeNull();
  });

  it('localStorage 写入抛错时 saveConfig 抛出（调用方可见失败）', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new DOMException('quota', 'QuotaExceededError');
      },
      removeItem: () => {},
    });
    const { saveConfig } = await import('./webdav');
    expect(() => saveConfig(CFG)).toThrow();
  });

  it('clearConfig 清空配置', async () => {
    const { saveConfig, clearConfig, getConfig } = await import('./webdav');
    saveConfig(CFG);
    clearConfig();
    expect(getConfig()).toBeNull();
  });
});

describe('createDavClient', () => {
  it('用 url/username/password 创建客户端', async () => {
    const { createDavClient } = await import('./webdav');
    expect(createDavClient(CFG)).toBeTruthy();
  });
});
