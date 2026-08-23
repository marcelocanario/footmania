import { useEffect, useRef, useState } from "react";
import { DataTable } from "primereact/datatable";
import { Column } from "primereact/column";
import { Dialog } from "primereact/dialog";
import { Dropdown } from "primereact/dropdown";
import { MultiSelect } from "primereact/multiselect";
import { Toast } from "primereact/toast";
import { AlertTriangle, Dumbbell, ShieldCheck, Users, Clapperboard } from "lucide-react";
import { api, type FinanceSnapshot, type PlayerView } from "../api/client";
import { useGame } from "../store/game";
import { useSettings } from "../store/settings";
import { strings } from "../strings";
import { PlayerName, POSITION_CLASS } from "../components/PlayerName";
import { RatingBar } from "../components/RatingBar";
import { PlayerSkillsRadar } from "../components/PlayerSkillsRadar";
import { Segmented } from "../components/Segmented";
import { TacticsBoard } from "../components/TacticsBoard";
import { AutomationPanel } from "../components/AutomationPanel";
import { DIRECTIONS, PRESSING, STYLES } from "../tacticsOptions";
import { useIsMobile } from "../hooks/useIsMobile";
import { money } from "../format";
import { InputText } from "primereact/inputtext";
import { countryFlag } from "../countryFlags";

type Tab = "seniors" | "juniors" | "tactics";
type TrainingFocus = "assistant" | "primary" | "secondary";

const POSITION_OPTIONS = ["GK", "FB", "CB", "MF", "FW"].map((label, value) => ({ label, value }));

function energyColor(value: number): string {
  const pct = Math.max(0, Math.min(100, value));
  return `hsl(${pct * 1.2}, 72%, 48%)`;
}

