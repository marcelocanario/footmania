import { useEffect, useState } from "react";
import { Settings as SettingsIcon, Timer, Globe2, Clock } from "lucide-react";
import { api } from "../api/client";
import { useGame } from "../store/game";
import { useSettings } from "../store/settings";
import { matchDurationLabel } from "../matchPace";
import { strings } from "../strings";
import { AvailabilityPicker, PRESET_EVENINGS, MIN_SLOTS } from "../components/AvailabilityPicker";

const OPTIONS = [5, 10, 15, 20, 30, 45, 60];
export function SettingsScreen() {
  const { matchDurationMinutes, loading, load, setMatchDurationMinutes } = useSettings();
  const { status, loadStatus } = useGame();
  const [draft, setDraft] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [timezone, setTimezone] = useState(status?.club?.timezone ?? "UTC");
  const [timezoneSaved, setTimezoneSaved] = useState(false);
  const [preferredHours, setPreferredHours] = useState<number[]>(status?.club?.preferredHours ?? PRESET_EVENINGS);
  const [hoursSaved, setHoursSaved] = useState(false);
  const [savingHours, setSavingHours] = useState(false);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (status?.club?.timezone) setTimezone(status.club.timezone);
    if (status?.club?.preferredHours) setPreferredHours(status.club.preferredHours);
  }, [status?.club?.timezone, status?.club?.preferredHours]);

  const value = draft ?? matchDurationMinutes;

  const save = async () => {
    if (draft === null) return;
    setSaving(true);
    try {
      await setMatchDurationMinutes(draft);
      setDraft(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="kicker">Preferences</div>
          <h1>Settings</h1>
        </div>
      </div>

      <div className="card" style={{ maxWidth: 520 }}>
        <h2 className="card-title">
          <Timer size={17} /> {strings.settings.matchDurationTitle}
        </h2>
        <div style={{ color: "var(--text-3)", fontSize: "0.9rem", marginBottom: 14 }}>
          {strings.settings.matchDurationHint}
        </div>

        <div className="form-group">
          <label>{strings.settings.matchDuration}</label>
          <select
            className="select"
            value={value}
            disabled={loading || saving}
            onChange={(e) => {
              setDraft(Number(e.target.value));
              setSaved(false);
            }}
          >
            {OPTIONS.map((n) => (
              <option key={n} value={n}>{matchDurationLabel(n)}</option>
            ))}
          </select>
          <div style={{ color: "var(--text-3)", fontSize: "0.85rem", marginTop: 8 }}>
            {strings.settings.matchDurationPreview}: {matchDurationLabel(value)}
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 6 }}>
          <button className="btn gold" onClick={() => void save()} disabled={saving || draft === null}>
            <SettingsIcon size={15} /> {saving ? strings.common.saving : strings.common.save}
          </button>
          {saved && <span style={{ color: "var(--grass-2)", fontSize: "0.9rem" }}>{strings.settings.saved}</span>}
        </div>
      </div>

      <div className="card" style={{ maxWidth: 520, marginTop: 16 }}>
        <h2 className="card-title"><Globe2 size={17} /> Account timezone</h2>
        <div style={{ color: "var(--text-3)", fontSize: "0.9rem", marginBottom: 14 }}>
          Used for the next season's division clustering. Changing it never moves a club during the current season.
        </div>
        <select className="select" value={timezone} onChange={(e) => { setTimezone(e.target.value); setTimezoneSaved(false); }}>
          {TIMEZONES.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
        <button className="btn" style={{ marginTop: 12 }} onClick={() => void (async () => {
          await api.updateTimezone(timezone);
          await loadStatus();
          setTimezoneSaved(true);
        })()} disabled={!status?.club}>{timezoneSaved ? "Saved" : "Save timezone"}</button>
      </div>

      <div className="card" style={{ maxWidth: 640, marginTop: 16 }}>
        <h2 className="card-title"><Clock size={17} /> Preferred match times</h2>
        <div style={{ color: "var(--text-3)", fontSize: "0.9rem", marginBottom: 14 }}>
          When can you usually play? Fixtures are scheduled inside these windows whenever possible. Changes apply from the next season's fixture generation — current fixtures never move.
        </div>
        <AvailabilityPicker value={preferredHours} onChange={(next) => { setPreferredHours(next); setHoursSaved(false); }} disabled={!status?.club} />
        <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 12 }}>
          <button
            className="btn gold"
            onClick={() => void (async () => {
              setSavingHours(true);
              try {
                await api.updatePreferredHours(preferredHours);
                await loadStatus();
                setHoursSaved(true);
                setTimeout(() => setHoursSaved(false), 2000);
              } finally {
                setSavingHours(false);
              }
            })()}
            disabled={!status?.club || savingHours || preferredHours.length < MIN_SLOTS}
          >
            <SettingsIcon size={15} /> {savingHours ? strings.common.saving : strings.common.save}
          </button>
          {hoursSaved && <span style={{ color: "var(--grass-2)", fontSize: "0.9rem" }}>{strings.settings.saved}</span>}
        </div>
      </div>
    </div>
  );
}

const TIMEZONES = [
  "UTC", "America/Los_Angeles", "America/Denver", "America/Chicago", "America/New_York",
  "America/Sao_Paulo", "Europe/London", "Europe/Paris", "Europe/Berlin", "Africa/Cairo",
  "Asia/Dubai", "Asia/Kolkata", "Asia/Singapore", "Asia/Tokyo", "Asia/Seoul",
  "Australia/Sydney", "Pacific/Auckland",
];
