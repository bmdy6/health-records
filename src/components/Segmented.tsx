interface SegmentedProps<T extends string> {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}

// iOS 风格分段控件（全站 tab / 共享切换 / 性别选择统一用）
export default function Segmented<T extends string>({ options, value, onChange }: SegmentedProps<T>) {
  return (
    <div className="flex rounded-lg bg-neutral-100 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={`flex-1 rounded-md py-1.5 text-sm transition ${
            value === o.value ? 'bg-white font-medium text-neutral-900 shadow-sm' : 'text-neutral-500'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
