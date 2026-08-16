import type { ReactNode } from "react";

export interface SegItem<T extends string | number> {
  value: T;
  label: string;
  icon?: ReactNode;
  count?: number;
}

export function Segmented<T extends string | number>({
  items,
  value,
  onChange,
  className,
}: {
  items: SegItem<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div className={`segmented${className ? ` ${className}` : ""}`} role="tablist">
      {items.map((item) => (
        <button
          key={item.value}
          role="tab"
          aria-selected={item.value === value}
          className={item.value === value ? "active" : ""}
          onClick={() => onChange(item.value)}
        >
          {item.icon}
          {item.label}
          {item.count !== undefined && <span className="count">{item.count}</span>}
        </button>
      ))}
    </div>
  );
}
