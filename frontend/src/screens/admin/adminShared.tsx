import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";

export interface TabProps {
  /** Bumped by the shell after every successful action so mounted tabs refetch. */
  version: number;
  notify: (severity: "success" | "error" | "warn" | "info", summary: string, detail?: string) => void;
}

/** Return shape of {@link useAdminFetch}, reusable when a fetch is lifted to a
 * parent and handed down as a prop (e.g. Admin.tsx sharing its scheduler-clock
 * fetch with OverviewTab instead of each independently calling the API). */
export interface AdminFetchResult<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/** Fetches admin data on mount, whenever `deps` change, and whenever `reload()` is called. */
export function useAdminFetch<T>(fetcher: () => Promise<T>, deps: unknown[]): AdminFetchResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    fetcher()
      .then((result) => {
        if (!active) return;
        setData(result);
        setError(null);
      })
      .catch((e) => {
        if (active) setError((e as Error).message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, loading, error, reload };
}

/** Standard card header used by every admin section. */
export function AdminCard({ icon, title, subtitle, children }: { icon?: ReactNode; title: string; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <div className="card" style={{ padding: 20 }}>
      <h2 className="card-title">{icon} {title}</h2>
      {subtitle && <div style={{ color: "var(--text-2)", fontSize: "0.88rem", margin: "-6px 0 14px", lineHeight: 1.5 }}>{subtitle}</div>}
      {children}
    </div>
  );
}
