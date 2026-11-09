// 本地日期 helper 单测（定稿批次 3 场景 1）
// 场景1 需要固定时区验证「本地当天 ≠ UTC 当天」：用 vi.stubEnv 临时切到 Asia/Shanghai（测试结束自动还原）
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addMonths, lastDayOfMonth, localDateOfTs, localToday } from './date';

// 2026-08-06T16:30:00Z = 北京时间 2026-08-07 00:30（UTC+8 凌晨）
const UTC_EARLY = Date.parse('2026-08-06T16:30:00Z');

beforeEach(() => {
  vi.stubEnv('TZ', 'Asia/Shanghai');
});

describe('localDateOfTs / localToday', () => {
  it('场景1: UTC+8 凌晨本地当天（本地时区，不含 toISOString 的 UTC 偏移）', () => {
    // 本地日期 = 08-07，而 toISOString() 会给 08-06 —— 断言不含 UTC 偏移
    expect(localDateOfTs(UTC_EARLY)).toBe('2026-08-07');
    expect(localDateOfTs(UTC_EARLY)).not.toBe('2026-08-06');
    vi.useFakeTimers();
    vi.setSystemTime(UTC_EARLY);
    expect(localToday()).toBe('2026-08-07');
    vi.useRealTimers();
  });

  it('本地午夜边界：跨零点算新的一天', () => {
    // 08-07 23:59:59 +08 → 仍是 08-07；08-08 00:00 +08 → 已是 08-08
    expect(localDateOfTs(Date.parse('2026-08-07T15:59:59Z'))).toBe('2026-08-07');
    expect(localDateOfTs(Date.parse('2026-08-07T16:00:00Z'))).toBe('2026-08-08');
  });
});

describe('addMonths', () => {
  it('常规加月', () => {
    expect(addMonths('2026-08', 1)).toBe('2026-09');
  });

  it('跨年加月', () => {
    expect(addMonths('2026-12', 3)).toBe('2027-03');
  });

  it('负数减月（跨年）', () => {
    expect(addMonths('2026-01', -1)).toBe('2025-12');
  });
});

describe('lastDayOfMonth', () => {
  it('31 天月', () => {
    expect(lastDayOfMonth('2026-08')).toBe('2026-08-31');
  });

  it('30 天月', () => {
    expect(lastDayOfMonth('2026-04')).toBe('2026-04-30');
  });

  it('2 月平年 28 天 / 闰年 29 天', () => {
    expect(lastDayOfMonth('2026-02')).toBe('2026-02-28');
    expect(lastDayOfMonth('2028-02')).toBe('2028-02-29');
  });
});
