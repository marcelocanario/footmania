import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Dropdown } from "primereact/dropdown";
import { Toast } from "primereact/toast";
import { Clapperboard, ShieldCheck } from "lucide-react";
import { api } from "../api/client";
import { useGame } from "../store/game";
import { TacticsBoard } from "../components/TacticsBoard";
import { AutomationPanel } from "../components/AutomationPanel";
import { FamiliarityBar } from "../components/FamiliarityBar";
import { directionOptions, pressingOptions, styleOptions } from "../tacticsOptions";
import { useIsMobile } from "../hooks/useIsMobile";

type TrainingFocus = "assistant" | "primary" | "secondary";

/**
 * Standalone tactics screen (/tactics): starting eleven, match strategy,
 * tactical familiarity, training focus and match automation. Moved verbatim
 * out of the Squad screen so tactics has its own header entry.
 */
export function Tactics() {
  const { t } = useTranslation();
  const snapshot = useGame((s) => s.snapshot);
  const refresh = useGame((s) => s.refresh);
  const isMobile = useIsMobile();
  const [tactics, setTactics] = useState(snapshot?.club?.tactics ? { formation: snapshot.club.tactics.formation, style: snapshot.club.tactics.style, pressing: snapshot.club.tactics.pressing, direction: snapshot.club.tactics.direction } : { formation: 4, style: 0, pressing: 0, direction: 0 });
  // Formation currently picked in the tactics board; scopes the automation panel.
  const [boardFormation, setBoardFormation] = useState<number>(snapshot?.club?.tactics?.formation ?? 4);
  const [tacticsJustSaved, setTacticsJustSaved] = useState(false);
  const [trainingFocus, setTrainingFocus] = useState<TrainingFocus>(snapshot?.club?.trainingFocus ?? "assistant");
  const toast = useRef<Toast>(null);

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

  return (
    <div>
      <Toast ref={toast} position="bottom-right" />
      <div className="page-head">
        <div>
          <div className="kicker">{club?.name ?? t("squad.tactics")}</div>
          <h1>{t("squad.tactics")}</h1>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: isMobile ? "1fr" : "minmax(0, 3fr) minmax(0, 2fr)", alignItems: "start", gap: 16 }}>
        <div className="card">
          <h2 className="card-title"><ShieldCheck size={17} /> {t("squad.tactics")}</h2>
          <TacticsBoard mode="club" onFormationChange={setBoardFormation} customTooltips />
        </div>
        <div className="card">
          <h2 className="card-title"><Clapperboard size={17} /> {t("squad.matchStrategy")}</h2>
          <div className="form-group">
            <label htmlFor="tac-style">{t("squad.style")}</label>
            <Dropdown id="tac-style" value={tactics.style} options={styleOptions()} itemTemplate={(option) => (
              <div>
                <div style={{ fontWeight: 600 }}>{option.label}</div>
                {option.desc && <div style={{ fontSize: "0.8rem", opacity: 0.85, marginTop: 2, lineHeight: 1.4 }}>{option.desc}</div>}
              </div>
            )} onChange={(e) => setTactics({ ...tactics, style: e.value })} style={{ width: "100%" }} />
          </div>
          <div className="form-group">
            <label htmlFor="tac-press">{t("squad.pressing")}</label>
            <Dropdown id="tac-press" value={tactics.pressing} options={pressingOptions()} itemTemplate={(option) => (
              <div>
                <div style={{ fontWeight: 600 }}>{option.label}</div>
                {option.desc && <div style={{ fontSize: "0.8rem", opacity: 0.85, marginTop: 2, lineHeight: 1.4 }}>{option.desc}</div>}
              </div>
            )} onChange={(e) => setTactics({ ...tactics, pressing: e.value })} style={{ width: "100%" }} />
          </div>
          <div className="form-group">
            <label htmlFor="tac-dir">{t("squad.direction")}</label>
            <Dropdown id="tac-dir" value={tactics.direction} options={directionOptions()} itemTemplate={(option) => (
              <div>
                <div style={{ fontWeight: 600 }}>{option.label}</div>
                {option.desc && <div style={{ fontSize: "0.8rem", opacity: 0.85, marginTop: 2, lineHeight: 1.4 }}>{option.desc}</div>}
              </div>
            )} onChange={(e) => setTactics({ ...tactics, direction: e.value })} style={{ width: "100%" }} />
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
    </div>
  );
}
