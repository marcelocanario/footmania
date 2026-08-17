import { create } from "zustand";
import { api } from "../api/client";

const KEY = "footmania:matchDurationMinutes";

function read(): number {
  try {
    const raw = window.localStorage.getItem(KEY);
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n >= 1 && n <= 60 ? Math.round(n) : 10;
  } catch {
    return 10;
  }
}

function write(n: number) {
  try {
    window.localStorage.setItem(KEY, String(n));
  } catch {
    /* ignore */
  }
}

interface SettingsState {
  matchDurationMinutes: number;
  loading: boolean;
  load: () => Promise<void>;
  setMatchDurationMinutes: (n: number) => Promise<void>;
}

export const useSettings = create<SettingsState>((set) => ({
  matchDurationMinutes: typeof window !== "undefined" ? read() : 10,
  loading: false,

  load: async () => {
    set({ loading: true });
    try {
      const res = await api.settings();
      const n = Math.round(res.humanMatchDurationMinutes);
      if (Number.isFinite(n) && n >= 1 && n <= 60) {
        write(n);
        set({ matchDurationMinutes: n });
      }
    } catch {
      /* keep local value */
    } finally {
      set({ loading: false });
    }
  },

  setMatchDurationMinutes: async (n) => {
    const clamped = Math.max(1, Math.min(60, Math.round(n)));
    write(clamped);
    set({ matchDurationMinutes: clamped });
    try {
      await api.updateSettings(clamped);
    } catch {
      /* server may reject; keep local value */
    }
  },
}));
