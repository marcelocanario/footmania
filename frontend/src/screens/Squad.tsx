import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { DataTable } from "primereact/datatable";
import { Column } from "primereact/column";
import { Dialog } from "primereact/dialog";
import { Dropdown } from "primereact/dropdown";
import { MultiSelect } from "primereact/multiselect";
import { Toast } from "primereact/toast";
import { Tooltip } from "primereact/tooltip";
import { Activity, AlertTriangle, BatteryLow, BatteryMedium, CalendarDays, Clapperboard, Dumbbell, FileSignature, Handshake, HeartPulse, History as HistoryIcon, Pencil, ShieldAlert, ShieldCheck, Sparkles, Square, Tag, Target, Trash2, TrendingUp, Trophy, UserMinus, Users } from "lucide-react";
import { api, type FinanceSnapshot, type PlayerView } from "../api/client";
import { useGame } from "../store/game";
import { useSettings } from "../store/settings";
import i18n from "i18next";
import { PlayerName } from "../components/PlayerName";
import { DISPLAY_ORDER, positionClass, positionLabel, positionLetter } from "../positions";
import { conditionLabel as conditionTextKey } from "../condition";
import { RatingBar } from "../components/RatingBar";
import { PlayerSkillsRadar } from "../components/PlayerSkillsRadar";
import { PlayerTrendSparkline } from "../components/PlayerTrendSparkline";
import { PlayerScoresBarChart } from "../components/PlayerScoresBarChart";
import { Segmented } from "../components/Segmented";
import { TacticsBoard } from "../components/TacticsBoard";
import { AutomationPanel } from "../components/AutomationPanel";
import { FamiliarityBar } from "../components/FamiliarityBar";
import { directionOptions, pressingOptions, styleOptions, type TacticOption } from "../tacticsOptions";
import { useIsMobile } from "../hooks/useIsMobile";
import { money } from "../format";
import { InputText } from "primereact/inputtext";
import { countryFlag } from "../countryFlags";
import { ListForSaleDialog } from "../components/market/ListForSaleDialog";
import { squadActionState } from "./squadActions";

type Tab = "seniors" | "juniors" | "tactics";
type TrainingFocus = "assistant" | "primary" | "secondary";
type PlayerPanelTab = "customization" | "history";
type HistorySectionTab = "seasons" | "transfers" | "evolution";

type SquadHistoryData = {
  player: PlayerView & { displayName?: string; careerMvps?: number };
  seasons: { seasonId: number; seasonKey: string; clubName: string; appearances: number; goals: number; assists: number; yellows: number; reds: number; overall: number | null; value: number | null; mvps?: number; avgScore?: number | null }[];
  transfers: { type: string; price: number; seasonKey: string }[];
  matches: { minute: number; type: number; matchHomeScore: number | null; matchAwayScore: number | null }[];
  matchScores?: { matchId: number; score: number; rating: number | null; goals: number; assists: number; won: boolean; result: string | null; minutesPlayed?: number; role?: string; currentSeason?: boolean }[];
  currentSeasonAvg?: number | null;
};

const POSITION_OPTIONS = DISPLAY_ORDER.map((label) => ({ label, value: label }));

function energyColor(value: number): string {
  const pct = Math.max(0, Math.min(100, value));
  return `hsl(${pct * 1.2}, 72%, 48%)`;
}

function conditionIcon(condition: string) {
  switch (condition) {
    case "injured": return HeartPulse;
    case "needsRest": return BatteryLow;
    case "tired": return BatteryMedium;
    case "heavyLoad": return Dumbbell;
    case "fresh": return Sparkles;
    default: return Activity;
  }
}

// Column `body` renderers hoisted to module scope: each reads only its `p`
// parameter (plus other module-level helpers/components), so a fresh closure
// per render (and per row) buys nothing and only adds allocation churn.
function positionBody(p: PlayerView) {
  return <span className={`pos-tag ${positionClass(p.naturalPosition)} squad-tooltip-trigger`} data-pr-tooltip={positionLabel(p.naturalPosition)}>{positionLetter(p.naturalPosition)}</span>;
}

/** Dropdown menu item for tactic options: label plus optional one-line description. */
function tacticItemTemplate(option: TacticOption) {
  return (
    <div>
      <div style={{ fontWeight: 600 }}>{option.label}</div>
      {option.desc && <div style={{ fontSize: "0.8rem", opacity: 0.85, marginTop: 2, lineHeight: 1.4 }}>{option.desc}</div>}
    </div>
  );
}

function squadNumberBody(p: PlayerView) {
  return <span style={{ fontFamily: "var(--font-display)", fontWeight: 700 }}>{p.squadNumber ?? "–"}</span>;
}

function nameBody(p: PlayerView) {
  return <span className="squad-player-cell"><PlayerName player={p} showPosition={false} preferNickname showSuspended={false} showInjury={false} customTooltips /></span>;
}

function ratingBody(p: PlayerView) {
  return (
    <span style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "1.2rem" }}>
      {p.overall}
    </span>
  );
}

function energyBody(p: PlayerView) {
  return <RatingBar value={p.energy} color={energyColor(p.energy)} />;
}

function conditionBody(p: PlayerView) {
  const condition = p.conditionLabel ?? "normal";
  const injuryDays = p.injuryDaysRemaining ?? p.injuryDays;
  const conditionText = condition === "injured"
    ? `${conditionTextKey(condition)} · ${i18n.t("squad.returnsIn", { count: injuryDays })}`
    : `${conditionTextKey(condition)}${(p.injuryDaysRemaining ?? 0) > 0 ? ` · ${p.injuryDaysRemaining}d` : ""}`;
  const suspensionText = i18n.t("squad.suspendedFor", { count: p.suspendedGames });
  const yellowWarningText = i18n.t("squad.yellowCardWarning");
  const Icon = conditionIcon(condition);
  return (
    <span className="squad-condition-icons">
      <button
        type="button"
        className="squad-condition squad-tooltip-trigger"
        data-pr-tooltip={conditionText}
        aria-label={conditionText}
        style={{ color: condition === "needsRest" || condition === "injured" ? "var(--red-2)" : "var(--text-2)" }}
      >
        <span className="squad-condition-icon">
          <Icon size={16} aria-hidden="true" />
          {condition === "injured" && injuryDays > 0 && <span className="squad-injury-days" aria-hidden="true">{injuryDays}</span>}
        </span>
      </button>
      {p.yellowWarning && (
        <button
          type="button"
          className="squad-yellowcard squad-tooltip-trigger"
          data-pr-tooltip={yellowWarningText}
          aria-label={yellowWarningText}
        >
          <Square size={15} fill="currentColor" strokeWidth={1.5} aria-hidden="true" />
        </button>
      )}
      {p.suspended && (
        <button
          type="button"
          className="squad-suspension squad-tooltip-trigger"
          data-pr-tooltip={suspensionText}
          aria-label={suspensionText}
        >
          <ShieldAlert size={16} aria-hidden="true" />
        </button>
      )}
    </span>
  );
}

