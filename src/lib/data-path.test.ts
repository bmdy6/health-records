// 数据路径解析单测（方案批次 1 安全网）
import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS, personalDir, moduleDir, SHARED_BILLS_DIR } from './data-path';

describe('DEFAULT_SETTINGS', () => {
  it('bills 共享、planner/body 独立', () => {
    expect(DEFAULT_SETTINGS).toEqual({ bills: 'shared', planner: 'private', body: 'private' });
  });
});

describe('personalDir', () => {
  it('返回 personal/{username}', () => {
    expect(personalDir('wb-personal')).toBe('personal/wb-personal');
  });
});

describe('moduleDir', () => {
  const username = 'wb-personal';

  it('bills 固定共享 → bills（不加 module 子目录）', () => {
    expect(moduleDir('bills', username, DEFAULT_SETTINGS)).toBe(SHARED_BILLS_DIR);
  });

  it('shared 模块 → bills/{module}', () => {
    expect(moduleDir('planner', username, { ...DEFAULT_SETTINGS, planner: 'shared' })).toBe('bills/planner');
    expect(moduleDir('body', username, { ...DEFAULT_SETTINGS, body: 'shared' })).toBe('bills/body');
  });

  it('private 模块 → personal/{username}/{module}', () => {
    expect(moduleDir('planner', username, DEFAULT_SETTINGS)).toBe('personal/wb-personal/planner');
    expect(moduleDir('body', username, DEFAULT_SETTINGS)).toBe('personal/wb-personal/body');
  });

  it('用户名不合法时抛出（拒绝路径穿越）', () => {
    expect(() => personalDir('../evil')).toThrow();
    expect(() => personalDir('a/b')).toThrow();
    expect(() => personalDir('')).toThrow();
  });

  it('合法用户名正常通过', () => {
    expect(personalDir('wb-personal')).toBe('personal/wb-personal');
    expect(personalDir('shared-viewer')).toBe('personal/shared-viewer');
  });
});
