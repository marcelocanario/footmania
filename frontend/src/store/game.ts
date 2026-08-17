import { create } from "zustand";
import { api, type DayResult, type Snapshot, type User } from "../api/client";

interface GameState {
  user: User | null;
  saveId: number | null;
  snapshot: Snapshot | null;
  dayResult: DayResult | null;
  loading: boolean;
  error: string | null;
  liveMatchId: number | null;
  setUser: (user: User | null) => void;
  enterSave: (saveId: number) => void;
  loadSave: (saveId: number) => Promise<boolean>;
  refresh: () => Promise<void>;
  advance: () => Promise<DayResult | null>;
  setDayResult: (result: DayResult | null) => void;
  setLiveMatch: (id: number | null) => void;
  checkLiveMatch: () => Promise<number | null>;
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
  liveMatchId: null,

  setUser: (user) => set({ user }),

  enterSave: (saveId) => {
    persistSaveId(saveId);
    set({ saveId, dayResult: null, liveMatchId: null });
  },

  loadSave: async (saveId) => {
    persistSaveId(saveId);
    set({ loading: true, error: null, saveId, dayResult: null, liveMatchId: null });
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
      // A pending result means a live match is now (or already was) running.
      const nextLive = result.matchPending ? (result.humanMatch?.id ?? get().liveMatchId) : null;
      set({ dayResult: result, liveMatchId: nextLive });
      await get().refresh();
      return result;
    } catch (e) {
      set({ error: (e as Error).message });
      return null;
    }
  },

  setDayResult: (result) => set({ dayResult: result }),

  setLiveMatch: (id) => set({ liveMatchId: id }),

  checkLiveMatch: async () => {
    const { saveId } = get();
    if (!saveId) return null;
    try {
      const res = await api.liveMatchInfo(saveId);
      const id = res.match?.id ?? null;
      set({ liveMatchId: id });
      return id;
    } catch {
      return null;
    }
  },

  clear: () => {
    persistSaveId(null);
    set({ saveId: null, snapshot: null, dayResult: null, liveMatchId: null });
  },
}));
