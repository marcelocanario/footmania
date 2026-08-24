import { create } from "zustand";
import { api } from "../api/client";

const KEY = "footmania:matchDurationMinutes";

function read(): number {
  try {
    const raw = window.localStorage.getItem(KEY);
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n >= 1 && n <= 60 ? Math.round(n) : 30;
  } catch {
    return 30;
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
  maxContractSeasons: number;
  pregameWindowMinutes: number;
  loading: boolean;
  load: () => Promise<void>;
}

export const useSettings = create<SettingsState>((set) => ({
  matchDurationMinutes: typeof window !== "undefined" ? read() : 30,
  maxContractSeasons: 5,
  pregameWindowMinutes: 60,
  loading: false,

  load: async () => {
    set({ loading: true });
    try {
      const res = await api.settings();
      // Matches are paced by the server clock; the value is display-only.
      const n = Math.round(res.matchDurationMinutes);
      if (Number.isFinite(n) && n >= 1 && n <= 60) {
        write(n);
        set({ matchDurationMinutes: n });
      }
      const maxSeasons = Math.round(res.maxContractSeasons ?? 5);
      if (Number.isFinite(maxSeasons) && maxSeasons >= 1) {
        set({ maxContractSeasons: maxSeasons });
      }
      const pregameWindow = Math.round(res.pregameWindowMinutes ?? 60);
      if (Number.isFinite(pregameWindow) && pregameWindow >= 0) {
        set({ pregameWindowMinutes: pregameWindow });
      }
    } catch {
      /* keep local value */
    } finally {
      set({ loading: false });
    }
  },
}));
