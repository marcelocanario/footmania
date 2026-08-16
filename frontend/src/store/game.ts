import { create } from "zustand";
import { api, type DayResult, type Snapshot, type User } from "../api/client";

interface GameState {
  user: User | null;
  saveId: number | null;
  snapshot: Snapshot | null;
  dayResult: DayResult | null;
  loading: boolean;
  error: string | null;
  setUser: (user: User | null) => void;
  enterSave: (saveId: number) => void;
  loadSave: (saveId: number) => Promise<boolean>;
  refresh: () => Promise<void>;
  advance: () => Promise<DayResult | null>;
  setDayResult: (result: DayResult | null) => void;
  clear: () => void;
}

const SAVE_KEY = "footmania:saveId";

function readSaveId(): number | null {
  try {
    const raw = window.localStorage.getItem(SAVE_KEY);
    const id = raw ? Number(raw) : null;
    return id && Number.isFinite(id) ? id : null;
  } catch {
    return null;
  }
}

function persistSaveId(id: number | null) {
  try {
    if (id === null) window.localStorage.removeItem(SAVE_KEY);
    else window.localStorage.setItem(SAVE_KEY, String(id));
  } catch {
    /* ignore */
  }
}

export const useGame = create<GameState>((set, get) => ({
  user: null,
  saveId: readSaveId(),
  snapshot: null,
  dayResult: null,
  loading: false,
  error: null,

  setUser: (user) => set({ user }),

  enterSave: (saveId) => {
    persistSaveId(saveId);
    set({ saveId, dayResult: null });
  },

  loadSave: async (saveId) => {
    persistSaveId(saveId);
    set({ loading: true, error: null, saveId, dayResult: null });
    try {
      const res = await api.saveState(saveId);
      if (!res.started) {
        set({ loading: false });
        return false;
      }
      set({ snapshot: res.snapshot ?? null, loading: false });
      return true;
    } catch (e) {
      set({ error: (e as Error).message, loading: false });
      return false;
    }
  },

  refresh: async () => {
    const { saveId } = get();
    if (!saveId) return;
    try {
      const res = await api.saveState(saveId);
      if (res.started) set({ snapshot: res.snapshot ?? null });
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  advance: async () => {
    const { saveId } = get();
    if (!saveId) return null;
    try {
      const result = await api.advance(saveId);
      set({ dayResult: result });
      await get().refresh();
      return result;
    } catch (e) {
      set({ error: (e as Error).message });
      return null;
    }
  },

  setDayResult: (result) => set({ dayResult: result }),

  clear: () => {
    persistSaveId(null);
    set({ saveId: null, snapshot: null, dayResult: null });
  },
}));
