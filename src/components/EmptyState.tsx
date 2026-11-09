import type { ReactNode } from 'react';

interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  hint?: string;
  action?: ReactNode;
}

// 空状态：大留白 + 图标 + 文案 + 可选引导按钮
export default function EmptyState({ icon, title, hint, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center py-12 text-center">
      <div className="text-neutral-300">{icon}</div>
      <div className="mt-3 text-sm text-neutral-500">{title}</div>
      {hint && <div className="mt-1 text-xs text-neutral-400">{hint}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
