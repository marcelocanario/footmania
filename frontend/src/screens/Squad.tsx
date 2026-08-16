import { useRef, useState } from "react";
import { DataTable } from "primereact/datatable";
import { Column } from "primereact/column";
import { Dialog } from "primereact/dialog";
import { Dropdown } from "primereact/dropdown";
import { InputNumber } from "primereact/inputnumber";
import { Toast } from "primereact/toast";
import { Dumbbell, ShieldCheck, Users, Clapperboard } from "lucide-react";
import { api, type PlayerView } from "../api/client";
import { useGame } from "../store/game";
import { strings } from "../strings";
import { PlayerName } from "../components/PlayerName";
import { RatingBar } from "../components/RatingBar";
import { PlayerSkillsRadar } from "../components/PlayerSkillsRadar";
import { Segmented } from "../components/Segmented";
import { LineupPicker } from "../components/LineupPicker";
import { useIsMobile } from "../hooks/useIsMobile";
import { money } from "../format";

const STYLES = [
  { label: "Balanced", value: 0 },
  { label: "Total Attack", value: 1 },
  { label: "Counter-attack", value: 2 },
];

const PRESSING = [
  { label: "Light", value: 0 },
  { label: "Heavy", value: 1 },
  { label: "Very Heavy", value: 2 },
];

const DIRECTIONS = [
  { label: "Through the middle", value: 0 },
  { label: "Down the wings", value: 1 },
];

const TRAITS = [
  "Positioning", "Penalty Save", "Reflexes", "Off the Line", "Playmaking",
  "Heading", "Crossing", "Tackling", "Dribbling", "Finishing",
  "Marking", "Passing", "Stamina", "Speed",
];

type Tab = "seniors" | "juniors" | "tactics";

