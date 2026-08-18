import { useCallback, useEffect, useMemo, useState } from "react";
import { Wand2, Target } from "lucide-react";
import { api, type LineupView, type LiveState } from "../api/client";
import { useGame } from "../store/game";

const FORMATIONS = [
  { label: "5-4-1", value: 0 },
  { label: "5-4-1 · Wide", value: 1 },
  { label: "5-3-2", value: 2 },
  { label: "4-5-1", value: 3 },
  { label: "4-4-2", value: 4 },
  { label: "4-4-2 · Diamond", value: 5 },
  { label: "4-4-2 · Attacking", value: 6 },
  { label: "4-3-3", value: 7 },
  { label: "4-3-3 · Holding", value: 8 },
  { label: "3-5-2", value: 9 },
  { label: "3-4-3", value: 10 },
  { label: "4-2-3-1", value: 11 },
  { label: "4-2-3-1 · Wide", value: 12 },
];

const SLOT_NAMES: Record<number, string> = {
  1: "GK",
  2: "LB",
  3: "CB",
  4: "CB",
  5: "CB",
  6: "RB",
  7: "CB",
  8: "CB",
  9: "RB",
  10: "LM",
  11: "CDM",
  12: "CM",
  13: "CM",
  14: "CM",
  15: "CAM",
  16: "CM",
  17: "RM",
  18: "ST",
  19: "LW",
  20: "LB",
  21: "CB",
  22: "CB",
  23: "CB",
  24: "CB",
  25: "ST",
};

interface Ed {
  formation: number;
  starters: (number | null)[];
  subs: (number | null)[];
  penaltyTakerId: number | null;
  freeKickTakerId: number | null;
}

interface Props {
  mode: "club" | "match";
  matchId?: number;
  liveState?: LiveState;
  onSaved?: (state?: LiveState) => void;
}

