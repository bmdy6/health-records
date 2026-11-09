import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebDavConfig } from './webdav';

const env = vi.hoisted(() => ({
  config: { url: 'https://fixture-a.invalid/', username: 'fixture-a', password: 'test-only' } as WebDavConfig | null,
  revision: 0,
  reads: [] as string[], writes: [] as { user: string; path: string }[],
  get: vi.fn<(...args: string[]) => Promise<string>>(),
  put: vi.fn<() => Promise<void>>(),
}));
vi.mock('./webdav', () => ({
  getConfig: () => env.config,
  getConfigRevision: () => env.revision,
  createDavClient: (config: WebDavConfig) => ({
    getFileContents: async (path: string) => { env.reads.push(config.username); return env.get(path, config.username); },
    putFileContents: async (path: string) => { env.writes.push({ user: config.username, path }); await env.put(); },
  }),
}));
const profile = { heightCm: 175, weightKg: 70, age: 28, sex: 'male' as const, activity: 1.375 as const, updatedAt: 1 };
function access() {
  const config = { ...env.config! }, revision = env.revision;
  return { config, revision, isCurrent: () => env.revision === revision };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
beforeEach(() => {
  vi.resetModules();
  env.config = { url: 'https://fixture-a.invalid/', username: 'fixture-a', password: 'test-only' };
  env.revision = 0; env.reads = []; env.writes = [];
  env.get.mockReset().mockImplementation(async (path) => JSON.stringify(path.endsWith('_settings.json') ? { body: 'private' } : profile));
  env.put.mockReset().mockResolvedValue(undefined);
});
describe('profile binding access', () => {
  it('does not start a PUT after the binding changes while settings are pending', async () => {
    const wait = deferred<string>(); env.get.mockReturnValueOnce(wait.promise);
    const { saveProfile } = await import('./body');
    const pending = saveProfile(profile, access());
    const rejected = expect(pending).rejects.toThrow('取消');
    env.config = { url: 'https://fixture-b.invalid/', username: 'fixture-b', password: 'test-only' }; env.revision++;
    wait.resolve('{"body":"private"}'); await rejected;
    expect(env.writes).toEqual([]);
  });
  it('does not read a profile after clear and rebind to identical credentials', async () => {
    const wait = deferred<string>(); env.get.mockReturnValueOnce(wait.promise);
    const { loadProfile } = await import('./body');
    const pending = loadProfile(access()); const rejected = expect(pending).rejects.toThrow('取消');
    env.revision += 2; wait.resolve('{"body":"private"}'); await rejected;
    expect(env.reads).toEqual(['fixture-a']);
  });
  it('rejects a strict settings failure without writing to a default private directory', async () => {
    env.get.mockRejectedValueOnce(new Error('network'));
    const { saveProfile } = await import('./body');
    await expect(saveProfile(profile, access())).rejects.toThrow();
    expect(env.writes).toEqual([]);
  });
  it('rejects a strict profile read failure instead of treating it as a missing profile', async () => {
    env.get.mockImplementation(async (path) => { if (path.endsWith('profile.json')) throw new Error('network'); return '{}'; });
    const { loadProfile } = await import('./body');
    await expect(loadProfile(access())).rejects.toThrow('network');
  });
  it('retains null for a genuinely missing strict profile', async () => {
    env.get.mockImplementation(async (path) => { if (path.endsWith('profile.json')) throw Object.assign(new Error('missing'), { status: 404 }); return '{}'; });
    const { loadProfile } = await import('./body');
    expect(await loadProfile(access())).toBeNull();
  });
  it('uses the original client for a PUT that has already started', async () => {
    const wait = deferred<void>(); env.put.mockReturnValueOnce(wait.promise);
    const { saveProfile } = await import('./body'); const pending = saveProfile(profile, access());
    await vi.waitFor(() => expect(env.writes).toHaveLength(1));
    env.config = { url: 'https://fixture-b.invalid/', username: 'fixture-b', password: 'test-only' }; env.revision++;
    wait.resolve(); await pending;
    expect(env.writes).toEqual([{ user: 'fixture-a', path: 'personal/fixture-a/body/profile.json' }]);
  });
});
describe('settings cache binding isolation', () => {
  it('reads each explicit binding instead of sharing the first configuration cache', async () => {
    env.get.mockImplementation(async (_path, user) => JSON.stringify({ body: user === 'fixture-a' ? 'private' : 'shared' }));
    const { loadSettings } = await import('./settings');
    expect((await loadSettings(env.config!, true)).body).toBe('private');
    expect((await loadSettings({ url: 'https://fixture-b.invalid/', username: 'fixture-b', password: 'test-only' }, true)).body).toBe('shared');
    expect(env.reads).toEqual(['fixture-a', 'fixture-b']);
  });
  it('does not reuse a legacy fallback for a strict read', async () => {
    env.get.mockRejectedValue(new Error('network'));
    const { loadSettings } = await import('./settings'); await loadSettings();
    await expect(loadSettings(env.config!, true)).rejects.toThrow('network');
  });
  it('does not let a late failing old binding evict a newer binding cache', async () => {
    let reject!: (error: Error) => void; const wait = new Promise<string>((_r, e) => { reject = e; });
    env.get.mockReturnValueOnce(wait).mockResolvedValue('{}');
    const { loadSettings } = await import('./settings'); const first=loadSettings(env.config!);
    const secondConfig={url:'https://fixture-b.invalid/',username:'fixture-b',password:'test-only'};
    await loadSettings(secondConfig); reject(new Error('late')); await first; await loadSettings(secondConfig);
    expect(env.reads).toEqual(['fixture-a','fixture-b']);
  });
});