function valueBody(p: PlayerView) {
  return money(p.value);
}

function salaryBody(p: PlayerView) {
  return money(p.salary);
}

function contractBody(p: PlayerView & { contractSeasons: number }) {
  return (
    <span
      className={`squad-contract${p.contractSeasons <= 1 ? " squad-tooltip-trigger" : ""}`}
      data-pr-tooltip={p.contractSeasons <= 1 ? "Contract expires this season" : undefined}
      aria-label={p.contractSeasons <= 1 ? `${p.contractSeasons === 0 ? "Expired" : `${p.contractSeasons} S`}. Contract expires this season` : undefined}
      tabIndex={p.contractSeasons <= 1 ? 0 : undefined}
      style={{ display: "inline-flex", alignItems: "center", gap: 5 }}
    >
      {p.contractSeasons <= 1 && <AlertTriangle size={14} style={{ color: "var(--gold-2)" }} aria-label="Expiring contract" />}
      {p.contractSeasons === 0 ? "Expired" : `${p.contractSeasons} S`}
    </span>
  );
}

function historyEventLabel(type: number): string {
  switch (type) {
    case 1: return "Goal";
    case 2: return "Yellow card";
    case 3: return "Red card";
    case 4: return "Second yellow";
    case 5: return "Injury";
    case 6: return "Substitution";
    case 7: return "Missed penalty";
    default: return "Match event";
  }
}

function historyEventIcon(type: number) {
  if (type === 1) return <Target size={14} />;
  if (type === 2) return <Square size={13} fill="currentColor" />;
  if (type === 3 || type === 4) return <ShieldAlert size={14} />;
  if (type === 5) return <HeartPulse size={14} />;
  if (type === 6) return <Users size={14} />;
  if (type === 7) return <AlertTriangle size={14} />;
  return <Activity size={14} />;
}

function historyEventTone(type: number): string {
  if (type === 1) return "goal";
  if (type === 2) return "yellow";
  if (type === 3 || type === 4 || type === 5) return "danger";
  return "neutral";
}
// Helpers retained for potential future use; Match Events tab was replaced by Evolution.
void historyEventLabel; void historyEventIcon; void historyEventTone;

