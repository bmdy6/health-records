// 共享/独立开关配置：存服务器共享文件 /bills/_settings.json（两账号可读写，所有设备自动一致）
import { createDavClient, getConfig, getConfigRevision, type WebDavConfig } from './webdav';
import { DEFAULT_SETTINGS, SHARED_BILLS_DIR } from './data-path';
import type { DataSettings } from '../types';

const SETTINGS_FILE = `${SHARED_BILLS_DIR}/_settings.json`;

// 同一会话内复用同一份读取结果：首屏会由 body/tasks/设置页多处触发读取，
// 不去重会把同一个 _settings.json 请求 4 次。写入后失效，保证本机改完立刻读到新值。
let cachedRead: { config: WebDavConfig; strict: boolean; revision?: number; promise: Promise<DataSettings> } | null = null;

// 指定配置供带绑定快照的操作使用；旧无参调用继续允许默认值回退。
export function loadSettings(config: WebDavConfig | null = getConfig(), strict = false, revision?: number, fresh = false): Promise<DataSettings> {
  if (!config) return Promise.resolve({ ...DEFAULT_SETTINGS });
  const cfg = { ...config };
  const cached = cachedRead;
  if (!fresh && cached && cached.strict === strict && cached.revision === revision && cached.config.url === cfg.url &&
      cached.config.username === cfg.username && cached.config.password === cfg.password) return cached.promise;
  const promise = createDavClient(cfg)
    .getFileContents(SETTINGS_FILE, { format: 'text' })
    .then((text) => {
      const values = JSON.parse(text as string) as Partial<DataSettings>;
      if (strict && (!values || typeof values !== 'object' || Array.isArray(values) ||
          Object.keys(DEFAULT_SETTINGS).some((key) => {
            const value = values[key as keyof DataSettings];
            return value !== undefined && value !== 'shared' && value !== 'private';
          }))) throw new Error('共享设置格式无效');
      return { ...DEFAULT_SETTINGS, ...values };
    })
    .catch((error: unknown) => {
      // 迟到的旧绑定请求不能清除新绑定的缓存。
      if (cachedRead?.promise === promise) cachedRead = null;
      const status = (error as { status?: number; response?: { status?: number } } | null)?.status ??
        (error as { response?: { status?: number } } | null)?.response?.status;
      if (strict && status !== 404) throw error;
      return { ...DEFAULT_SETTINGS };
    });
  cachedRead = { config: cfg, strict, revision, promise };
  return promise;
}

export interface SettingsAccess {
  config: WebDavConfig;
  revision: number;
  isCurrent: () => boolean;
}

export async function saveSettings(settings: DataSettings, access?: SettingsAccess): Promise<void> {
  const current = getConfig();
  if (!current) throw new Error('未绑定账号，无法保存设置');
  const cfg = { ...(access?.config ?? current) };
  const revision = access?.revision ?? getConfigRevision();
  const assertCurrent = () => {
    const bound = getConfig();
    if (getConfigRevision() !== revision || bound?.url !== cfg.url || bound.username !== cfg.username ||
        bound.password !== cfg.password || (access && !access.isCurrent())) throw new Error('账号绑定已变化，请重新加载设置');
  };
  const invalidateRead = () => {
    // 结果不确定也必须重读；但旧账号迟到的回执不能清掉新会话的缓存。
    if (getConfigRevision() === revision && cachedRead?.config.url === cfg.url && cachedRead.config.username === cfg.username &&
        cachedRead.config.password === cfg.password &&
        (cachedRead.revision === undefined || cachedRead.revision === revision)) cachedRead = null;
  };
  assertCurrent();
  invalidateRead();
  try {
    await createDavClient(cfg).putFileContents(SETTINGS_FILE, JSON.stringify(settings, null, 2));
    assertCurrent();
  } finally {
    invalidateRead();
  }
}