export function Squad() {
  const { snapshot, saveId, refresh } = useGame();
  const isMobile = useIsMobile();
  const [selected, setSelected] = useState<PlayerView | null>(null);
  const [showRenew, setShowRenew] = useState(false);
  const [renewMonths, setRenewMonths] = useState(12);
  const [renewSalary, setRenewSalary] = useState(0);
  const [renewDemand, setRenewDemand] = useState(0);
  const [tactics, setTactics] = useState(snapshot?.club?.tactics ? { formation: snapshot.club.tactics.formation, style: snapshot.club.tactics.style, pressing: snapshot.club.tactics.pressing, direction: snapshot.club.tactics.direction } : { formation: 4, style: 0, pressing: 0, direction: 0 });
  const [tab, setTab] = useState<Tab>("seniors");
  const toast = useRef<Toast>(null);

  const club = snapshot?.club;
  const seniors = snapshot?.squad ?? [];
  const juniors = snapshot?.juniors ?? [];
  const rows = tab === "juniors" ? juniors : seniors;

  const openRenew = (p: PlayerView) => {
    setSelected(p);
    setRenewMonths(12);
    setRenewSalary(p.salary);
    setRenewDemand(p.salary);
    if (saveId) void api.contractDemand(saveId, p.id).then((res) => {
      setRenewDemand(res.demand);
      setRenewSalary(res.demand);
    });
    setShowRenew(true);
  };

  const renew = async () => {
    if (!saveId || !selected) return;
    try {
      await api.renewContract(saveId, selected.id, renewMonths, renewSalary);
      toast.current?.show({ severity: "success", summary: strings.squad.contractDone });
      setShowRenew(false);
      refresh();
    } catch (e) {
      toast.current?.show({ severity: "error", summary: "Error", detail: (e as Error).message });
    }
  };

  const train = async (p: PlayerView) => {
    if (!saveId) return;
    try {
      const res = await api.trainPlayer(saveId, p.id);
      toast.current?.show({
        severity: res.ok ? "success" : "info",
        summary: res.ok ? strings.squad.trainDone : "No improvement this week",
        detail: res.improved ? `Improved: ${res.improved}` : undefined,
      });
      refresh();
    } catch (e) {
      toast.current?.show({ severity: "error", summary: "Error", detail: (e as Error).message });
    }
  };

  const saveTactics = async () => {
    if (!saveId) return;
    try {
      await api.setTactics(saveId, { style: tactics.style, pressing: tactics.pressing, direction: tactics.direction });
      toast.current?.show({ severity: "success", summary: "Tactics saved" });
      refresh();
    } catch (e) {
      toast.current?.show({ severity: "error", summary: "Error", detail: (e as Error).message });
    }
  };

  const loanAction = async (p: PlayerView) => {
    if (!saveId) return;
    const action = p.loanId === null ? "offer" : "recall";
    try {
      await api.loanPlayer(saveId, p.id, action);
      toast.current?.show({ severity: "success", summary: action === "offer" ? "Player listed for loan" : "Player recalled" });
      await refresh();
    } catch (e) {
      toast.current?.show({ severity: "error", summary: "Error", detail: (e as Error).message });
    }
  };

  const ratingBody = (p: PlayerView) => (
    <span style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "1.2rem" }}>
      {p.overall}
      {p.potential > p.overall && <span style={{ color: "var(--grass-2)", fontSize: "0.78rem" }}> (+{p.potential - p.overall})</span>}
    </span>
  );

  const selectedPlayer = selected ?? rows[0];

  return (
    <div>
      <Toast ref={toast} />
      <div className="page-head">
        <div>
          <div className="kicker">{strings.squad.title}</div>
          <h1>{club?.name}</h1>
        </div>
        <Segmented<Tab>
          value={tab}
          onChange={setTab}
          items={[
            { value: "seniors", label: strings.squad.seniors, icon: <Users size={14} />, count: seniors.length },
            { value: "juniors", label: strings.squad.juniors, icon: <Dumbbell size={14} />, count: juniors.length },
            { value: "tactics", label: strings.squad.tactics, icon: <ShieldCheck size={14} /> },
          ]}
        />
      </div>

      {tab === "tactics" ? (
        <div className="grid" style={{ gridTemplateColumns: isMobile ? "1fr" : "minmax(0, 3fr) minmax(0, 2fr)", alignItems: "start", gap: 16 }}>
          <div className="card">
            <h2 className="card-title"><ShieldCheck size={17} /> {strings.squad.tactics}</h2>
            <LineupPicker mode="club" />
          </div>
          <div className="card">
            <h2 className="card-title"><Clapperboard size={17} /> Match Strategy</h2>
            <div className="form-group">
              <label htmlFor="tac-style">{strings.squad.style}</label>
              <Dropdown id="tac-style" value={tactics.style} options={STYLES} onChange={(e) => setTactics({ ...tactics, style: e.value })} style={{ width: "100%" }} />
            </div>
            <div className="form-group">
              <label htmlFor="tac-press">{strings.squad.pressing}</label>
              <Dropdown id="tac-press" value={tactics.pressing} options={PRESSING} onChange={(e) => setTactics({ ...tactics, pressing: e.value })} style={{ width: "100%" }} />
            </div>
            <div className="form-group">
              <label htmlFor="tac-dir">{strings.squad.direction}</label>
              <Dropdown id="tac-dir" value={tactics.direction} options={DIRECTIONS} onChange={(e) => setTactics({ ...tactics, direction: e.value })} style={{ width: "100%" }} />
            </div>
            <button className="btn" onClick={saveTactics} style={{ width: "100%" }}>
              {strings.common.save}
            </button>
            <div style={{ color: "var(--text-3)", fontSize: "0.82rem", marginTop: 12, lineHeight: 1.5 }}>
              Style, pressing and direction apply to every match. The starting eleven, bench and set-piece takers are saved with the lineup above.
            </div>
          </div>
        </div>
      ) : (
        <div className="grid" style={{ gridTemplateColumns: isMobile ? "1fr" : "minmax(0, 2fr) minmax(0, 1fr)", alignItems: "start" }}>
          <div className="card" style={{ padding: isMobile ? 10 : 20 }}>
            <div className="table-wrap">
              <DataTable
                value={rows}
                selectionMode="single"
                selection={selectedPlayer}
                onSelectionChange={(e) => setSelected(e.value)}
                rowClassName={(p) => (p.id === selectedPlayer?.id ? "human-row" : "")}
                rows={15}
                paginator
                dataKey="id"
              >
                <Column field="name" header={strings.squad.player} body={(p) => <PlayerName player={p} />} style={isMobile ? { minWidth: 170, width: 170 } : { minWidth: 230 }} frozen={isMobile} />
                <Column field="overall" header={strings.squad.overall} body={ratingBody} style={{ width: 70 }} />
                <Column field="age" header={strings.squad.age} style={{ width: 50 }} />
                <Column field="energy" header={strings.squad.energy} body={(p) => <RatingBar value={p.energy} />} style={{ width: 120 }} />
                {!isMobile && <Column header="Morale" body={(p: PlayerView) => <RatingBar value={p.morale} />} style={{ width: 110 }} />}
                {!isMobile && <Column field="value" header={strings.squad.value} body={(p) => money(p.value)} style={{ width: 90 }} />}
                {!isMobile && <Column field="salary" header={strings.squad.salary} body={(p) => `${money(p.salary)}/mo`} style={{ width: 100 }} />}
              </DataTable>
            </div>
          </div>

          {selectedPlayer && (
            <div className="card" key={selectedPlayer.id}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
                <div style={{ minWidth: 0 }}>
                  <h3 style={{ fontSize: "1.35rem" }}>{selectedPlayer.name}</h3>
                  <div style={{ color: "var(--text-2)", fontSize: "0.86rem", marginTop: 3 }}>
                    {selectedPlayer.positionName} · {selectedPlayer.age} yrs · {selectedPlayer.country}
                    {selectedPlayer.isStar ? " · ★ Star" : ""}
                   {selectedPlayer.worldClass ? " · World Class" : ""}
                    {selectedPlayer.suspendedGames > 0 && <span className="flag-chip" style={{ marginLeft: 6 }}>Suspended {selectedPlayer.suspendedGames}</span>}
                  </div>
                </div>
                <span
                  style={{
                    fontFamily: "var(--font-display)",
                    fontSize: "2.1rem",
                    fontWeight: 800,
                    minWidth: 62,
                    textAlign: "center",
                    background: "linear-gradient(180deg, rgba(61,220,132,0.16), rgba(35,165,90,0.08))",
                    border: "1px solid rgba(61,220,132,0.3)",
                    borderRadius: 14,
                    padding: "4px 10px",
                    color: "var(--grass-2)",
                  }}
                >
                  {selectedPlayer.overall}
                </span>
              </div>

              <div style={{ margin: "14px 0 4px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.8rem", color: "var(--text-3)", marginBottom: 5 }}>
                  <span>Overall</span>
                  <span>Potential {selectedPlayer.potential} · Tier {selectedPlayer.tier}</span>
                </div>
                <RatingBar value={selectedPlayer.overall} />
              </div>

              <div style={{ margin: "10px 0" }}>
                <div style={{ color: "var(--text-3)", fontSize: "0.74rem", marginBottom: 4 }}>Morale {selectedPlayer.morale}%</div>
                <RatingBar value={selectedPlayer.morale} />
              </div>

              <div style={{ margin: "14px 0", padding: "12px 0", borderTop: "1px solid var(--line)", borderBottom: "1px solid var(--line)" }}>
                <div className="section-label" style={{ marginBottom: 2 }}>Skill profile</div>
                <PlayerSkillsRadar skills={selectedPlayer.skills} />
              </div>

              <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginBottom: 14 }}>
                <span className="pos-tag">{TRAITS[selectedPlayer.characteristic1]}</span>
                <span className="pos-tag">{TRAITS[selectedPlayer.characteristic2]}</span>
              </div>

              <div className="stats-row">
                <div className="stat">
                  <div className="label">{strings.squad.value}</div>
                  <div className="value" style={{ fontSize: "1.15rem" }}>{money(selectedPlayer.value)}</div>
                </div>
                <div className="stat">
                  <div className="label">Release clause</div>
                  <div className="value" style={{ fontSize: "1.15rem" }}>{money(selectedPlayer.releaseClause)}</div>
                </div>
                <div className="stat">
                  <div className="label">{strings.squad.contract}</div>
                  <div className="value" style={{ fontSize: "1.15rem" }}>{Math.round(selectedPlayer.contractDays / 30)} mo</div>
                </div>
                <div className="stat">
                  <div className="label">Season</div>
                  <div className="value" style={{ fontSize: "1.15rem" }}>{selectedPlayer.seasonGoals}G {selectedPlayer.seasonAssists}A</div>
                </div>
              </div>

              <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
                <button className="btn" style={{ flex: 1 }} onClick={() => openRenew(selectedPlayer)}>
                  {strings.squad.renew}
                </button>
                <button className="btn ghost" style={{ flex: 1 }} onClick={() => train(selectedPlayer)}>
                  <Dumbbell size={14} /> {strings.squad.train}
                </button>
                {selectedPlayer.age <= 23 && !selectedPlayer.isYouth && (
                  <button className="btn ghost" style={{ flex: 1 }} onClick={() => loanAction(selectedPlayer)}>
                    {selectedPlayer.loanId === null ? "Offer loan" : "Recall"}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      <Dialog header={strings.squad.renew} visible={showRenew} onHide={() => setShowRenew(false)} style={{ width: 400 }}>
        {selectedPlayer && (
          <>
            <h3 style={{ marginBottom: 4 }}>{selectedPlayer.name}</h3>
            <div style={{ color: "var(--text-3)", fontSize: "0.85rem", marginBottom: 16 }}>
              Current salary {money(selectedPlayer.salary)}/mo · Demand {money(renewDemand)}/mo · Contract {Math.round(selectedPlayer.contractDays / 30)} mo left
            </div>
            <div className="form-group">
              <label htmlFor="renew-months">{strings.squad.contractMonths}</label>
              <Dropdown
                id="renew-months"
                value={renewMonths}
                options={[6, 12, 24, 36].map((m) => ({ label: m === 6 ? "6 months" : `${m / 12} years`, value: m }))}
                onChange={(e) => setRenewMonths(e.value)}
                style={{ width: "100%" }}
              />
            </div>
            <div className="form-group">
              <label htmlFor="renew-salary">{strings.squad.newSalary}</label>
              <InputNumber id="renew-salary" value={renewSalary} onValueChange={(e) => setRenewSalary(e.value ?? 0)} mode="currency" currency="USD" locale="en-US" style={{ width: "100%" }} inputStyle={{ width: "100%" }} />
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
              <button className="btn ghost" style={{ flex: 1 }} onClick={() => setShowRenew(false)}>{strings.common.cancel}</button>
              <button className="btn" style={{ flex: 1 }} onClick={renew}>{strings.common.confirm}</button>
            </div>
          </>
        )}
      </Dialog>
    </div>
  );
}
