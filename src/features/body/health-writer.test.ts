import { describe, expect, it, vi } from 'vitest';
import { createHealthWriter, assertRecordedDate } from './health-writer';

describe('confirmed health writes', () => {
  it('keeps the exact original request after a lost receipt', async () => {
    const writer = createHealthWriter<{ id: string; kg: number }, string>();
    const first = { id: 'fixed', kg: 75 };
    const write = vi.fn().mockRejectedValueOnce(new Error('unknown')).mockResolvedValueOnce('saved');
    await expect(writer.run(() => first, write)).rejects.toThrow('unknown');
    expect(writer.hasPending()).toBe(true);
    expect(await writer.run(() => ({ id: 'new', kg: 70 }), write)).toEqual({ kind: 'saved', value: 'saved' });
    expect(write.mock.calls.map(c => c[0])).toEqual([first, first]);
    expect(writer.hasPending()).toBe(false);
  });
  it('blocks adjacent clicks before React has rendered a busy state', async () => {
    let finish!: (value: string) => void;
    const write = vi.fn(() => new Promise<string>(resolve => { finish = resolve; }));
    const writer = createHealthWriter<string, string>();
    const running = writer.run(() => 'once', write);
    expect(await writer.run(() => 'twice', write)).toEqual({ kind: 'busy' });
    expect(write).toHaveBeenCalledTimes(1);
    expect(writer.discard()).toBe(false);
    finish('ok'); await running;
  });
  it('unlocks a definitely rejected input without discarding an uncertain request', async () => {
    const writer = createHealthWriter<string, string>();
    await expect(writer.run(() => 'bad', async () => { throw Object.assign(new Error('bad input'), {code:'input'}); })).rejects.toThrow('bad input');
    expect(writer.hasPending()).toBe(false);
    expect(await writer.run(() => 'valid', async request => request)).toEqual({kind:'saved',value:'valid'});
  });
  it('does not lock invalid form input before a request exists', async () => {
    const writer = createHealthWriter<string, string>();
    await expect(writer.run(() => { throw new Error('invalid'); }, vi.fn())).rejects.toThrow('invalid');
    expect(writer.hasPending()).toBe(false);
    expect(writer.isSaving()).toBe(false);
  });
});

it('rejects future or invalid dates for actual health records', () => {
  expect(() => assertRecordedDate('2026-10-31','2026-10-30')).toThrow();
  expect(() => assertRecordedDate('2026-02-30','2026-10-30')).toThrow();
  expect(() => assertRecordedDate('2026-10-30','2026-10-30')).not.toThrow();
});