export function Squad() {
  const { t } = useTranslation();
  const snapshot = useGame((s) => s.snapshot);
  const refresh = useGame((s) => s.refresh);
  const isMobile = useIsMobile();
  const maxContractSeasons = useSettings((s) => s.maxContractSeasons);
  const seniorSquadLimit = useSettings((s) => s.seniorSquadLimit);
  const academyAutomaticPromotionAge = useSettings((s) => s.academyAutomaticPromotionAge);
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
  const [tacticsJustSaved, setTacticsJustSaved] = useState(false);
  const [trainingFocus, setTrainingFocus] = useState<TrainingFocus>(snapshot?.club?.trainingFocus ?? "assistant");
  const toast = useRef<Toast>(null);
  const user = useGame((s) => s.user);
  const [nicknameInput, setNicknameInput] = useState("");
  const [nicknameBusy, setNicknameBusy] = useState(false);
  const [numberInput, setNumberInput] = useState<number | null>(null);
  const [numberBusy, setNumberBusy] = useState(false);
  const [playerPanelTab, setPlayerPanelTab] = useState<PlayerPanelTab>("customization");
  const [historySectionTab, setHistorySectionTab] = useState<HistorySectionTab>("seasons");
  const [historyData, setHistoryData] = useState<SquadHistoryData | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [filter, setFilter] = useState("");
  const [positionFilter, setPositionFilter] = useState<string[]>([]);
  const [sellTarget, setSellTarget] = useState<PlayerView | null>(null);
  const [countryNames, setCountryNames] = useState<Record<string, string>>({});
  const tooltipRef = useRef<Tooltip>(null);
  const tooltipHandlersRef = useRef(new Map<HTMLElement, { show: EventListener; hide: EventListener }>());
  const seasonsOf = (days: number) => {
    const per = snapshot?.save.seasonDays;
    if (!per) return `${days}d`;
    const s = Math.round(days / per);
    return `${s} season${s === 1 ? "" : "s"}`;
  };

  useEffect(() => {
    const syncTooltipTargets = () => {
      const targets = new Set(Array.from(document.querySelectorAll<HTMLElement>(".squad-tooltip-trigger")));
      for (const [target, handlers] of tooltipHandlersRef.current) {
        if (targets.has(target)) continue;
        target.removeEventListener("mouseenter", handlers.show);
        target.removeEventListener("mouseleave", handlers.hide);
        target.removeEventListener("focus", handlers.show);
        target.removeEventListener("blur", handlers.hide);
        tooltipHandlersRef.current.delete(target);
      }
      for (const target of targets) {
        if (tooltipHandlersRef.current.has(target)) continue;
        const show: EventListener = (event) => tooltipRef.current?.show(event as never);
        const hide: EventListener = (event) => tooltipRef.current?.hide(event as never);
        target.addEventListener("mouseenter", show);
        target.addEventListener("mouseleave", hide);
        target.addEventListener("focus", show);
        target.addEventListener("blur", hide);
        tooltipHandlersRef.current.set(target, { show, hide });
      }
    };
    syncTooltipTargets();
    const observer = new MutationObserver(syncTooltipTargets);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      for (const [target, handlers] of tooltipHandlersRef.current) {
        target.removeEventListener("mouseenter", handlers.show);
        target.removeEventListener("mouseleave", handlers.hide);
        target.removeEventListener("focus", handlers.show);
        target.removeEventListener("blur", handlers.hide);
      }
      tooltipHandlersRef.current.clear();
      tooltipRef.current?.hide();
    };
  }, []);

  const club = snapshot?.club;
  // plans/6 §17 UI: familiarity bars for the drafted tactic combination. The
  // server computes all projections; when an unsaved formation is picked on
  // the board the projections would not match, so we show the saved value only.
  const clubTactics = club?.tactics ?? null;
  const formationSaved = !clubTactics || tactics.formation === clubTactics.formation;
  const draftMatchesSaved =
    !!clubTactics && formationSaved &&
    tactics.style === clubTactics.style && tactics.pressing === clubTactics.pressing && tactics.direction === clubTactics.direction;
  const draftProjection = clubTactics?.projections?.find(
    (p) => p.style === tactics.style && p.pressing === tactics.pressing && p.direction === tactics.direction
  )?.familiarity ?? null;
  const shownFamiliarity = draftMatchesSaved ? clubTactics?.familiarity : formationSaved ? draftProjection : null;
  const seniors = snapshot?.squad ?? [];
  const juniors = snapshot?.juniors ?? [];
  const rows = tab === "juniors" ? juniors : seniors;
  const seasonDays = snapshot?.save.seasonDays ?? 30;
  const tableRows = useMemo(
    () => rows.map((player) => ({
      ...player,
      contractSeasons: player.contractDays > 0 ? Math.ceil(player.contractDays / seasonDays) : 0,
    })),
    [rows, seasonDays]
  );
  const filteredRows = useMemo(() => {
    const query = filter.trim().toLowerCase();
    return tableRows.filter((player) => {
      const nameMatches = !query || (player.displayName ?? player.name).toLowerCase().includes(query);
      const positionMatches = positionFilter.length === 0 || positionFilter.includes(player.naturalPosition);
      return nameMatches && positionMatches;
    });
  }, [tableRows, filter, positionFilter]);

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
      toast.current?.show({ severity: "success", summary: t("squad.contractDone") });
      setShowRenew(false);
      refresh();
    } catch (e) {
      toast.current?.show({ severity: "error", summary: t("squad.errorTitle"), detail: (e as Error).message });
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
      toast.current?.show({ severity: "success", summary: t("squad.trainingFocusSaved") });
      await refresh();
    } catch (e) {
      toast.current?.show({ severity: "error", summary: t("squad.errorTitle"), detail: (e as Error).message });
    }
  };

  const saveTactics = async () => {
    if (false) return;
    try {
      await api.setTactics({ style: tactics.style, pressing: tactics.pressing, direction: tactics.direction });
      toast.current?.show({ severity: "success", summary: t("squad.tacticsSaved") });
      setTacticsJustSaved(true);
      window.setTimeout(() => setTacticsJustSaved(false), 3000);
      refresh();
    } catch (e) {
      toast.current?.show({ severity: "error", summary: t("squad.errorTitle"), detail: (e as Error).message });
    }
  };

  const loanAction = async (p: PlayerView) => {
    if (false) return;
    const action = p.loanId === null ? "offer" : "recall";
    try {
      if (action === "offer") await api.offerLoan(p.id);
      else if (p.loanId !== null) await api.cancelLoan(p.loanId);
      toast.current?.show({ severity: "success", summary: action === "offer" ? t("squad.listedForLoan") : t("squad.playerRecalled") });
      await refresh();
    } catch (e) {
      toast.current?.show({ severity: "error", summary: t("squad.errorTitle"), detail: (e as Error).message });
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
      toast.current?.show({ severity: "error", summary: t("squad.errorTitle"), detail: (e as Error).message });
    } finally {
      setConfirmBusy(false);
    }
  };

  const academyAction = async (p: PlayerView, action: "promote" | "dismiss") => {
    if (action === "dismiss") {
      confirm(
        t("squad.releaseFromAcademy"),
        t("squad.releaseFromAcademyConfirm", { name: p.name }),
        async () => {
          await api.academyAction(p.id, "dismiss");
          toast.current?.show({ severity: "success", summary: t("squad.releaseDone") });
          await refresh();
        },
      );
      return;
    }
    // Promotion neither negotiates a salary nor asks for a term, so the only
    // thing to confirm is that the existing academy deal carries over unchanged.
    let preview: Awaited<ReturnType<typeof api.academyPromotionPreview>> | null = null;
    try {
      preview = await api.academyPromotionPreview(p.id);
    } catch (e) {
      toast.current?.show({ severity: "error", summary: t("squad.errorTitle"), detail: (e as Error).message });
      return;
    }
    if (!preview.eligibleForVoluntaryPromotion) {
      toast.current?.show({
        severity: "warn",
        summary: t("squad.notYetEligible"),
        detail: t("squad.promotionEligibility", { name: p.name, age: preview.voluntaryPromotionAge, autoAge: preview.automaticPromotionAge }),
      });
      return;
    }
    if (preview.seniorRosterError) {
      toast.current?.show({ severity: "warn", summary: t("squad.noSeniorSlot"), detail: preview.seniorRosterError });
      return;
    }
    confirm(
      t("squad.promotePlayer"),
      t("squad.promoteConfirm", { name: p.name, salary: money(preview.retainedSalary), seasons: seasonsOf(preview.retainedContractDays), age: preview.contractEndAge }),
      async () => {
        await api.academyAction(p.id, "promote");
        toast.current?.show({ severity: "success", summary: t("squad.playerPromoted") });
        await refresh();
      },
    );
  };

  const releasePlayer = (p: PlayerView) => {
    if (false) return;
    const projectedCushion = club?.finance
      ? club.finance.financialCushion - p.releaseClause + p.salary * club.finance.remainingSeasonFraction
      : null;
    const warning = projectedCushion !== null && projectedCushion < 0
      ? ` ${t("squad.releaseCushionWarning", { amount: money(projectedCushion) })}`
      : "";
    confirm(
      t("squad.release"),
      `${t("squad.releaseConfirm", { name: p.name })}${warning}`,
      async () => {
        const res = await api.releasePlayer(p.id);
        toast.current?.show({
          severity: "success",
          summary: t("squad.releaseDone"),
          detail: res.cost > 0 ? t("squad.paidReleaseClause", { amount: money(res.cost) }) : undefined,
        });
        await refresh();
      }
    );
  };

  const selectedPlayer = selected ?? rows[0];
  const selectedTablePlayer = selectedPlayer ? tableRows.find((player) => player.id === selectedPlayer.id) ?? null : null;
  const selectedCountryName = selectedPlayer ? countryNames[selectedPlayer.country] ?? selectedPlayer.country : "";
  const selectedCountryFlag = selectedPlayer ? countryFlag(selectedPlayer.country) : null;

  useEffect(() => {
    if (selectedPlayer) {
      setNicknameInput(selectedPlayer.nickname ?? "");
      setNumberInput(selectedPlayer.squadNumber ?? null);
      setPlayerPanelTab("customization");
      setHistorySectionTab("seasons");
      setHistoryData(null);
      setHistoryError(null);
    }
  }, [selectedPlayer?.id, selectedPlayer?.nickname, selectedPlayer?.squadNumber]);

  // Numbers already worn by squadmates; selecting one swaps the two players.
  const takenNumbers = useMemo(
    () => new Map(
      rows.filter((p) => p.id !== selectedPlayer?.id && typeof p.squadNumber === "number").map((p) => [p.squadNumber as number, p]),
    ),
    [rows, selectedPlayer?.id]
  );
  const numberOptions = useMemo(
    () => Array.from({ length: 99 }, (_, i) => i + 1).map((n) => ({
      label: takenNumbers.has(n) ? `${n} — ${takenNumbers.get(n)!.displayName ?? takenNumbers.get(n)!.name} (swap)` : `${n}`,
      value: n,
    })),
    [takenNumbers]
  );
  const numberSwapHint = numberInput !== null && numberInput !== selectedPlayer?.squadNumber && takenNumbers.has(numberInput);

  const saveNumber = async () => {
    if (!selectedPlayer || numberInput === null) return;
    setNumberBusy(true);
    try {
      const res = await api.setPlayerNumber(selectedPlayer.id, numberInput);
      toast.current?.show({
        severity: "success",
        summary: t("squad.numberSaved"),
        detail: res.swappedWithName ? t("squad.numberSwapped", { name: res.swappedWithName }) : t("squad.nowWears", { name: selectedPlayer.name, number: res.number ?? "" }),
      });
      await refresh();
    } catch (e) {
      toast.current?.show({ severity: "error", summary: t("squad.errorTitle"), detail: (e as Error).message });
    } finally {
      setNumberBusy(false);
    }
  };

  const saveNickname = async () => {
    if (!selectedPlayer) return;
    if (!user?.isPro) {
      toast.current?.show({ severity: "warn", summary: t("squad.proRequired"), detail: t("squad.proRequiredDetail") });
      return;
    }
    setNicknameBusy(true);
    try {
      const raw = nicknameInput.trim();
      await api.nicknamePlayer(selectedPlayer.id, raw.length === 0 ? null : raw);
      toast.current?.show({ severity: "success", summary: t("squad.nicknameSaved"), detail: raw ? t("squad.nicknameVisible", { name: raw }) : t("squad.nicknameCleared") });
      await refresh();
    } catch (e) {
      toast.current?.show({ severity: "error", summary: t("squad.errorTitle"), detail: (e as Error).message });
    } finally {
      setNicknameBusy(false);
    }
  };

  const openHistory = async (p: PlayerView) => {
    setPlayerPanelTab("history");
    if (historyData !== null && historyData.player.id === p.id) return;
    setHistoryBusy(true);
    setHistoryData(null);
    setHistoryError(null);
    try {
      const data = await api.playerHistory(p.id);
      setHistoryData(data as unknown as SquadHistoryData);
    } catch (e) {
      toast.current?.show({ severity: "error", summary: t("squad.history"), detail: (e as Error).message });
      setHistoryError((e as Error).message);
    } finally {
      setHistoryBusy(false);
    }
  };

  return (
    <div>
      <Toast ref={toast} position="bottom-right" />
      <Tooltip ref={tooltipRef} position="top" className="squad-tooltip" />
      <div className="page-head">
        <div>
          <div className="kicker">{club?.name ?? t("squad.title")}</div>
          <h1>{tab === "juniors" ? t("squad.juniors") : tab === "tactics" ? t("squad.tactics") : t("squad.seniors")}</h1>
        </div>
        <Segmented<Tab>
          value={tab}
          onChange={setTab}
          items={[
            { value: "seniors", label: t("squad.seniors"), icon: <Users size={14} />, count: seniors.length },
            { value: "juniors", label: t("squad.juniors"), icon: <Dumbbell size={14} />, count: juniors.length },
            { value: "tactics", label: t("squad.tactics"), icon: <ShieldCheck size={14} /> },
          ]}
        />
      </div>

      {seniors.length > seniorSquadLimit && (
        <div className="card" style={{ marginBottom: 12, padding: 12, borderColor: "var(--gold-2)", color: "var(--gold-2)" }}>
          <b>{t("squad.overLimit", { count: seniors.length, limit: seniorSquadLimit, age: academyAutomaticPromotionAge })}</b>
        </div>
      )}

      {tab === "tactics" ? (
        <>
          <div className="grid" style={{ gridTemplateColumns: isMobile ? "1fr" : "minmax(0, 3fr) minmax(0, 2fr)", alignItems: "start", gap: 16 }}>
            <div className="card">
              <h2 className="card-title"><ShieldCheck size={17} /> {t("squad.tactics")}</h2>
              <TacticsBoard mode="club" onFormationChange={setBoardFormation} customTooltips />
            </div>
          <div className="card">
            <h2 className="card-title"><Clapperboard size={17} /> {t("squad.matchStrategy")}</h2>
            <div className="form-group">
              <label htmlFor="tac-style">{t("squad.style")}</label>
              <Dropdown id="tac-style" value={tactics.style} options={styleOptions()} itemTemplate={tacticItemTemplate} onChange={(e) => setTactics({ ...tactics, style: e.value })} style={{ width: "100%" }} />
            </div>
            <div className="form-group">
              <label htmlFor="tac-press">{t("squad.pressing")}</label>
              <Dropdown id="tac-press" value={tactics.pressing} options={pressingOptions()} itemTemplate={tacticItemTemplate} onChange={(e) => setTactics({ ...tactics, pressing: e.value })} style={{ width: "100%" }} />
            </div>
            <div className="form-group">
              <label htmlFor="tac-dir">{t("squad.direction")}</label>
              <Dropdown id="tac-dir" value={tactics.direction} options={directionOptions()} itemTemplate={tacticItemTemplate} onChange={(e) => setTactics({ ...tactics, direction: e.value })} style={{ width: "100%" }} />
            </div>
            {clubTactics?.familiarity !== undefined && (
              <div className="form-group">
                <label>{t("squad.tacticalFamiliarity")}</label>
                <FamiliarityBar value={shownFamiliarity ?? clubTactics.familiarity} projected={draftMatchesSaved ? null : formationSaved ? draftProjection : null} customTooltips />
                <div style={{ color: "var(--text-3)", fontSize: "0.82rem", marginTop: 7, lineHeight: 1.5 }}>
                  {t("squad.familiarityHint")}
                </div>
              </div>
            )}
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <button className="btn" onClick={saveTactics} style={{ flex: 1 }}>
                {t("common.save")}
              </button>
              {tacticsJustSaved && (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "var(--grass-2)", fontWeight: 700, fontSize: "0.9rem", whiteSpace: "nowrap" }}>
                  <ShieldCheck size={15} /> {t("squad.saved")}
                </span>
              )}
            </div>
            <div className="form-group" style={{ marginTop: 18 }}>
              <label htmlFor="training-focus">{t("squad.trainingFocus")}</label>
              <Dropdown
                id="training-focus"
                value={trainingFocus}
                options={[
                  { label: t("squad.trainingAssistant"), desc: t("squad.trainingAssistantDesc"), value: "assistant" },
                  { label: t("squad.trainingPrimary"), desc: t("squad.trainingPrimaryDesc"), value: "primary" },
                  { label: t("squad.trainingSecondary"), desc: t("squad.trainingSecondaryDesc"), value: "secondary" },
                ]}
                itemTemplate={(option) => (
                  <div>
                    <div style={{ fontWeight: 600 }}>{option.label}</div>
                    <div style={{ fontSize: "0.8rem", opacity: 0.85, marginTop: 2, lineHeight: 1.4 }}>{option.desc}</div>
                  </div>
                )}
                onChange={(e) => void saveTrainingFocus(e.value as TrainingFocus)}
                style={{ width: "100%" }}
              />
              <div style={{ color: "var(--text-3)", fontSize: "0.82rem", marginTop: 7, lineHeight: 1.5 }}>
                {t("squad.trainingHint")}
              </div>
            </div>
            <div style={{ color: "var(--text-3)", fontSize: "0.82rem", marginTop: 12, lineHeight: 1.5 }}>
              {t("squad.tacticsHint")}
            </div>
          </div>
          </div>
          <AutomationPanel formation={boardFormation} customTooltips />
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
                rowClassName={(p) => {
                  if (p.id === selectedPlayer?.id) return "human-row";
                  return p.onLoanOut ? "loan-out-row" : "";
                }}
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
                      placeholder={t("squad.searchPlayer")}
                      aria-label={t("squad.searchPlayer")}
                    />
                    <MultiSelect
                      value={positionFilter}
                      options={POSITION_OPTIONS}
                      onChange={(e) => setPositionFilter(e.value as string[])}
                      optionLabel="label"
                      optionValue="value"
                      placeholder={t("squad.allPositions")}
                      maxSelectedLabels={2}
                      selectedItemsLabel={t("squad.nPositions")}
                      scrollHeight="320px"
                      aria-label={t("squad.filterByPosition")}
                    />
                  </div>
                }
              >
                <Column field="position" header={t("squad.pos")} body={positionBody} sortable style={{ width: isMobile ? "10%" : "7%" }} />
                <Column field="squadNumber" header="#" body={squadNumberBody} sortable style={{ width: "7%" }} />
                <Column field="name" header={t("squad.player")} body={nameBody} sortable style={isMobile ? { width: "25%" } : { width: "18%" }} />
                <Column field="overall" header={t("squad.overall")} body={ratingBody} sortable style={{ width: isMobile ? "9%" : "7%" }} />
                <Column field="age" header={t("squad.age")} sortable style={{ width: isMobile ? "8%" : "6%" }} />
                <Column field="energy" header={t("squad.energy")} body={energyBody} sortable style={{ width: isMobile ? "15%" : "11%" }} />
                <Column
                  field="conditionLabel"
                  header={t("squad.condition")}
                  body={conditionBody}
                  style={{ width: isMobile ? "10%" : "10%" }}
                />
                {!isMobile && <Column field="value" header={t("squad.value")} body={valueBody} sortable style={{ width: "9%" }} />}
                {!isMobile && <Column field="salary" header={t("squad.salary")} body={salaryBody} sortable style={{ width: "9%" }} />}
                <Column field="contractSeasons" header={t("squad.contract")} body={contractBody} sortable style={{ width: "16%" }} />
              </DataTable>
            </div>
          </div>

          {selectedPlayer && (
            <div className="card" key={selectedPlayer.id}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
                <div style={{ minWidth: 0 }}>
                  <h3 style={{ fontSize: "1.35rem" }}>{selectedPlayer.displayName ?? selectedPlayer.name}{selectedPlayer.nickname && <span style={{ color: "var(--gold-2)", fontWeight: 400, fontSize: "0.9rem" }}> “{selectedPlayer.nickname}”</span>}</h3>
                  {selectedPlayer.nickname && <div style={{ color: "var(--text-3)", fontSize: "0.78rem" }}>{t("squad.realName", { name: selectedPlayer.name })}</div>}
                  <div style={{ color: "var(--text-2)", fontSize: "0.86rem", marginTop: 3 }}>
                    <span className="squad-tooltip-trigger" data-pr-tooltip={positionLabel(selectedPlayer.naturalPosition)}>{selectedPlayer.naturalPosition}</span> · {selectedPlayer.age} yrs ·{" "}
                    <span className="squad-tooltip-trigger" data-pr-tooltip={selectedPlayer.country} aria-label={`Country: ${selectedCountryName}`}>
                      {selectedCountryFlag && <span aria-hidden="true">{selectedCountryFlag} </span>}
                      {selectedCountryName}
                    </span>
                    {selectedPlayer.suspendedGames > 0 && <span className="flag-chip" style={{ marginLeft: 6 }}>{t("squad.suspendedChip", { count: selectedPlayer.suspendedGames })}</span>}
                    {!!selectedPlayer.injuryDaysRemaining && selectedPlayer.injuryDaysRemaining > 0 && (
                      <span className="flag-chip squad-tooltip-trigger" style={{ marginLeft: 6 }} data-pr-tooltip={`${t("squad.injuryCause")}: ${selectedPlayer.injuryCause ?? "—"}`}>
                        {t("squad.injuredChip", { returnDay: t("squad.injuredReturn", { day: (selectedPlayer.injuryUntilAbsoluteGameDay ?? 0) + 1 }) })}
                      </span>
                    )}
                    {selectedPlayer.onLoan && <span className="flag-chip fc-loan squad-tooltip-trigger" style={{ marginLeft: 6 }} data-pr-tooltip={t("squad.onLoanFrom", { club: selectedPlayer.loanFromName ?? t("squad.anotherClub") })}>LOAN · {selectedPlayer.loanFromName ?? "—"}</span>}
                    {selectedPlayer.onLoanOut && <span className="flag-chip fc-loan squad-tooltip-trigger" style={{ marginLeft: 6 }} data-pr-tooltip={t("squad.onLoanAt", { club: selectedPlayer.loanClubName ?? t("squad.anotherClub") })}>LOAN · {selectedPlayer.loanClubName ?? "—"}</span>}
                  </div>
                </div>
              </div>

              <div className="segmented squad-player-tabs" role="tablist" aria-label={t("squad.playerPanel")}>
                <button type="button" role="tab" aria-selected={playerPanelTab === "customization"} className={playerPanelTab === "customization" ? "active" : ""} onClick={() => setPlayerPanelTab("customization")}>
                  <Pencil size={14} /> {t("squad.customize")}
                </button>
                <button type="button" role="tab" aria-selected={playerPanelTab === "history"} className={playerPanelTab === "history" ? "active" : ""} onClick={() => { if (!historyBusy) void openHistory(selectedPlayer); }}>
                  <HistoryIcon size={14} /> {t("squad.history")} {historyBusy && "…"}
                </button>
              </div>

              {playerPanelTab === "customization" ? (
                <>
                  <div style={{ marginTop: 14, padding: "12px 14px", border: "1px solid var(--line)", borderRadius: 12, background: "rgba(228,245,235,0.03)" }}>
                    <div className="section-label">{t("squad.nickname")}</div>
                    <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                      <InputText
                        value={nicknameInput}
                        onChange={(e) => setNicknameInput(e.target.value)}
                        placeholder={selectedPlayer.nickname ?? t("squad.addNickname")}
                        maxLength={24}
                        style={{ flex: 1 }}
                        disabled={!user?.isPro}
                        onKeyDown={(e) => { if (e.key === "Enter") void saveNickname(); }}
                      />
                      <button className={`btn${!user?.isPro ? " squad-tooltip-trigger" : ""}`} onClick={() => void saveNickname()} disabled={nicknameBusy || !user?.isPro} data-pr-tooltip={!user?.isPro ? t("squad.proRequired") : undefined} style={{ whiteSpace: "nowrap", minWidth: 96 }}>{nicknameBusy ? t("squad.savingDots") : t("squad.saveNick")}</button>
                    </div>
                    <div style={{ color: "var(--text-3)", fontSize: "0.78rem", marginTop: 6 }}>
                      {user?.isPro
                        ? t("squad.nicknameShown", { name: selectedPlayer.name })
                        : t("squad.proOnlyNicknames")}
                    </div>
                  </div>

                  <div style={{ marginTop: 10, padding: "12px 14px", border: "1px solid var(--line)", borderRadius: 12, background: "rgba(228,245,235,0.03)" }}>
                    <div className="section-label">{t("squad.shirtNumber")}</div>
                    <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
                      <Dropdown
                        value={numberInput}
                        options={numberOptions}
                        onChange={(e) => setNumberInput(e.value as number)}
                        filter
                        style={{ width: 140 }}
                        aria-label={t("squad.shirtNumber")}
                      />
                      <button className="btn" onClick={() => void saveNumber()} disabled={numberBusy || numberInput === selectedPlayer.squadNumber} style={{ whiteSpace: "nowrap", minWidth: 96 }}>{numberBusy ? t("squad.savingDots") : t("squad.saveNumber")}</button>
                      {numberSwapHint && <div style={{ color: "var(--gold-2)", fontSize: "0.8rem" }}>{t("squad.swapsWithWearer")}</div>}
                    </div>
                  </div>
                </>
              ) : (
                <div className="squad-history-panel">
                  {!historyData ? (
                    <div className="squad-history-empty">{historyError ? t("squad.noHistory") : historyBusy ? t("squad.loadingHistory") : t("squad.noHistoryAvailable")}</div>
                  ) : (
                    <>
                      <div className="squad-history-summary">
                        <div className="squad-history-stat"><Target size={14} /><span><small>{t("squad.careerGoals")}</small><strong>{historyData.player.careerGoals}</strong></span></div>
                        <div className="squad-history-stat"><Handshake size={14} /><span><small>{t("squad.careerAssists")}</small><strong>{historyData.player.careerAssists}</strong></span></div>
                        <div className="squad-history-stat"><CalendarDays size={14} /><span><small>{t("squad.seasons")}</small><strong>{historyData.seasons.length + 1}</strong></span></div>
                        <div className="squad-history-stat"><ShieldAlert size={14} /><span><small>{t("squad.cards")}</small><strong>{historyData.player.yellows}Y · {historyData.player.reds}R</strong></span></div>
                        <div className="squad-history-stat"><Trophy size={14} /><span><small>{t("squad.careerMvp")}</small><strong>{historyData.player.careerMvps ?? 0}</strong></span></div>
                      </div>
                      <div className="segmented squad-history-tabs" role="tablist" aria-label={t("squad.historySection")}>
                        <button type="button" role="tab" aria-selected={historySectionTab === "seasons"} className={historySectionTab === "seasons" ? "active" : ""} onClick={() => setHistorySectionTab("seasons")}>
                          <CalendarDays size={13} /> {t("squad.seasonRecords")} <span className="count">{historyData.seasons.length}</span>
                        </button>
                        <button type="button" role="tab" aria-selected={historySectionTab === "transfers"} className={historySectionTab === "transfers" ? "active" : ""} onClick={() => setHistorySectionTab("transfers")}>
                          <Tag size={13} /> {t("transfers.title")} <span className="count">{historyData.transfers.length}</span>
                        </button>
                        <button type="button" role="tab" aria-selected={historySectionTab === "evolution"} className={historySectionTab === "evolution" ? "active" : ""} onClick={() => setHistorySectionTab("evolution")}>
                          <TrendingUp size={13} /> {t("squad.evolution")}
                        </button>
                      </div>

                      <div className="squad-history-scroll">
                        {historySectionTab === "seasons" && (
                          <div className="squad-history-section">
                            {historyData.seasons.length === 0 ? (
                              <div className="squad-history-empty">{t("squad.noPastSeasons")}</div>
                            ) : (
                              <div className="squad-history-list">
                                {historyData.seasons.map((season) => (
                                  <div className="squad-history-row squad-tooltip-trigger" key={season.seasonKey} data-pr-tooltip={`${season.seasonKey} · ${season.clubName}`}>
                                    <strong>{season.seasonKey}</strong>
                                    <span className="squad-history-row-detail">{season.clubName} · {season.appearances} {t("squad.apps")} · {season.goals}G · {season.assists}A · {season.yellows}Y · {season.reds}R{(season.mvps ?? 0) > 0 ? ` · ${season.mvps} ${t("squad.mvpsShort")}` : ""}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )}

                        {historySectionTab === "transfers" && (
                          <div className="squad-history-section">
                            {historyData.transfers.length === 0 ? (
                              <div className="squad-history-empty">{t("squad.noMarketMoves")}</div>
                            ) : (
                              <div className="squad-history-list">
                                {historyData.transfers.map((transfer, index) => (
                                  <div className="squad-history-row" key={`${transfer.seasonKey}-${transfer.type}-${index}`}>
                                    <strong>{transfer.type}</strong>
                                    <span className="squad-history-row-detail">{transfer.seasonKey}</span>
                                    <strong className="squad-history-price">{money(transfer.price)}</strong>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )}

                        {historySectionTab === "evolution" && (
                          <div className="squad-history-section">
                            <div className="squad-history-trends">
                              <PlayerTrendSparkline
                                label={t("squad.overallPerSeason")}
                                values={[...historyData.seasons.map((s) => s.overall), selectedPlayer.overall]}
                              />
                              <PlayerTrendSparkline
                                label={t("squad.marketValuePerSeason")}
                                values={[...historyData.seasons.map((s) => s.value), selectedPlayer.value]}
                                unit="money"
                              />
                              <PlayerScoresBarChart
                                label={t("squad.avgRatingThisSeason")}
                                points={(historyData.matchScores ?? [])
                                  .filter((m) => m.currentSeason)
                                  .map((m) => ({
                                    key: `m${m.matchId}`,
                                    value: m.rating,
                                    title: t("squad.ratingTitle", { result: m.result ?? "", minutes: m.minutesPlayed ?? "?", rating: m.rating != null ? m.rating.toFixed(1) : "NR" }),
                                  }))}
                                maxScore={10}
                                sideValue={historyData.currentSeasonAvg ?? null}
                              />
                              {user?.isPro ? (
                                <PlayerScoresBarChart
                                  label={t("squad.avgRatingPerSeason")}
                                  unit="avg"
                                  points={historyData.seasons.map((s) => ({
                                    key: s.seasonKey,
                                    value: s.avgScore ?? null,
                                    title: `${s.seasonKey} · ${t("squad.avgValue", { value: (s.avgScore ?? 0).toFixed(1) })}`,
                                  })).concat(
                                    historyData.currentSeasonAvg != null ? [{ key: "current", value: historyData.currentSeasonAvg, title: `${t("squad.thisSeason")} · ${t("squad.avgValue", { value: historyData.currentSeasonAvg.toFixed(1) })}` }] : []
                                  )}
                                  maxScore={10}
                                />
                              ) : (
                                <div className="player-trend player-trend-empty">
                                  <span className="player-trend-label">{t("squad.avgRatingPerSeason")}</span>
                                  <span className="player-trend-note">{t("squad.proRequiredNote")}</span>
                                </div>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </div>
              )}

              <div className="squad-player-separator" />

              <div style={{ margin: "14px 0 4px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.8rem", color: "var(--text-3)", marginBottom: 5 }}>
                  <span>Overall</span>
                </div>
                <RatingBar value={selectedPlayer.overall} />
              </div>

              <div style={{ margin: "14px 0", padding: "12px 0", borderTop: "1px solid var(--line)", borderBottom: "1px solid var(--line)" }}>
                <div className="section-label" style={{ marginBottom: 2 }}>{t("squad.skillProfile")}</div>
                <PlayerSkillsRadar skills={selectedPlayer.skills} />
              </div>

              <div className="stats-row">
<div className="stat">
                  <div className="label">{t("squad.overall")}</div>
                  <div className="value" style={{ fontSize: "1.15rem" }}>{selectedPlayer.overall}</div>
                </div>
                <div className="stat">
                  <div className="label">{t("squad.releaseClause")}</div>
                  <div className="value" style={{ fontSize: "1.15rem" }}>{money(selectedPlayer.isYouth ? 0 : selectedPlayer.releaseClause)}</div>
                </div>
                <div className="stat">
                  <div className="label">{t("squad.contract")}</div>
                  <div className="value" style={{ fontSize: "1.15rem" }}>{seasonsOf(selectedPlayer.contractDays)}</div>
                </div>
                <div className="stat">
                  <div className="label">{t("squad.season")}</div>
                  <div className="value" style={{ fontSize: "1.15rem" }}>{selectedPlayer.seasonGoals}G {selectedPlayer.seasonAssists}A</div>
                </div>
                <div className="stat">
                  <div className="label">{t("squad.seasonMvp")}</div>
                  <div className="value" style={{ fontSize: "1.15rem" }}>{selectedPlayer.seasonMvps ?? 0}</div>
                </div>
              </div>

              <div className="squad-actions-grid" style={{ marginTop: 16 }}>
                {(() => {
                  const a = squadActionState(selectedPlayer, club);
                  if (a.senior) {
                    return <>
                      <button className="btn squad-action squad-tooltip-trigger" disabled={a.renew.disabled} data-pr-tooltip={a.renew.reason} onClick={() => openRenew(selectedPlayer)}>
                        <FileSignature size={13} /> {t("squad.renew")}
                      </button>
                      <button className="btn ghost squad-action squad-tooltip-trigger" data-pr-tooltip={a.onLoanOut ? undefined : a.loan.reason ?? t("transfers.lendLoanHint")} disabled={a.onLoanOut ? a.recall.disabled : a.loan.disabled} onClick={() => loanAction(selectedPlayer)}>
                        <Handshake size={13} /> {a.onLoanOut ? t("squad.recallFromLoan") : selectedPlayer.loanId === null ? t("squad.offerLoan") : t("squad.recall")}
                      </button>
                      <button className="btn ghost squad-action squad-tooltip-trigger" disabled={a.listed} data-pr-tooltip={a.listed ? t("squad.alreadyOnMarket") : undefined} onClick={() => setSellTarget(selectedPlayer)}>
                        <Tag size={13} /> {t("squad.listForSale")}
                      </button>
                      <button className="btn ghost danger squad-action squad-tooltip-trigger" disabled={a.release.disabled} data-pr-tooltip={a.release.reason} onClick={() => releasePlayer(selectedPlayer)}>
                        <Trash2 size={13} /> {t("squad.release")} <span className="squad-action-price">({money(selectedPlayer.releaseClause ?? 0)})</span>
                      </button>
                    </>;
                  }
                  return <>
                    <button className="btn squad-action squad-tooltip-trigger" disabled={a.promote.disabled} data-pr-tooltip={a.promote.reason} onClick={() => academyAction(selectedPlayer, "promote")}>
                      <TrendingUp size={13} /> {t("squad.promoteYouth")}
                    </button>
                    <button className="btn ghost danger squad-action squad-tooltip-trigger" disabled={a.dismiss.disabled} data-pr-tooltip={a.dismiss.reason} onClick={() => academyAction(selectedPlayer, "dismiss")}>
                      <UserMinus size={13} /> {t("squad.dismissYouth")}
                    </button>
                  </>;
                })()}
              </div>
            </div>
          )}
        </div>
      )}

      <ListForSaleDialog player={sellTarget} onClose={() => setSellTarget(null)} onListed={() => { setSellTarget(null); refresh(); }} customTooltips />

      <Dialog header={t("squad.renew")} visible={showRenew} onHide={() => setShowRenew(false)} dismissableMask style={{ width: 400 }}>
        {selectedPlayer && (
          <>
            <h3 style={{ marginBottom: 4 }}>{selectedPlayer.name}</h3>
            <div style={{ color: "var(--text-3)", fontSize: "0.85rem", marginBottom: 16 }}>
              {t("squad.currentSalaryDemand", { salary: money(selectedPlayer.salary), demand: money(renewDemand), contract: seasonsOf(selectedPlayer.contractDays) })}
            </div>
            <div className="form-group">
              <label htmlFor="renew-seasons">{t("squad.contractAdditionalSeasons")}</label>
              <Dropdown
                id="renew-seasons"
                value={renewSeasons}
                 options={Array.from({ length: maxContractSeasons }, (_, i) => i + 1).map((s) => ({ label: `${s === 1 ? t("squad.oneSeason") : t("squad.nSeasons", { count: s })} - ${money(renewDemandsBySeason[s] ?? renewDemand)}/season`, value: s }))}
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
                {t("squad.renewalCushionWarn", { from: money(finance?.financialCushion ?? 0), to: money(renewalCushion) })}
              </div>
            )}
            <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
              <button className="btn ghost" style={{ flex: 1 }} onClick={() => setShowRenew(false)}>{t("common.cancel")}</button>
              <button className="btn" style={{ flex: 1 }} onClick={renew}>{t("common.confirm")}</button>
            </div>
          </>
        )}
      </Dialog>

      <Dialog header={confirmAction?.title ?? ""} visible={confirmAction !== null} onHide={() => setConfirmAction(null)} dismissableMask style={{ width: 400 }}>
        {confirmAction && (
          <>
            <div style={{ color: "var(--text-2)", lineHeight: 1.5 }}>{confirmAction.message}</div>
            <div style={{ display: "flex", gap: 8, marginTop: 18 }}>
              <button className="btn ghost" style={{ flex: 1 }} disabled={confirmBusy} onClick={() => setConfirmAction(null)}>{t("common.cancel")}</button>
              <button className="btn red" style={{ flex: 1 }} disabled={confirmBusy} onClick={() => void runConfirm()}>{t("common.confirm")}</button>
            </div>
          </>
        )}
      </Dialog>

    </div>
  );
}
