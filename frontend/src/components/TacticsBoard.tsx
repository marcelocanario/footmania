import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { GripVertical, Target, Wand2 } from "lucide-react";
import { api, type LineupView, type LiveState } from "../api/client";
import { useGame } from "../store/game";
import { kitDotBackground } from "./kit/kitCss";
import { slotPointsForFormation } from "./matchPitchUtils";
import { FORMATIONS } from "../tacticsOptions";

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

interface BoardPlayer {
  id: number;
  name: string;
  position: number;
  tacticalPosition: string;
  overall: number;
  energy: number;
  injuryDays: number;
  suspended: boolean;
}

interface Props {
  mode: "club" | "match";
  matchId?: number;
  liveState?: LiveState;
  onSaved?: (state?: LiveState) => void;
  /** Notified whenever the selected formation changes (initial load or picker), so parents can scope tactic-bound UI. */
  onFormationChange?: (formation: number) => void;
}

type BoardArea = "starter" | "bench" | "pool";

interface BoardLocation {
  area: BoardArea;
  index: number;
  id: number;
}

interface DropLocation {
  area: BoardArea;
  index: number;
  id?: number;
}

interface PendingDrag extends BoardLocation {
  pointerId: number;
  startX: number;
  startY: number;
  active: boolean;
}

interface VisualDrag {
  source: BoardLocation;
  x: number;
  y: number;
  over: DropLocation | null;
}

const EMPTY_KIT = {
  primary: "#23a55a",
  secondary: "#14693c",
  accent: "#ffd97a",
  numberColor: "#ffffff",
  pattern: "solid",
};

function isBoardPlayer(player: BoardPlayer | null | undefined): player is BoardPlayer {
  return player !== null && player !== undefined;
}

function positionLabel(position: number): string {
  return ["GK", "FB", "CB", "MF", "FW"][position] ?? "PLAYER";
}

function playerInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return name.slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

