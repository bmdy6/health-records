// 数据路径解析（架构设计 v1.1 + 用户确认：模块级共享/独立开关）
// 共享数据 → 共享目录（两账号可读写）
// 独立数据 → /personal/{username}/（各自空间，服务器已做权限隔离）

import type { DataSettings } from '../types';

export const DEFAULT_SETTINGS: DataSettings = {
  bills: 'shared',
  planner: 'private',
  body: 'private',
};

// 共享账单目录（bills 固定共享）
export const SHARED_BILLS_DIR = 'bills';

// Reserved read-only account cannot access personal health records.
export function isSharedAccount(username: string | undefined): boolean {
  return username === 'shared-viewer';
}

// 独立空间：/personal/{username}/
// 用户名做路径安全校验：只允许 [a-zA-Z0-9_-]，拒绝 ../ 等穿越段
const SAFE_USERNAME = /^[a-zA-Z0-9_-]+$/;

export function personalDir(username: string): string {
  if (!SAFE_USERNAME.test(username)) {
    throw new Error(`非法用户名（路径安全）：${username}`);
  }
  return `personal/${username}`;
}

// 按绑定账号解析模块数据目录
// 共享模块 → 共享区（bills 直接存 /bills/，其他共享模块存 /bills/{module}/）
// 独立模块 → /personal/{username}/{module}/
export function moduleDir(module: keyof DataSettings, username: string, settings: DataSettings): string {
  if (settings[module] === 'shared') {
    return module === 'bills' ? SHARED_BILLS_DIR : `${SHARED_BILLS_DIR}/${module}`;
  }
  return `${personalDir(username)}/${module}`;
}

// 个人账号专属数据目录（不经共享开关；薪资这类个人数据用）
export function privateDir(username: string): string {
  return personalDir(username);
}
