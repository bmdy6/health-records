import { useEffect, useRef, useState } from 'react';
import { getConfigRevision } from '../../lib/webdav';
import { createHealthWriter } from './health-writer';

export function useHealthWriter<Request, Result>(onPendingChange?: (pending:boolean)=>void) {
  const writer = useRef(createHealthWriter<Request, Result>());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [, render] = useState(0);
  const mounted = useRef(true);
  const revision = useRef(getConfigRevision());
  const current = () => mounted.current && getConfigRevision() === revision.current;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const locked = busy || writer.current.hasPending();
  useEffect(() => { onPendingChange?.(locked); }, [locked, onPendingChange]);
  useEffect(() => () => { onPendingChange?.(false); }, [onPendingChange]);
  const save = async (make: () => Request, write: (request: Request) => Promise<Result>, confirmed: (value: Result) => void) => {
    if (!current() || writer.current.isSaving()) return;
    setBusy(true); setError('');
    try {
      const result = await writer.current.run(make, write);
      if (current() && result.kind === 'saved') confirmed(result.value);
    } catch (cause) {
      if (current()) setError(`${cause instanceof Error ? cause.message : '保存失败'}。${writer.current.hasPending() ? '原草稿已保留，请重试核对；放弃草稿不会撤销可能已保存的记录。' : '请检查填写内容。'}`);
    } finally { if (current()) { setBusy(false); render(n => n + 1); } }
  };
  return { busy, error, locked, save,
    discard() { if (writer.current.discard()) { setError(''); render(n => n + 1); } } };
}