export function TacticsBoard({ mode, matchId, liveState, onSaved, onFormationChange }: Props) {
  const snapshot = useGame((state) => state.snapshot);
  const [data, setData] = useState<LineupView | null>(null);
  const [ed, setEd] = useState<Ed | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok" | "err" | "idle"; text: string }>({ kind: "idle", text: "" });
  const [selected, setSelected] = useState<BoardLocation | null>(null);
  const [dragging, setDragging] = useState<VisualDrag | null>(null);
  const pendingDragRef = useRef<PendingDrag | null>(null);
  const suppressClickRef = useRef(false);

  useEffect(() => {
    api
      .getLineup()
      .then((res) => {
        setData(res);
        const live = mode === "match" && liveState?.matchId === matchId ? liveState : null;
        const liveOn = live ? (live.humanSide === 0 ? live.homeOn : live.awayOn).map((player) => player.id) : [];
        const liveBench = live ? (live.humanSide === 0 ? live.homeBench : live.awayBench).map((player) => player.id) : [];
        const liveStarters = live ? [...liveOn, ...liveBench.filter((id) => !liveOn.includes(id))].slice(0, 11) : [];
        const starterIds = liveStarters.length === 11 ? liveStarters : res.starters.map((player) => player?.id ?? null);
        const starterSet = new Set(starterIds.filter((id): id is number => id !== null));
        const liveSubs = live
          ? liveBench.filter((id) => !starterSet.has(id))
          : res.subs.map((player) => player?.id ?? null);
        setEd({
          formation: res.formation,
          starters: starterIds,
          subs: liveStarters.length === 11 ? liveSubs : res.subs.map((player) => player?.id ?? null),
          penaltyTakerId: res.penaltyTakerId !== null && starterSet.has(res.penaltyTakerId) ? res.penaltyTakerId : null,
          freeKickTakerId: res.freeKickTakerId !== null && starterSet.has(res.freeKickTakerId) ? res.freeKickTakerId : null,
        });
        onFormationChange?.(res.formation);
      })
      .catch((error) => setStatus({ kind: "err", text: (error as Error).message }));
  }, [mode, matchId, liveState?.matchId, onFormationChange]);

  const byId = useMemo(() => {
    const players = new Map<number, BoardPlayer>();
    for (const player of data?.squad ?? []) {
      players.set(player.id, {
        ...player,
        tacticalPosition: player.tacPosName || positionLabel(player.position),
      });
    }
    for (const player of data?.starters ?? []) {
      if (player) {
        const existing = players.get(player.id);
        players.set(player.id, {
          ...player,
          tacticalPosition: existing?.tacticalPosition ?? positionLabel(player.position),
        });
      }
    }
    for (const player of data?.subs ?? []) {
      if (player) {
        const existing = players.get(player.id);
        players.set(player.id, {
          ...player,
          tacticalPosition: existing?.tacticalPosition ?? positionLabel(player.position),
        });
      }
    }
    return players;
  }, [data]);

  const save = useCallback(async (next: Ed) => {
    setSaving(true);
    try {
      const payload = {
        formation: next.formation,
        starters: next.starters.filter((id): id is number => id !== null),
        subs: next.subs.filter((id): id is number => id !== null),
        penaltyTakerId: next.penaltyTakerId,
        freeKickTakerId: next.freeKickTakerId,
      };
      if (mode === "club") {
        await api.setLineup(payload);
        setStatus({ kind: "ok", text: "Saved" });
        onSaved?.();
      } else if (matchId) {
        const result = await api.matchLineup(matchId, payload);
        setStatus({ kind: "ok", text: "Saved" });
        onSaved?.(result.state);
      }
    } catch (error) {
      setStatus({ kind: "err", text: (error as Error).message });
    } finally {
      setSaving(false);
    }
  }, [matchId, mode, onSaved]);

  const commit = useCallback((next: Ed) => {
    setEd(next);
    void save(next);
  }, [save]);

  const cleanTakers = useCallback((next: Ed, starters: (number | null)[]): Ed => ({
    ...next,
    starters,
    penaltyTakerId: next.penaltyTakerId !== null && starters.includes(next.penaltyTakerId) ? next.penaltyTakerId : null,
    freeKickTakerId: next.freeKickTakerId !== null && starters.includes(next.freeKickTakerId) ? next.freeKickTakerId : null,
  }), []);

  const starters = useMemo(() => (ed?.starters ?? []).map((id) => id === null ? null : byId.get(id) ?? null), [byId, ed?.starters]);
  const subs = useMemo(() => (ed?.subs ?? []).map((id) => id === null ? null : byId.get(id) ?? null), [byId, ed?.subs]);
  const starterIds = useMemo(() => new Set(ed?.starters.filter((id): id is number => id !== null) ?? []), [ed?.starters]);
  const benchIds = useMemo(() => new Set(ed?.subs.filter((id): id is number => id !== null) ?? []), [ed?.subs]);
  const poolPlayers = useMemo(
    () => (data?.squad ?? []).map((player) => byId.get(player.id)).filter(isBoardPlayer).filter((player) => !starterIds.has(player.id) && !benchIds.has(player.id)),
    [benchIds, byId, data?.squad, starterIds]
  );
  const slotNames = useMemo(() => (data?.slots ?? []).map((slot) => SLOT_NAMES[slot] ?? `#${slot}`), [data?.slots]);
  const slotPoints = useMemo(() => slotPointsForFormation(data?.formation ?? 0, data?.slots ?? []), [data?.formation, data?.slots]);
  const takerOptions = starters.filter(isBoardPlayer).map((player) => ({ id: player.id, label: `${player.name} (${player.overall})` }));

  const kit = mode === "match" && liveState
    ? liveState.humanSide === 0 ? liveState.homeKit : liveState.awayKit
    : snapshot?.club?.kits?.home ?? { ...EMPTY_KIT, primary: snapshot?.club?.primaryColor ?? EMPTY_KIT.primary, secondary: snapshot?.club?.secondaryColor ?? EMPTY_KIT.secondary };

  const findDropTarget = useCallback((clientX: number, clientY: number): DropLocation | null => {
    const element = document.elementFromPoint(clientX, clientY);
    const target = element?.closest("[data-tb-drop-area]") as HTMLElement | null;
    if (!target) return null;
    const area = target.dataset.tbDropArea;
    const index = Number(target.dataset.tbDropIndex);
    if ((area !== "starter" && area !== "bench" && area !== "pool") || !Number.isInteger(index)) return null;
    const id = target.dataset.tbDropId ? Number(target.dataset.tbDropId) : undefined;
    return { area, index, ...(id !== undefined ? { id } : {}) };
  }, []);

  const applyDrop = useCallback((source: BoardLocation, target: DropLocation) => {
    if (!ed || (source.area === target.area && source.index === target.index)) return;
    if (source.area === "pool" && target.area === "pool") return;

    const nextStarters = ed.starters.slice();
    const nextSubs = ed.subs.slice();
    const sourceValue = source.area === "starter" ? nextStarters[source.index] : source.area === "bench" ? nextSubs[source.index] : source.id;
    if (sourceValue === null || sourceValue === undefined) return;

    if (source.area === "pool") {
      if (target.area === "starter") nextStarters[target.index] = source.id;
      else if (target.area === "bench") nextSubs[target.index] = source.id;
      else return;
    } else if (target.area === "pool") {
      if (target.id === undefined) return;
      if (source.area === "starter") nextStarters[source.index] = target.id;
      else nextSubs[source.index] = target.id;
    } else if (source.area === "starter" && target.area === "starter") {
      if (nextStarters[target.index] === null) {
        setStatus({ kind: "err", text: "Choose a player for the empty slot first." });
        return;
      }
      [nextStarters[source.index], nextStarters[target.index]] = [nextStarters[target.index], nextStarters[source.index]];
    } else if (source.area === "bench" && target.area === "bench") {
      [nextSubs[source.index], nextSubs[target.index]] = [nextSubs[target.index], nextSubs[source.index]];
    } else if (source.area === "starter" && target.area === "bench") {
      if (nextSubs[target.index] === null) {
        setStatus({ kind: "err", text: "Drop onto an occupied bench slot to swap players." });
        return;
      }
      [nextStarters[source.index], nextSubs[target.index]] = [nextSubs[target.index], nextStarters[source.index]];
    } else if (source.area === "bench" && target.area === "starter") {
      [nextSubs[source.index], nextStarters[target.index]] = [nextStarters[target.index], nextSubs[source.index]];
    }

    commit({ ...cleanTakers(ed, nextStarters), subs: nextSubs });
  }, [cleanTakers, commit, ed]);

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const pending = pendingDragRef.current;
      if (!pending || pending.pointerId !== event.pointerId) return;
      const distance = Math.hypot(event.clientX - pending.startX, event.clientY - pending.startY);
      if (!pending.active && distance < 5) return;
      if (!pending.active) pending.active = true;
      event.preventDefault();
      setDragging({
        source: pending,
        x: event.clientX,
        y: event.clientY,
        over: findDropTarget(event.clientX, event.clientY),
      });
    };
    const onPointerUp = (event: PointerEvent) => {
      const pending = pendingDragRef.current;
      if (!pending || pending.pointerId !== event.pointerId) return;
      if (pending.active) {
        event.preventDefault();
        const target = findDropTarget(event.clientX, event.clientY);
        if (target) applyDrop(pending, target);
        suppressClickRef.current = true;
        window.setTimeout(() => { suppressClickRef.current = false; }, 0);
      }
      pendingDragRef.current = null;
      setDragging(null);
    };
    window.addEventListener("pointermove", onPointerMove, { passive: false });
    window.addEventListener("pointerup", onPointerUp, { passive: false });
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [applyDrop, findDropTarget]);

  const beginDrag = (location: BoardLocation, event: ReactPointerEvent<HTMLElement>) => {
    if (saving) return;
    if (event.button !== 0) return;
    pendingDragRef.current = {
      ...location,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
    };
  };

  const selectLocation = (location: BoardLocation) => {
    if (suppressClickRef.current) return;
    if (selected && (selected.area !== location.area || selected.index !== location.index)) {
      applyDrop(selected, location);
      setSelected(null);
      return;
    }
    setSelected((current) => current ? null : location);
  };

  const changeFormation = async (formation: number) => {
    if (!ed) return;
    onFormationChange?.(formation);
    setSaving(true);
    try {
      const result = await api.getLineup(true, formation);
      if (mode === "match") {
        setData((current) => current ? { ...current, formation, slots: result.slots } : result);
        commit({ ...ed, formation });
      } else {
        setData(result);
        commit({
          formation,
          starters: result.starters.map((player) => player?.id ?? null),
          subs: result.subs.map((player) => player?.id ?? null),
          penaltyTakerId: result.penaltyTakerId,
          freeKickTakerId: result.freeKickTakerId,
        });
      }
    } catch (error) {
      setStatus({ kind: "err", text: (error as Error).message });
    } finally {
      setSaving(false);
    }
  };

  const autoFill = async () => {
    if (!ed) return;
    if (mode === "match" && liveState?.phase === "halftime") {
      setStatus({ kind: "err", text: "Auto lineup is unavailable at halftime; choose players manually." });
      return;
    }
    setSaving(true);
    try {
      const result = await api.getLineup(true, ed.formation);
      setData(result);
      commit({
        formation: ed.formation,
        starters: result.starters.map((player) => player?.id ?? null),
        subs: result.subs.map((player) => player?.id ?? null),
        penaltyTakerId: result.penaltyTakerId,
        freeKickTakerId: result.freeKickTakerId,
      });
    } catch (error) {
      setStatus({ kind: "err", text: (error as Error).message });
    } finally {
      setSaving(false);
    }
  };

  const setTaker = (key: "penaltyTakerId" | "freeKickTakerId", id: number | null) => {
    if (!ed) return;
    commit({ ...ed, [key]: id });
  };

  if (!data || !ed) {
    return <div className="empty-state" style={{ padding: 24 }}>Loading lineup...</div>;
  }

  const benchSlots = Array.from({ length: 11 }, (_, index) => subs[index] ?? null);
  const statusColor = status.kind === "err" ? "var(--red-2)" : status.kind === "ok" ? "var(--grass-2)" : "var(--text-3)";
  const pitchStyle = (index: number): CSSProperties => {
    const point = slotPoints[index] ?? { x: 50, y: 50 };
    return { left: `${point.x}%`, top: `${point.y}%` };
  };
  const playerStyle = (): CSSProperties => ({
    "--tb-kit": kit.primary,
    "--tb-kit-2": kit.secondary,
    "--tb-kit-dot": kitDotBackground(kit),
  } as CSSProperties);
  const isOver = (area: BoardArea, index: number) => dragging?.over?.area === area && dragging.over.index === index;
  // playerStyle() only depends on `kit`, which is identical for every starter
  // row — compute the CSS-vars object once instead of allocating a fresh one
  // per row on every render.
  const starterChipStyle = playerStyle();

  return (
    <div className="tb-root">
      <div className="tb-toolbar">
        <div className="tb-field">
          <label htmlFor={`tb-formation-${mode}`}>Formation</label>
          <select id={`tb-formation-${mode}`} className="select" value={ed.formation} disabled={saving} onChange={(event) => void changeFormation(Number(event.target.value))}>
            {FORMATIONS.map((formation) => <option key={formation.value} value={formation.value}>{formation.label}</option>)}
          </select>
        </div>
        <button className="btn sm ghost" onClick={() => void autoFill()} disabled={saving || (mode === "match" && liveState?.phase === "halftime")}>
          <Wand2 size={14} /> Auto lineup
        </button>
        <span className="tb-status" style={{ color: statusColor }}>{saving ? "Saving..." : status.text || "Drag players to swap them."}</span>
      </div>

      <div className="tb-layout">
        <section className="tb-pitch-panel" aria-label="Starting eleven">
          <div className="tb-panel-head">
            <div>
              <div className="section-label">Starting eleven</div>
              <div className="tb-panel-hint">Drag a player onto another slot to swap.</div>
            </div>
            <span className="tb-count">{starterIds.size}/11</span>
          </div>
          <div className="tb-pitch">
            <svg className="tb-pitch-lines" viewBox="0 0 68 100" role="img" aria-label="Formation pitch">
              <rect x="0" y="0" width="68" height="100" fill="url(#tbGrass)" />
              <defs>
                <linearGradient id="tbGrass" x1="0" x2="1">
                  <stop offset="0" stopColor="#176b3c" />
                  <stop offset="0.5" stopColor="#238b4b" />
                  <stop offset="1" stopColor="#176b3c" />
                </linearGradient>
              </defs>
              <path d="M 2 2 H 66 V 98 H 2 Z M 2 50 H 66 M 20 2 H 48 V 18 H 20 Z M 27 2 H 41 V 8 H 27 Z M 20 98 H 48 V 82 H 20 Z M 27 98 H 41 V 92 H 27 Z" fill="none" stroke="rgba(238,246,239,0.72)" strokeWidth="0.45" />
              <circle cx="34" cy="50" r="8" fill="none" stroke="rgba(238,246,239,0.72)" strokeWidth="0.45" />
              <circle cx="34" cy="50" r="0.7" fill="rgba(238,246,239,0.8)" />
            </svg>
            <div className="tb-pitch-slots">
              {starters.map((player, index) => {
                const location: BoardLocation = { area: "starter", index, id: player?.id ?? -1 };
                const active = selected?.area === "starter" && selected.index === index;
                return (
                  <button
                    key={`starter-${index}`}
                    type="button"
                    className={`tb-slot${active ? " is-selected" : ""}${isOver("starter", index) ? " is-over" : ""}${player ? " has-player" : " is-empty"}`}
                    style={pitchStyle(index)}
                    data-tb-drop-area="starter"
                    data-tb-drop-index={index}
                    disabled={!player && !selected}
                    aria-label={`${slotNames[index] ?? `Slot ${index + 1}`}${player ? `: ${player.name}` : ": empty"}`}
                    onPointerDown={(event) => player && beginDrag(location, event)}
                    onClick={() => player && selectLocation(location)}
                  >
                    <span className="tb-slot-role">{slotNames[index] ?? `#${index + 1}`}</span>
                    {player ? (
                      <span className="tb-player-chip" style={starterChipStyle}>
                        <span className="tb-player-dot">{playerInitials(player.name)}</span>
                        <span className="tb-player-name">{player.name}</span>
                        <span className="tb-player-rating">{player.overall}</span>
                      </span>
                    ) : <span className="tb-empty-dot" aria-hidden="true" />}
                  </button>
                );
              })}
            </div>
          </div>
        </section>

        <aside className="tb-side">
          <section className="tb-side-panel" aria-label="Bench">
            <div className="tb-panel-head">
              <div>
                <div className="section-label">Bench</div>
                <div className="tb-panel-hint">Drag a bench player onto the pitch.</div>
              </div>
              <GripVertical size={15} className="tb-muted-icon" />
            </div>
            <div className="tb-bench-list">
              {benchSlots.map((player, index) => {
                const location: BoardLocation = { area: "bench", index, id: player?.id ?? -1 };
                const active = selected?.area === "bench" && selected.index === index;
                return (
                  <button
                    key={`bench-${index}`}
                    type="button"
                    className={`tb-list-row${active ? " is-selected" : ""}${isOver("bench", index) ? " is-over" : ""}${!player ? " is-empty" : ""}`}
                    data-tb-drop-area="bench"
                    data-tb-drop-index={index}
                    disabled={!player}
                    onPointerDown={(event) => player && beginDrag(location, event)}
                    onClick={() => player && selectLocation(location)}
                  >
                    <span className="tb-row-number">{index + 1}</span>
                    <span className="tb-row-position">{player?.tacticalPosition ?? "—"}</span>
                    <span className="tb-row-name">{player?.name ?? "Empty bench slot"}</span>
                    <span className="tb-row-energy">EN {player ? Math.round(player.energy) : "—"}</span>
                    <span className="tb-row-rating">{player?.overall ?? "—"}</span>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="tb-side-panel" aria-label="Squad pool">
            <div className="tb-panel-head">
              <div>
                <div className="section-label">Squad pool</div>
                <div className="tb-panel-hint">Drag an available player onto a slot.</div>
              </div>
              <span className="tb-count">{poolPlayers.length}</span>
            </div>
            <div className="tb-pool-list" data-tb-pool-background="true">
              {poolPlayers.length === 0 && <div className="tb-pool-empty">Everyone is assigned.</div>}
              {poolPlayers.map((player, index) => {
                const location: BoardLocation = { area: "pool", index, id: player.id };
                const unavailable = player.injuryDays > 0 || player.suspended;
                return (
                  <button
                    key={`pool-${player.id}`}
                    type="button"
                    className={`tb-list-row tb-pool-row${unavailable ? " is-unavailable" : ""}`}
                    data-tb-drop-area="pool"
                    data-tb-drop-index={index}
                    data-tb-drop-id={player.id}
                    disabled={unavailable}
                    title={unavailable ? player.suspended ? "Suspended" : `Injured for ${player.injuryDays}d` : undefined}
                    onPointerDown={(event) => !unavailable && beginDrag(location, event)}
                  >
                    <span className="tb-row-position">{player.tacticalPosition}</span>
                    <span className="tb-row-name">{player.name}</span>
                    <span className="tb-row-energy">EN {Math.round(player.energy)}</span>
                    <span className="tb-row-rating">{player.overall}</span>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="tb-side-panel tb-takers" aria-label="Set pieces">
            <div className="section-label">Set pieces</div>
            <div className="tb-taker-grid">
              <label>
                <span><Target size={12} /> Penalty taker</span>
                <select className="select" value={ed.penaltyTakerId ?? ""} disabled={saving} onChange={(event) => setTaker("penaltyTakerId", event.target.value ? Number(event.target.value) : null)}>
                  <option value="">— choose —</option>
                  {takerOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
                </select>
              </label>
              <label>
                <span>Free kick taker</span>
                <select className="select" value={ed.freeKickTakerId ?? ""} disabled={saving} onChange={(event) => setTaker("freeKickTakerId", event.target.value ? Number(event.target.value) : null)}>
                  <option value="">— choose —</option>
                  {takerOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
                </select>
              </label>
            </div>
          </section>
        </aside>
      </div>
      {dragging && createPortal(
        <div className="tb-drag-ghost" style={{ left: dragging.x, top: dragging.y }}>
          {byId.get(dragging.source.id)?.name}
        </div>,
        document.body
      )}
    </div>
  );
}
