import { createClient, type WebDAVClient } from 'webdav';

export interface WebDavConfig {
  url: string;
  username: string;
  password: string;
}

const STORAGE_KEY = 'webdav-config';
let configRevision = 0;
const configListeners = new Set<() => void>();

function publishConfigChange(): void {
  configRevision += 1;
  configListeners.forEach((listener) => listener());
}

// A revision distinguishes a clear/rebind to the same credentials from one uninterrupted session.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY) publishConfigChange();
  });
}

export function getConfigRevision(): number {
  return configRevision;
}

export function subscribeConfigChanges(listener: () => void): () => void {
  configListeners.add(listener);
  return () => configListeners.delete(listener);
}

export function getConfig(): WebDavConfig | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as WebDavConfig) : null;
  } catch {
    return null;
  }
}

export function saveConfig(cfg: WebDavConfig): void {
  // localStorage 写入失败（如 iPhone 无痕模式 QuotaExceededError）必须抛出，调用方可见失败
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  publishConfigChange();
}

export function clearConfig() {
  localStorage.removeItem(STORAGE_KEY);
  publishConfigChange();
}

export function createDavClient(cfg: WebDavConfig): WebDAVClient {
  return createClient(cfg.url, { username: cfg.username, password: cfg.password });
}