export function LineupPicker({ mode, matchId, liveState, onSaved }: Props) {
  const {} = useGame();
  const [data, setData] = useState<LineupView | null>(null);
  const [ed, setEd] = useState<Ed | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok" | "err" | "idle"; text: string }>({ kind: "idle", text: "" });

  useEffect(() => {
    if (false) return;
    api
      .getLineup()
      .then((res) => {
        setData(res);
        const live = mode === "match" && liveState?.matchId === matchId ? liveState : null;
        const liveOn = live ? (live.humanSide === 0 ? live.homeOn : live.awayOn).map((p) => p.id) : [];
        const liveBench = live ? (live.humanSide === 0 ? live.homeBench : live.awayBench).map((p) => p.id) : [];
        const liveStarters = live ? [...liveOn, ...liveBench.filter((id) => !liveOn.includes(id))].slice(0, 11) : [];
        const starterIds = liveStarters.length === 11 ? liveStarters : res.starters.map((p) => p?.id ?? null);
        const starterSet = new Set(starterIds.filter((id): id is number => id !== null));
        const liveSubs = live
          ? liveBench.filter((id) => !starterSet.has(id)).map((id) => id as number)
          : res.subs.map((p) => p?.id ?? null);
        const penaltyTakerId = res.penaltyTakerId !== null && starterSet.has(res.penaltyTakerId) ? res.penaltyTakerId : null;
        const freeKickTakerId = res.freeKickTakerId !== null && starterSet.has(res.freeKickTakerId) ? res.freeKickTakerId : null;
        setEd({
          formation: res.formation,
          starters: starterIds,
          subs: liveStarters.length === 11 ? liveSubs : res.subs.map((p) => p?.id ?? null),
          penaltyTakerId,
          freeKickTakerId,
        });
      })
      .catch((e) => setStatus({ kind: "err", text: (e as Error).message }));
  }, [mode, matchId, liveState?.matchId]);

  const byId = useMemo(() => {
    const m = new Map<number, { id: number; name: string; position: number; overall: number; injuryDays: number; suspended: boolean }>();
    for (const p of data?.squad ?? []) m.set(p.id, p);
    for (const p of data?.starters ?? []) if (p) m.set(p.id, p);
    for (const p of data?.subs ?? []) if (p) m.set(p.id, p);
    return m;
  }, [data]);

  const save = useCallback(
    async (next: Ed) => {
      if (false) return;
      setSaving(true);
      try {
        const payload = {
          formation: next.formation,
          starters: next.starters.filter((x): x is number => x !== null),
          subs: next.subs.filter((x): x is number => x !== null),
          penaltyTakerId: next.penaltyTakerId,
          freeKickTakerId: next.freeKickTakerId,
        };
        if (mode === "club") {
          await api.setLineup(payload);
          setStatus({ kind: "ok", text: "Saved" });
          onSaved?.();
        } else if (matchId) {
          const res = await api.matchLineup(matchId, payload);
          setStatus({ kind: "ok", text: "Saved" });
          onSaved?.(res.state);
        }
      } catch (e) {
        setStatus({ kind: "err", text: (e as Error).message });
      } finally {
        setSaving(false);
      }
    },
    [mode, matchId, onSaved]
  );

  const commit = (next: Ed) => {
    setEd(next);
    void save(next);
  };

  const swap = (sIdx: number, bIdx: number) => {
    if (!ed) return;
    const starters = ed.starters.slice();
    const subs = ed.subs.slice();
    const sId = starters[sIdx];
    const bId = subs[bIdx];
    starters[sIdx] = bId;
    subs[bIdx] = sId;
    const next: Ed = {
      ...ed,
      starters,
      subs,
      penaltyTakerId: ed.penaltyTakerId !== null && starters.includes(ed.penaltyTakerId) ? ed.penaltyTakerId : null,
      freeKickTakerId: ed.freeKickTakerId !== null && starters.includes(ed.freeKickTakerId) ? ed.freeKickTakerId : null,
    };
    commit(next);
  };

  const setBenchSlot = (bIdx: number, id: number | null) => {
    if (!ed) return;
    const starters = ed.starters.slice();
    const subs = ed.subs.slice();
    const prevId = subs[bIdx];
    if (id !== null) {
      const inStarters = starters.indexOf(id);
      if (inStarters >= 0) starters[inStarters] = prevId;
      const inSubs = subs.indexOf(id);
      if (inSubs >= 0 && inSubs !== bIdx) subs[inSubs] = prevId;
    }
    subs[bIdx] = id;
    const next: Ed = {
      ...ed,
      starters,
      subs,
      penaltyTakerId: ed.penaltyTakerId !== null && starters.includes(ed.penaltyTakerId) ? ed.penaltyTakerId : null,
      freeKickTakerId: ed.freeKickTakerId !== null && starters.includes(ed.freeKickTakerId) ? ed.freeKickTakerId : null,
    };
    commit(next);
  };

  const changeFormation = async (formation: number) => {
    if (false) return;
    setSaving(true);
    try {
      const res = await api.getLineup(true, formation);
      if (mode === "match" && ed) {
        // During a live match, changing shape must not replace the current
        // XI with the club's saved XI (which may contain subbed-off players).
        setData((prev) => (prev ? { ...prev, formation, slots: res.slots } : res));
        commit({ ...ed, formation });
        return;
      }
      setData(res);
      const next: Ed = {
        formation,
        starters: res.starters.map((p) => p?.id ?? null),
        subs: res.subs.map((p) => p?.id ?? null),
        penaltyTakerId: res.penaltyTakerId,
        freeKickTakerId: res.freeKickTakerId,
      };
      commit(next);
    } catch (e) {
      setStatus({ kind: "err", text: (e as Error).message });
    } finally {
      setSaving(false);
    }
  };

  const autoFill = async () => {
    if (false) return;
    if (mode === "match" && liveState?.phase === "halftime") {
      setStatus({ kind: "err", text: "Auto lineup is unavailable at halftime; choose players manually." });
      return;
    }
    setSaving(true);
    try {
      const res = await api.getLineup(true, ed?.formation);
      setData(res);
      const next: Ed = {
        formation: ed?.formation ?? res.formation,
        starters: res.starters.map((p) => p?.id ?? null),
        subs: res.subs.map((p) => p?.id ?? null),
        penaltyTakerId: res.penaltyTakerId,
        freeKickTakerId: res.freeKickTakerId,
      };
      commit(next);
    } catch (e) {
      setStatus({ kind: "err", text: (e as Error).message });
    } finally {
      setSaving(false);
    }
  };

  const setTaker = (key: "penaltyTakerId" | "freeKickTakerId", id: number | null) => {
    if (!ed) return;
    commit({ ...ed, [key]: id });
  };

  const starters = (ed?.starters ?? []).map((id) => (id !== null ? byId.get(id) ?? null : null));
  const subs = (ed?.subs ?? []).map((id) => (id !== null ? byId.get(id) ?? null : null));
  const slotNames = (data?.slots ?? []).map((s) => SLOT_NAMES[s] ?? `#${s}`);
  const [selStarter, setSelStarter] = useState<number | null>(null);
  const [selBench, setSelBench] = useState<number | null>(null);

  const eligiblePool = (data?.squad ?? []).filter((p) => p.injuryDays === 0 && !p.suspended);
  const starterIds = new Set(ed?.starters.filter((x): x is number => x !== null) ?? []);
  const benchIds = new Set(ed?.subs.filter((x): x is number => x !== null) ?? []);
  const takerOptions = starters
    .filter((p): p is NonNullable<typeof p> => !!p)
    .map((p) => ({ id: p.id, label: `${p.name} (${p.overall})` }));

  if (!data || !ed) {
    return <div className="empty-state" style={{ padding: 24 }}>Loading lineup...</div>;
  }

  const onStarterClick = (i: number) => {
    if (selStarter === i) {
      setSelStarter(null);
      return;
    }
    if (selBench !== null) {
      swap(i, selBench);
      setSelStarter(null);
      setSelBench(null);
      return;
    }
    setSelStarter(i);
  };

  const onBenchClick = (i: number) => {
    if (selBench === i) {
      setSelBench(null);
      return;
    }
    if (selStarter !== null) {
      swap(selStarter, i);
      setSelStarter(null);
      setSelBench(null);
      return;
    }
    setSelBench(i);
  };

  return (
    <div>
      <div className="form-group">
        <label htmlFor={`lu-formation-${mode}`}>Formation</label>
        <select
          id={`lu-formation-${mode}`}
          className="select"
          value={ed.formation}
          disabled={saving}
          onChange={(e) => void changeFormation(Number(e.target.value))}
        >
          {FORMATIONS.map((f) => (
            <option key={f.value} value={f.value}>{f.label}</option>
          ))}
        </select>
      </div>

      <div style={{ display: "flex", gap: 8, margin: "12px 0", flexWrap: "wrap", alignItems: "center" }}>
        <button className="btn sm ghost" onClick={() => void autoFill()} disabled={saving || (mode === "match" && liveState?.phase === "halftime")}>
          <Wand2 size={14} /> Auto lineup
        </button>
        <span style={{ fontSize: "0.82rem", color: status.kind === "err" ? "var(--red-2)" : status.kind === "ok" ? "var(--grass-2)" : "var(--text-3)" }}>
          {saving ? "Saving..." : status.text || "Tap a starter and a bench player to swap them."}
        </span>
      </div>

      <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <div>
          <div className="card-title" style={{ marginBottom: 6 }}>Starting eleven</div>
          <div className="sub-list" style={{ maxHeight: 420 }}>
            {starters.map((p, i) => (
              <button
                key={`s${i}`}
                className={`sub-row${selStarter === i ? " sel" : ""}`}
                onClick={() => onStarterClick(i)}
                disabled={!p}
              >
                <span className="pos-tag" style={{ minWidth: 44 }}>{slotNames[i] ?? i + 1}</span>
                {p ? (
                  <>
                    <span style={{ flex: 1, textAlign: "left" }}>{p.name}</span>
                    <span style={{ color: "var(--text-3)" }}>{p.overall}</span>
                  </>
                ) : (
                  <span style={{ color: "var(--text-3)" }}>— empty —</span>
                )}
              </button>
            ))}
          </div>
        </div>
        <div>
          <div className="card-title" style={{ marginBottom: 6 }}>Bench</div>
          <div className="sub-list" style={{ maxHeight: 420 }}>
            {subs.map((p, i) => (
              <div key={`b${i}`} className="lu-row" style={{ marginBottom: 6 }}>
                <span className="pos-tag" style={{ minWidth: 30 }}>{i + 1}</span>
                <button
                  className={`sub-row${selBench === i ? " sel" : ""}`}
                  style={{ flex: 1 }}
                  onClick={() => onBenchClick(i)}
                  disabled={!p}
                >
                  {p ? (
                    <>
                      <span style={{ flex: 1, textAlign: "left" }}>{p.name}</span>
                      <span style={{ color: "var(--text-3)" }}>{p.overall}</span>
                    </>
                  ) : (
                    <span style={{ color: "var(--text-3)" }}>— empty —</span>
                  )}
                </button>
                <select
                  className="select"
                  style={{ maxWidth: 34, padding: "8px 4px", fontSize: "0.8rem" }}
                  value=""
                  disabled={saving}
                  onChange={(e) => {
                    const id = e.target.value ? Number(e.target.value) : null;
                    setBenchSlot(i, id);
                  }}
                  title="Pick any squad player for this bench slot"
                >
                  <option value="">⇄</option>
                  {eligiblePool
                    .filter((q) => !starterIds.has(q.id) && !(benchIds.has(q.id) && q.id !== subs[i]?.id))
                    .map((q) => (
                      <option key={q.id} value={q.id}>{q.name} ({q.overall})</option>
                    ))}
                </select>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 14 }}>
        <div className="form-group">
          <label htmlFor={`lu-pen-${mode}`}><Target size={12} /> Penalty taker</label>
          <select
            id={`lu-pen-${mode}`}
            className="select"
            value={ed.penaltyTakerId ?? ""}
            disabled={saving}
            onChange={(e) => setTaker("penaltyTakerId", e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">— choose —</option>
            {takerOptions.map((o) => (
              <option key={o.id} value={o.id}>{o.label}</option>
            ))}
          </select>
        </div>
        <div className="form-group">
          <label htmlFor={`lu-fk-${mode}`}>Free kick taker</label>
          <select
            id={`lu-fk-${mode}`}
            className="select"
            value={ed.freeKickTakerId ?? ""}
            disabled={saving}
            onChange={(e) => setTaker("freeKickTakerId", e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">— choose —</option>
            {takerOptions.map((o) => (
              <option key={o.id} value={o.id}>{o.label}</option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}