export function Squad() {
  const { snapshot, refresh } = useGame();
  const isMobile = useIsMobile();
  const maxContractSeasons = useSettings((s) => s.maxContractSeasons);
  const [selected, setSelected] = useState<PlayerView | null>(null);
  const [showRenew, setShowRenew] = useState(false);
  const [renewSeasons, setRenewSeasons] = useState(1);
  const [renewDemand, setRenewDemand] = useState(0);
  const [renewDemandsBySeason, setRenewDemandsBySeason] = useState<Record<number, number>>({});
  const [finance, setFinance] = useState<FinanceSnapshot | null>(null);
  const [confirmAction, setConfirmAction] = useState<{ title: string; message: string; onConfirm: () => Promise<void> } | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [tactics, setTactics] = useState(snapshot?.club?.tactics ? { formation: snapshot.club.tactics.formation, style: snapshot.club.tactics.style, pressing: snapshot.club.tactics.pressing, direction: snapshot.club.tactics.direction } : { formation: 4, style: 0, pressing: 0, direction: 0 });
  // Formation currently picked in the tactics board; scopes the automation panel.
  const [boardFormation, setBoardFormation] = useState<number>(snapshot?.club?.tactics?.formation ?? 4);
  const [tab, setTab] = useState<Tab>("seniors");
  const [trainingFocus, setTrainingFocus] = useState<TrainingFocus>(snapshot?.club?.trainingFocus ?? "assistant");
  const toast = useRef<Toast>(null);
  const user = useGame((s) => s.user);
  const [nicknameInput, setNicknameInput] = useState("");
  const [nicknameBusy, setNicknameBusy] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [historyData, setHistoryData] = useState<{ player: PlayerView & { displayName?: string }; seasons: { seasonKey: string; clubName: string; goals: number; assists: number; yellows: number; reds: number }[]; transfers: { type: string; price: number; seasonKey: string }[]; matches: { minute: number; type: number; matchHomeScore: number | null; matchAwayScore: number | null }[] } | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [filter, setFilter] = useState("");
  const [positionFilter, setPositionFilter] = useState<number[]>([]);
  const [countryNames, setCountryNames] = useState<Record<string, string>>({});
  const seasonsOf = (days: number) => {
    const per = snapshot?.save.seasonDays;
    if (!per) return `${days}d`;
    const s = Math.round(days / per);
    return `${s} season${s === 1 ? "" : "s"}`;
  };

  const club = snapshot?.club;
  const seniors = snapshot?.squad ?? [];
  const juniors = snapshot?.juniors ?? [];
  const rows = tab === "juniors" ? juniors : seniors;
  const seasonDays = snapshot?.save.seasonDays ?? 30;
  const tableRows = rows.map((player) => ({
    ...player,
    contractSeasons: player.contractDays > 0 ? Math.ceil(player.contractDays / seasonDays) : 0,
  }));
  const filteredRows = tableRows.filter((player) => {
    const query = filter.trim().toLowerCase();
    const nameMatches = !query || (player.displayName ?? player.name).toLowerCase().includes(query);
    const positionMatches = positionFilter.length === 0 || positionFilter.includes(player.position);
    return nameMatches && positionMatches;
  });

  useEffect(() => {
    void api.finances().then((response) => setFinance(response.finance)).catch(() => setFinance(null));
  }, [snapshot?.club?.cash]);

  useEffect(() => {
    let active = true;
    void api.countries()
      .then((response) => {
        if (!active) return;
        setCountryNames(Object.fromEntries(response.allCountries.map((country) => [country.code, country.name])));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const openRenew = (p: PlayerView) => {
    setSelected(p);
    setRenewSeasons(1);
    setRenewDemand(p.salary);
    setRenewDemandsBySeason({});
    if (snapshot) void api.contractDemand(p.id).then((res) => {
      setRenewDemandsBySeason(res.demandsBySeason ?? {});
      setRenewDemand(res.demandsBySeason?.[1] ?? res.salary);
    });
    setShowRenew(true);
  };

  const renew = async () => {
    if (!selected) return;
    try {
      await api.renewContract(selected.id, renewSeasons);
      toast.current?.show({ severity: "success", summary: strings.squad.contractDone });
      setShowRenew(false);
      refresh();
    } catch (e) {
      toast.current?.show({ severity: "error", summary: "Error", detail: (e as Error).message });
    }
  };

  const renewalCushion = finance && selected
    ? finance.financialCushion
       - selected.salary * finance.remainingSeasonFraction
       + renewDemand * finance.remainingSeasonFraction
    : null;

  const saveTrainingFocus = async (focus: TrainingFocus) => {
    if (false) return;
    try {
      await api.setTrainingFocus(focus);
      setTrainingFocus(focus);
      toast.current?.show({ severity: "success", summary: "Training focus saved" });
      await refresh();
    } catch (e) {
      toast.current?.show({ severity: "error", summary: "Error", detail: (e as Error).message });
    }
  };

  const saveTactics = async () => {
    if (false) return;
    try {
      await api.setTactics({ style: tactics.style, pressing: tactics.pressing, direction: tactics.direction });
      toast.current?.show({ severity: "success", summary: "Tactics saved" });
      refresh();
    } catch (e) {
      toast.current?.show({ severity: "error", summary: "Error", detail: (e as Error).message });
    }
  };

  const loanAction = async (p: PlayerView) => {
    if (false) return;
    const action = p.loanId === null ? "offer" : "recall";
    try {
      if (action === "offer") await api.offerLoan(p.id);
      else if (p.loanId !== null) await api.cancelLoan(p.loanId);
      toast.current?.show({ severity: "success", summary: action === "offer" ? "Player listed for loan" : "Player recalled" });
      await refresh();
    } catch (e) {
      toast.current?.show({ severity: "error", summary: "Error", detail: (e as Error).message });
    }
  };

  const confirm = (title: string, message: string, onConfirm: () => Promise<void>) => {
    setConfirmAction({ title, message, onConfirm });
  };

  const runConfirm = async () => {
    if (!confirmAction) return;
    setConfirmBusy(true);
    try {
      await confirmAction.onConfirm();
      setConfirmAction(null);
    } catch (e) {
      toast.current?.show({ severity: "error", summary: "Error", detail: (e as Error).message });
    } finally {
      setConfirmBusy(false);
    }
  };

  const academyAction = async (p: PlayerView, action: "promote" | "dismiss") => {
    if (false) return;
    confirm(
      action === "promote" ? "Promote player" : "Release from academy",
      action === "promote" ? `Promote ${p.name} to the senior squad?` : `Release ${p.name} from the youth academy?`,
      async () => {
        await api.academyAction(p.id, action);
        toast.current?.show({ severity: "success", summary: action === "promote" ? "Player promoted" : "Player released" });
        await refresh();
      }
    );
  };

  const releasePlayer = (p: PlayerView) => {
    if (false) return;
    const projectedCushion = club?.finance
      ? club.finance.financialCushion - p.releaseClause + p.salary * club.finance.remainingSeasonFraction
      : null;
    const warning = projectedCushion !== null && projectedCushion < 0
      ? ` This would reduce your financial cushion to ${money(projectedCushion)} and may put future payroll at risk.`
      : "";
    confirm(
      strings.squad.release,
      `${strings.squad.releaseConfirm.replace("{{name}}", p.name)}${warning}`,
      async () => {
        const res = await api.releasePlayer(p.id);
        toast.current?.show({
          severity: "success",
          summary: strings.squad.releaseDone,
          detail: res.cost > 0 ? `Paid ${money(res.cost)} release clause` : undefined,
        });
        await refresh();
      }
    );
  };

  const ratingBody = (p: PlayerView) => (
    <span style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "1.2rem" }}>
      {p.overall}
    </span>
  );

  const contractBody = (p: PlayerView & { contractSeasons: number }) => (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }} title={p.contractSeasons <= 1 ? "Contract expires this season" : undefined}>
      {p.contractSeasons <= 1 && <AlertTriangle size={14} style={{ color: "var(--gold-2)" }} aria-label="Expiring contract" />}
      {p.contractSeasons === 0 ? "Expired" : `${p.contractSeasons} ${p.contractSeasons === 1 ? "season" : "seasons"}`}
    </span>
  );

  const selectedPlayer = selected ?? rows[0];
  const selectedTablePlayer = selectedPlayer ? tableRows.find((player) => player.id === selectedPlayer.id) ?? null : null;
  const selectedCountryName = selectedPlayer ? countryNames[selectedPlayer.country] ?? selectedPlayer.country : "";
  const selectedCountryFlag = selectedPlayer ? countryFlag(selectedPlayer.country) : null;

  useEffect(() => {
    if (selectedPlayer) setNicknameInput(selectedPlayer.nickname ?? "");
  }, [selectedPlayer?.id, selectedPlayer?.nickname]);

  const saveNickname = async () => {
    if (!selectedPlayer) return;
    if (!user?.isPro) {
      toast.current?.show({ severity: "warn", summary: "Pro required", detail: "Only Pro managers can nickname players." });
      return;
    }
    setNicknameBusy(true);
    try {
      const raw = nicknameInput.trim();
      await api.nicknamePlayer(selectedPlayer.id, raw.length === 0 ? null : raw);
      toast.current?.show({ severity: "success", summary: "Nickname saved", detail: raw ? `"${raw}" is now visible to everyone.` : "Nickname cleared." });
      await refresh();
    } catch (e) {
      toast.current?.show({ severity: "error", summary: "Error", detail: (e as Error).message });
    } finally {
      setNicknameBusy(false);
    }
  };

  const openHistory = async (p: PlayerView) => {
    setHistoryBusy(true);
    setShowHistory(true);
    setHistoryData(null);
    try {
      const data = await api.playerHistory(p.id);
      setHistoryData(data as never);
    } catch (e) {
      toast.current?.show({ severity: "error", summary: "History", detail: (e as Error).message });
      setShowHistory(false);
    } finally {
      setHistoryBusy(false);
    }
  };

  return (
    <div>
      <Toast ref={toast} position="bottom-right" />
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
        <>
          <div className="grid" style={{ gridTemplateColumns: isMobile ? "1fr" : "minmax(0, 3fr) minmax(0, 2fr)", alignItems: "start", gap: 16 }}>
            <div className="card">
              <h2 className="card-title"><ShieldCheck size={17} /> {strings.squad.tactics}</h2>
              <TacticsBoard mode="club" onFormationChange={setBoardFormation} />
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
            <div className="form-group" style={{ marginTop: 18 }}>
              <label htmlFor="training-focus">{strings.squad.trainingFocus}</label>
              <Dropdown
                id="training-focus"
                value={trainingFocus}
                options={[
                  { label: strings.squad.trainingAssistant, value: "assistant" },
                  { label: strings.squad.trainingPrimary, value: "primary" },
                  { label: strings.squad.trainingSecondary, value: "secondary" },
                ]}
                onChange={(e) => void saveTrainingFocus(e.value as TrainingFocus)}
                style={{ width: "100%" }}
              />
              <div style={{ color: "var(--text-3)", fontSize: "0.82rem", marginTop: 7, lineHeight: 1.5 }}>
                {strings.squad.trainingHint}
              </div>
            </div>
            <div style={{ color: "var(--text-3)", fontSize: "0.82rem", marginTop: 12, lineHeight: 1.5 }}>
              Style, pressing and direction apply to every match. The starting eleven, bench and set-piece takers are saved with the lineup above.
            </div>
          </div>
          </div>
          <AutomationPanel formation={boardFormation} />
        </>
      ) : (
        <div className="grid" style={{ gridTemplateColumns: isMobile ? "1fr" : "minmax(0, 2fr) minmax(0, 1fr)", alignItems: "start" }}>
          <div className="card" style={{ padding: isMobile ? 10 : 20 }}>
            <div className="table-wrap squad-table-wrap">
              <DataTable
                value={filteredRows}
                selectionMode="single"
                selection={selectedTablePlayer}
                onSelectionChange={(e) => setSelected(e.value as PlayerView | null)}
                rowClassName={(p) => (p.id === selectedPlayer?.id ? "human-row" : "")}
                rows={15}
                paginator
                dataKey="id"
                sortMode="single"
                className="squad-table"
                tableStyle={{ width: "100%", tableLayout: "fixed" }}
                header={
                  <div className="squad-filters">
                    <InputText
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
                      placeholder="Search player name"
                      aria-label="Search player name"
                    />
                    <MultiSelect
                      value={positionFilter}
                      options={POSITION_OPTIONS}
                      onChange={(e) => setPositionFilter(e.value as number[])}
                      optionLabel="label"
                      optionValue="value"
                      placeholder="All positions"
                      maxSelectedLabels={2}
                      selectedItemsLabel="{0} positions"
                      scrollHeight="320px"
                      aria-label="Filter by position"
                    />
                  </div>
                }
              >
                <Column field="position" header="Pos" body={(p) => <span className={`pos-tag ${POSITION_CLASS[p.position] ?? ""}`}>{p.positionName}</span>} sortable style={{ width: isMobile ? 70 : "8%" }} frozen={isMobile} />
                <Column field="name" header={strings.squad.player} body={(p) => <span className="squad-player-cell"><PlayerName player={p} showPosition={false} /></span>} sortable style={isMobile ? { width: 160 } : { width: "25%" }} frozen={isMobile} />
                <Column field="overall" header={strings.squad.overall} body={ratingBody} sortable style={{ width: "8%" }} />
                <Column field="age" header={strings.squad.age} sortable style={{ width: "7%" }} />
                <Column field="energy" header={strings.squad.energy} body={(p) => <RatingBar value={p.energy} color={energyColor(p.energy)} />} sortable style={{ width: "14%" }} />
                <Column field="conditionLabel" header={strings.squad.condition} body={(p) => <span style={{ color: p.conditionLabel === "Needs rest" || p.conditionLabel === "Injured" ? "var(--red-2)" : "var(--text-2)" }}>{p.conditionLabel ?? "Normal workload"}{p.injuryDaysRemaining > 0 ? ` · ${p.injuryDaysRemaining}d` : ""}</span>} style={{ width: "16%" }} />
                {!isMobile && <Column field="value" header={strings.squad.value} body={(p) => money(p.value)} sortable style={{ width: "11%" }} />}
                {!isMobile && <Column field="salary" header={strings.squad.salary} body={(p) => money(p.salary)} sortable style={{ width: "11%" }} />}
                <Column field="contractSeasons" header={strings.squad.contract} body={contractBody} sortable style={{ width: isMobile ? 105 : "16%" }} />
              </DataTable>
            </div>
          </div>

          {selectedPlayer && (
            <div className="card" key={selectedPlayer.id}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
                <div style={{ minWidth: 0 }}>
                  <h3 style={{ fontSize: "1.35rem" }}>{selectedPlayer.displayName ?? selectedPlayer.name}{selectedPlayer.nickname && <span style={{ color: "var(--gold-2)", fontWeight: 400, fontSize: "0.9rem" }}> “{selectedPlayer.nickname}”</span>}</h3>
                  {selectedPlayer.nickname && <div style={{ color: "var(--text-3)", fontSize: "0.78rem" }}>Real name: {selectedPlayer.name}</div>}
                  <div style={{ color: "var(--text-2)", fontSize: "0.86rem", marginTop: 3 }}>
                    {selectedPlayer.positionName} · {selectedPlayer.age} yrs ·{" "}
                    <span title={selectedPlayer.country} aria-label={`Country: ${selectedCountryName}`}>
                      {selectedCountryFlag && <span aria-hidden="true">{selectedCountryFlag} </span>}
                      {selectedCountryName}
                    </span>
                    {selectedPlayer.suspendedGames > 0 && <span className="flag-chip" style={{ marginLeft: 6 }}>Suspended {selectedPlayer.suspendedGames}</span>}
                    {!!selectedPlayer.injuryDaysRemaining && selectedPlayer.injuryDaysRemaining > 0 && (
                      <span className="flag-chip" style={{ marginLeft: 6 }} title={`${strings.squad.injuryCause}: ${selectedPlayer.injuryCause ?? "—"}`}>
                        Injured · {strings.squad.injuredReturn.replace("{{day}}", String((selectedPlayer.injuryUntilAbsoluteGameDay ?? 0) + 1))}
                      </span>
                    )}
                  </div>
                  <div style={{ display: "flex", gap: 6, marginTop: 8, alignItems: "center" }}>
                    <InputText value={nicknameInput} onChange={(e) => setNicknameInput(e.target.value)} placeholder="Nickname (Pro)" maxLength={24} style={{ flex: 1, minWidth: 0 }} disabled={!user?.isPro} />
                    <button className="btn" onClick={() => void saveNickname()} disabled={nicknameBusy || !user?.isPro} title={!user?.isPro ? "Pro required" : undefined} style={{ whiteSpace: "nowrap" }}>{nicknameBusy ? "Saving…" : "Set nick"}</button>
                    <button className="btn ghost" onClick={() => void openHistory(selectedPlayer)} disabled={historyBusy} title="View career history">{historyBusy ? "…" : "History"}</button>
                  </div>
                  {!user?.isPro && <div style={{ color: "var(--text-3)", fontSize: "0.75rem", marginTop: 4 }}>Only <b>Pro</b> managers can nickname (visible to everyone).</div>}
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
                </div>
                <RatingBar value={selectedPlayer.overall} />
              </div>

              <div style={{ margin: "14px 0", padding: "12px 0", borderTop: "1px solid var(--line)", borderBottom: "1px solid var(--line)" }}>
                <div className="section-label" style={{ marginBottom: 2 }}>Skill profile</div>
                <PlayerSkillsRadar skills={selectedPlayer.skills} />
              </div>

              <div className="stats-row">
                <div className="stat">
                  <div className="label">{strings.squad.value}</div>
                  <div className="value" style={{ fontSize: "1.15rem" }}>{money(selectedPlayer.value)}</div>
                </div>
                <div className="stat">
                  <div className="label">Release clause</div>
                  <div className="value" style={{ fontSize: "1.15rem" }}>{money(selectedPlayer.isYouth ? 0 : selectedPlayer.releaseClause)}</div>
                </div>
                <div className="stat">
                  <div className="label">{strings.squad.contract}</div>
                  <div className="value" style={{ fontSize: "1.15rem" }}>{seasonsOf(selectedPlayer.contractDays)}</div>
                </div>
                <div className="stat">
                  <div className="label">Season</div>
                  <div className="value" style={{ fontSize: "1.15rem" }}>{selectedPlayer.seasonGoals}G {selectedPlayer.seasonAssists}A</div>
                </div>
              </div>

              <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
                {!selectedPlayer.isYouth && !selectedPlayer.onLoan && !selectedPlayer.onLoanOut && !selectedPlayer.onSale && <button className="btn" style={{ flex: 1 }} onClick={() => openRenew(selectedPlayer)}>{strings.squad.renew}</button>}
                {selectedPlayer.isYouth && !selectedPlayer.onLoanOut && (
                  <button className="btn" style={{ flex: 1 }} onClick={() => academyAction(selectedPlayer, "promote")}>{strings.squad.promoteYouth}</button>
                )}
                {!selectedPlayer.isYouth && !selectedPlayer.onLoan && (
                  <button
                    className="btn ghost"
                    style={{ flex: 1 }}
                    title={!selectedPlayer.onLoanOut ? strings.transfers.lendLoanHint : undefined}
                    onClick={() => loanAction(selectedPlayer)}
                  >
                    {selectedPlayer.onLoanOut ? "Recall from loan" : selectedPlayer.loanId === null ? "Offer loan" : "Recall"}
                  </button>
                )}
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                {!selectedPlayer.isYouth && !selectedPlayer.onLoan && !selectedPlayer.onLoanOut && (
                  <button
                    className="btn ghost danger"
                    style={{ flex: 1 }}
                    disabled={(selectedPlayer.releaseClause ?? 0) > (club?.finance?.immediateAvailableCash ?? club?.cash ?? 0)}
                    title={(selectedPlayer.releaseClause ?? 0) > (club?.finance?.immediateAvailableCash ?? club?.cash ?? 0) ? "The club cannot afford the release clause after binding bid reservations" : undefined}
                    onClick={() => releasePlayer(selectedPlayer)}
                  >
                    {strings.squad.release} ({money(selectedPlayer.releaseClause ?? 0)})
                  </button>
                )}
                {selectedPlayer.isYouth && !selectedPlayer.onLoan && (
                  <button className="btn ghost danger" style={{ flex: 1 }} onClick={() => academyAction(selectedPlayer, "dismiss")}>
                    {strings.squad.dismissYouth}
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
              Current salary {money(selectedPlayer.salary)}/season · Demand {money(renewDemand)}/season · Contract {seasonsOf(selectedPlayer.contractDays)} left
            </div>
            <div className="form-group">
              <label htmlFor="renew-seasons">{strings.squad.contractAdditionalSeasons}</label>
              <Dropdown
                id="renew-seasons"
                value={renewSeasons}
                 options={Array.from({ length: maxContractSeasons }, (_, i) => i + 1).map((s) => ({ label: `${s === 1 ? "1 season" : `${s} seasons`} - ${money(renewDemandsBySeason[s] ?? renewDemand)}/season`, value: s }))}
                onChange={(e) => {
                  const v = e.value as number;
                  setRenewSeasons(v);
                  const demand = renewDemandsBySeason?.[v] ?? renewDemand;
                  setRenewDemand(demand);
                }}
                style={{ width: "100%" }}
              />
            </div>
            {renewalCushion !== null && renewalCushion < 0 && (
              <div className="card" style={{ marginBottom: 10, padding: 10, fontSize: "0.88rem", color: "var(--gold-2)", borderColor: "var(--gold-2)" }}>
                This renewal would reduce your financial cushion from <b>{money(finance?.financialCushion ?? 0)}</b> to <b style={{ color: "var(--red-2)" }}>{money(renewalCushion)}</b>.
                You may continue, but future payroll could require financial intervention.
              </div>
            )}
            <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
              <button className="btn ghost" style={{ flex: 1 }} onClick={() => setShowRenew(false)}>{strings.common.cancel}</button>
              <button className="btn" style={{ flex: 1 }} onClick={renew}>{strings.common.confirm}</button>
            </div>
          </>
        )}
      </Dialog>

      <Dialog header={confirmAction?.title ?? ""} visible={confirmAction !== null} onHide={() => setConfirmAction(null)} style={{ width: 400 }}>
        {confirmAction && (
          <>
            <div style={{ color: "var(--text-2)", lineHeight: 1.5 }}>{confirmAction.message}</div>
            <div style={{ display: "flex", gap: 8, marginTop: 18 }}>
              <button className="btn ghost" style={{ flex: 1 }} disabled={confirmBusy} onClick={() => setConfirmAction(null)}>{strings.common.cancel}</button>
              <button className="btn red" style={{ flex: 1 }} disabled={confirmBusy} onClick={() => void runConfirm()}>{strings.common.confirm}</button>
            </div>
          </>
        )}
      </Dialog>

      <Dialog header={historyData ? `${historyData.player.displayName ?? historyData.player.name} — Career` : "Career history"} visible={showHistory} onHide={() => setShowHistory(false)} style={{ width: 520 }}>
        {!historyData ? (
          <div className="empty-state" style={{ padding: 20 }}>{historyBusy ? "Loading…" : "No data"}</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div className="card" style={{ padding: 12 }}>
              <div style={{ fontWeight: 800 }}>{historyData.player.displayName ?? historyData.player.name} <span style={{ color: "var(--text-3)", fontWeight: 400 }}>· {historyData.player.age} yrs · OVR {historyData.player.overall}</span></div>
              <div style={{ color: "var(--text-2)", fontSize: "0.85rem", marginTop: 4 }}>Career {historyData.player.careerGoals}G {historyData.player.careerAssists}A · Season {historyData.player.seasonGoals}G {historyData.player.seasonAssists}A · {historyData.player.yellows}Y {historyData.player.reds}R {historyData.player.injuryDays > 0 ? `· Injured ${historyData.player.injuryDays}d` : ""}</div>
            </div>
            <div>
              <div className="section-label">Per-season</div>
              {historyData.seasons.length === 0 ? <div style={{ color: "var(--text-3)", fontSize: "0.85rem" }}>No past seasons archived yet. Past seasons appear at rollover.</div> : <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>{historyData.seasons.map((s) => <div key={s.seasonKey} className="news-item" style={{ display: "flex", justifyContent: "space-between" }}><span>{s.seasonKey} · {s.clubName}</span><span>{s.goals}G {s.assists}A {s.yellows}Y {s.reds}R</span></div>)}</div>}
            </div>
            <div>
              <div className="section-label">Transfers</div>
              {historyData.transfers.length === 0 ? <div style={{ color: "var(--text-3)", fontSize: "0.85rem" }}>No market moves.</div> : <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>{historyData.transfers.map((t, i) => <div key={i} className="news-item">{t.type} · {money(t.price)} · {t.seasonKey}</div>)}</div>}
            </div>
            <div>
              <div className="section-label">Recent matches (goals/cards/injuries)</div>
              {historyData.matches.length === 0 ? <div style={{ color: "var(--text-3)", fontSize: "0.85rem" }}>No match events.</div> : <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>{historyData.matches.slice(0, 12).map((m, i) => <div key={i} className="news-item" style={{ fontSize: "0.85rem", display: "flex", justifyContent: "space-between" }}><span>Type {m.type} {m.minute}'</span><span>{m.matchHomeScore ?? "–"}–{m.matchAwayScore ?? "–"}</span></div>)}</div>}
            </div>
            <div style={{ color: "var(--text-3)", fontSize: "0.75rem" }}>Own players always visible. Other clubs' full history requires <b>Pro</b>; during an active auction everyone sees the listed player's history.</div>
          </div>
        )}
      </Dialog>
    </div>
  );
}
