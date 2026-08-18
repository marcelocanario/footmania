import { create } from "zustand";
import { api, type MpStatus, type Snapshot, type User } from "../api/client";

interface GameState {
  user: User | null;
  status: MpStatus | null;
  snapshot: Snapshot | null;
  loading: boolean;
  error: string | null;
  liveMatchId: number | null;
  setUser: (user: User | null) => void;
  loadStatus: () => Promise<MpStatus | null>;
  loadClub: () => Promise<boolean>;
  refresh: () => Promise<void>;
  setLiveMatch: (id: number | null) => void;
  checkLiveMatch: () => Promise<number | null>;
  clear: () => void;
}

export const useGame = create<GameState>((set) => ({
  user: null,
  status: null,
  snapshot: null,
  loading: false,
  error: null,
  liveMatchId: null,

  setUser: (user) => set({ user }),

  loadStatus: async () => {
    set({ loading: true, error: null });
    try {
      const status = await api.mpStatus();
      set({ status, loading: false });
      return status;
    } catch (e) {
      set({ error: (e as Error).message, loading: false });
      return null;
    }
  },

  loadClub: async () => {
    set({ loading: true, error: null });
    try {
      const res = await api.myClub();
      set({ snapshot: res.snapshot, loading: false });
      return true;
    } catch (e) {
      set({ error: (e as Error).message, loading: false, snapshot: null });
      return false;
    }
  },

  refresh: async () => {
    try {
      const status = await api.mpStatus();
      set({ status });
      const res = await api.myClub();
      set({ snapshot: res.snapshot });
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  setLiveMatch: (id) => set({ liveMatchId: id }),

  checkLiveMatch: async () => {
    try {
      const res = await api.liveMatchInfo();
      const id = res.match?.id ?? null;
      set({ liveMatchId: id });
      return id;
    } catch {
      return null;
    }
  },

  clear: () => set({ status: null, snapshot: null, liveMatchId: null, error: null }),
}));
