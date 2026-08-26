import { create } from "zustand";
import { api } from "../api/client";

const KEY = "footmania:matchDurationMinutes";
const SOUND_MUTED_KEY = "footmania:soundMuted";

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

// Client-only preference (never sent to the server): match-viewer sounds.
function readSoundMuted(): boolean {
  try {
    return window.localStorage.getItem(SOUND_MUTED_KEY) === "true";
  } catch {
    return false;
  }
}

function writeSoundMuted(muted: boolean) {
  try {
    window.localStorage.setItem(SOUND_MUTED_KEY, String(muted));
  } catch {
    /* ignore */
  }
}

interface SettingsState {
  matchDurationMinutes: number;
  maxContractSeasons: number;
  pregameWindowMinutes: number;
  /** Senior squad cap. A mandatory age promotion can legally exceed it. */
  seniorSquadLimit: number;
  academyVoluntaryPromotionAge: number;
  academyAutomaticPromotionAge: number;
  /** Match-viewer sounds muted; persisted locally, survives sessions/matches. */
  soundMuted: boolean;
  loading: boolean;
  load: () => Promise<void>;
  toggleSoundMuted: () => void;
}

export const useSettings = create<SettingsState>((set) => ({
  matchDurationMinutes: typeof window !== "undefined" ? read() : 30,
  maxContractSeasons: 5,
  pregameWindowMinutes: 60,
  seniorSquadLimit: 35,
  academyVoluntaryPromotionAge: 18,
  academyAutomaticPromotionAge: 20,
  soundMuted: typeof window !== "undefined" ? readSoundMuted() : false,
  loading: false,

  toggleSoundMuted: () =>
    set((s) => {
      const soundMuted = !s.soundMuted;
      writeSoundMuted(soundMuted);
      return { soundMuted };
    }),

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
      const squadLimit = Math.round(res.seniorSquadLimit ?? 35);
      if (Number.isFinite(squadLimit) && squadLimit >= 11) set({ seniorSquadLimit: squadLimit });
      const voluntaryAge = Math.round(res.academyVoluntaryPromotionAge ?? 18);
      const automaticAge = Math.round(res.academyAutomaticPromotionAge ?? 20);
      if (Number.isFinite(voluntaryAge) && Number.isFinite(automaticAge) && voluntaryAge < automaticAge) {
        set({ academyVoluntaryPromotionAge: voluntaryAge, academyAutomaticPromotionAge: automaticAge });
      }
    } catch {
      /* keep local value */
    } finally {
      set({ loading: false });
    }
  },
}));
