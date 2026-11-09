// 同步状态指示：保存中… / 已同步 / 失败可重试（Linear 式 Saving/Saved）
interface SyncStatusProps {
  state: 'idle' | 'saving' | 'saved' | 'error';
  onRetry?: () => void;
}

export default function SyncStatus({ state, onRetry }: SyncStatusProps) {
  if (state === 'idle') return null;
  const map = {
    saving: { dot: 'bg-neutral-400', text: '保存中…' },
    saved: { dot: 'bg-neutral-900', text: '已同步' },
    error: { dot: 'bg-neutral-900', text: '同步失败' },
  } as const;
  const m = map[state];
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-neutral-400">
      <span className={`h-1.5 w-1.5 rounded-full ${m.dot}`} />
      {state === 'error' && onRetry ? (
        <button onClick={onRetry} className="underline underline-offset-2">
          {m.text} · 点重试
        </button>
      ) : (
        m.text
      )}
    </span>
  );
}
