import { useEffect, useState } from 'react';

// 轻量 Toast：删除/操作反馈（含 undo）
interface ToastData {
  text: string;
  undo?: () => void;
}

export function useToast() {
  const [toast, setToast] = useState<ToastData | null>(null);

  const show = (data: ToastData) => {
    setToast(data);
  };

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  const el = toast ? (
    <div className="fixed left-1/2 top-4 z-50 flex -translate-x-1/2 items-center gap-3 rounded-full bg-neutral-900 px-4 py-2.5 text-sm text-white shadow-lg">
      <span>{toast.text}</span>
      {toast.undo && (
        <button onClick={() => { toast.undo?.(); setToast(null); }} className="font-medium underline underline-offset-2">
          撤销
        </button>
      )}
    </div>
  ) : null;

  return { toastEl: el, showToast: show };
}
