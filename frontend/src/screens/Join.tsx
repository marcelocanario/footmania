import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Dropdown } from "primereact/dropdown";
import { InputText } from "primereact/inputtext";
import { Toast } from "primereact/toast";
import { useRef } from "react";
import { Flag, Home, Palette, Play, Shield, Info } from "lucide-react";
import { api, type CountryOption, type MpStatus } from "../api/client";
import { strings } from "../strings";
import { useGame } from "../store/game";

const TIMEZONES = [
  "America/Los_Angeles", "America/Denver", "America/Chicago", "America/New_York",
  "America/Sao_Paulo", "Europe/London", "Europe/Lisbon", "Europe/Paris",
  "Europe/Madrid", "Europe/Berlin", "Europe/Rome", "Europe/Amsterdam",
  "Europe/Athens", "Africa/Cairo", "Asia/Dubai", "Asia/Karachi", "Asia/Kolkata",
  "Asia/Bangkok", "Asia/Singapore", "Asia/Shanghai", "Asia/Tokyo", "Asia/Seoul",
  "Australia/Sydney", "Pacific/Auckland",
];

const COLORS: { label: string; primary: string; secondary: string }[] = [
  { label: "Classic Red", primary: "#d40000", secondary: "#ffffff" },
  { label: "Royal Blue", primary: "#003399", secondary: "#ffffff" },
  { label: "Forest Green", primary: "#008000", secondary: "#ffffff" },
  { label: "Orange", primary: "#ff6600", secondary: "#000000" },
  { label: "Purple", primary: "#660099", secondary: "#ffffff" },
  { label: "Black & White", primary: "#111111", secondary: "#ffffff" },
  { label: "Sky Blue", primary: "#0099cc", secondary: "#ffffff" },
  { label: "Gold", primary: "#cc9900", secondary: "#000000" },
  { label: "Dark Green", primary: "#006633", secondary: "#ffffff" },
  { label: "Maroon", primary: "#990000", secondary: "#ffffff" },
];

interface CountryGroup {
  label: string;
  items: CountryOption[];
}

export function Join() {
  const { loadStatus, loadClub, setLiveMatch } = useGame();
  const navigate = useNavigate();
  const toast = useRef<Toast>(null);
  const [status, setStatus] = useState<MpStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [clubName, setClubName] = useState("");
  const [selectedCountry, setSelectedCountry] = useState<string | null>(null);
  const [timezone, setTimezone] = useState<string>("America/Sao_Paulo");
  const [colorIdx, setColorIdx] = useState(0);
  const [stadiumName, setStadiumName] = useState("");
  const [joining, setJoining] = useState(false);
  const [countries, setCountries] = useState<CountryOption[]>([]);
  const [featured, setFeatured] = useState<CountryOption[]>([]);

  const refresh = async () => {
    setLoading(true);
    try {
      const st = await loadStatus();
      setStatus(st);
    } catch (e) {
      toast.current?.show({ severity: "error", summary: "Error", detail: (e as Error).message });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    api
      .countries()
      .then((res) => {
        setFeatured(res.featuredCountries);
        setCountries(res.allCountries);
      })
      .catch(() => undefined);
  }, []);

  const countryGroups: CountryGroup[] = [
    { label: "Featured", items: featured },
    { label: "All countries", items: countries },
  ];
  const countryOptions = useMemo(
    () =>
      countryGroups
        .map((g) => ({ label: g.label, items: g.items.map((c) => ({ label: c.name, value: c.code })) }))
        .filter((g) => g.items.length > 0),
    [featured, countries]
  );

  const hasClub = !!status?.club;
  const clubState = status?.club?.competitionState;
  const isDormant = clubState === "DORMANT";
  const isProvisional = clubState === "PROVISIONAL";
  const [returning, setReturning] = useState(false);
  const [practice, setPractice] = useState<{ homeGoals: number; awayGoals: number; opponentName: string } | null>(null);

  const returnToPyramid = async () => {
    setReturning(true);
    try {
      await api.returnClub();
      setLiveMatch(null);
      await loadStatus();
      await loadClub();
      navigate("/dashboard");
    } catch (e) {
      toast.current?.show({ severity: "error", summary: "Error", detail: (e as Error).message });
      setReturning(false);
    }
  };

  const playPractice = async () => {
    try {
      const res = await api.practice();
      setPractice({ homeGoals: res.homeGoals, awayGoals: res.awayGoals, opponentName: res.opponentName });
    } catch (e) {
      toast.current?.show({ severity: "error", summary: "Error", detail: (e as Error).message });
    }
  };

  const join = async () => {
    if (!selectedCountry || !clubName.trim()) {
      toast.current?.show({ severity: "warn", summary: "Missing info", detail: "Pick a country and a club name." });
      return;
    }
    setJoining(true);
    try {
      const color = COLORS[colorIdx];
      await api.join({
        clubName: clubName.trim(),
        country: selectedCountry,
        timezone,
        primaryColor: color.primary,
        secondaryColor: color.secondary,
        stadiumName: stadiumName.trim() || undefined,
      });
      setLiveMatch(null);
      await loadStatus();
      await loadClub();
      navigate("/dashboard");
    } catch (e) {
      toast.current?.show({ severity: "error", summary: "Error", detail: (e as Error).message });
      setJoining(false);
    }
  };

  if (loading) {
    return <div className="empty-state" style={{ paddingTop: 80 }}>{strings.common.loading}</div>;
  }

  if (hasClub) {
    return (
      <div>
        <div className="page-head">
          <div>
            <div className="kicker">{strings.saves.startNew}</div>
            <h1>{strings.saves.title}</h1>
          </div>
        </div>
        <div className="card" style={{ maxWidth: 560 }}>
          <div style={{ fontSize: 30, marginBottom: 10 }}>⚽</div>
          <h2 style={{ marginBottom: 6 }}>You already manage {status?.club?.name}</h2>
          {isDormant && (
            <div style={{ color: "var(--text-2)", marginBottom: 16 }}>
              Your club went dormant after a long period without activity. It kept all its players, money and history. Return now to re-enter the pyramid at the lowest available tier — or wait for the join lock and enter as provisional.
            </div>
          )}
          {isProvisional && (
            <div style={{ color: "var(--text-2)", marginBottom: 16 }}>
              Your club is provisional: it will enter the league next season. You can still manage your squad, trades, tactics and play non-persistent practice matches while you wait.
            </div>
          )}
          {!isDormant && !isProvisional && (
            <div style={{ color: "var(--text-2)", marginBottom: 16 }}>
              Your club is ready. Head to the dashboard to see your squad, fixtures and league position.
            </div>
          )}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {isDormant ? (
              <button className="btn gold" style={{ fontSize: "1.05rem" }} onClick={() => void returnToPyramid()} disabled={returning}>
                <Play size={16} /> {returning ? "Returning…" : "Return to the pyramid"}
              </button>
            ) : (
              <button className="btn gold" style={{ fontSize: "1.05rem" }} onClick={() => navigate("/dashboard")}>
                <Play size={16} /> {strings.dashboard.continue}
              </button>
            )}
            {isProvisional && (
              <button className="btn" style={{ fontSize: "1.05rem" }} onClick={() => void playPractice()}>
                <Shield size={16} /> Play practice match
              </button>
            )}
          </div>
          {isProvisional && practice && (
            <div className="card" style={{ marginTop: 16, padding: 12, borderColor: "rgba(240,180,41,0.4)" }}>
              <b>{status?.club?.name} {practice.homeGoals} – {practice.awayGoals} {practice.opponentName}</b>
              <div style={{ color: "var(--text-3)", fontSize: "0.82rem", marginTop: 4 }}>
                Practice results are non-persistent: no points, no player progression, no injuries.
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  const season = status?.season;
  const joinOpen = season?.joinState === "OPEN";

  return (
    <div>
      <Toast ref={toast} />
      <div className="page-head">
        <div>
          <div className="kicker">{strings.saves.startNew}</div>
          <h1>{strings.saves.createTeam}</h1>
        </div>
      </div>

      {season && (
        <div className="card" style={{ borderColor: joinOpen ? "rgba(61,220,132,0.4)" : "rgba(240,180,41,0.4)", marginBottom: 16 }}>
          <div className="kicker">Season {season.key}</div>
          <div style={{ fontWeight: 600, marginTop: 4 }}>
            {joinOpen
              ? `Joining is open — round ${season.completedRounds}/${season.joinLockRound} before the join lock.`
              : `Joining is locked for this season (round ${season.completedRounds} of ${season.joinLockRound} reached). You'll enter next season as a provisional club.`}
          </div>
        </div>
      )}

      <div className="card" style={{ maxWidth: 620 }}>
        <p style={{ color: "var(--text-2)", marginTop: 0 }}>{strings.saves.createTeamHint}</p>

        <div style={{ display: "grid", gap: 14 }}>
          <div>
            <label className="field-label" style={{ display: "block", marginBottom: 6, fontWeight: 600 }}>{strings.saves.country}</label>
            <Dropdown
              value={selectedCountry}
              options={countryOptions}
              optionGroupLabel="label"
              optionGroupChildren="items"
              onChange={(e) => setSelectedCountry(e.value)}
              filter
              filterBy="label"
              showClear
              placeholder="Select country"
              style={{ width: "100%" }}
              aria-label={strings.saves.country}
            />
          </div>

          <div>
            <label className="field-label" style={{ display: "block", marginBottom: 6, fontWeight: 600 }}>{strings.saves.teamName}</label>
            <span className="p-input-icon-left" style={{ width: "100%" }}>
              <Flag size={15} />
              <InputText value={clubName} onChange={(e) => setClubName(e.target.value)} placeholder="e.g. Marcelo FC" style={{ width: "100%" }} />
            </span>
          </div>

          <div>
            <label className="field-label" style={{ display: "block", marginBottom: 6, fontWeight: 600 }}>Timezone</label>
            <span className="p-input-icon-left" style={{ width: "100%" }}>
              <Home size={15} />
              <Dropdown
                value={timezone}
                options={TIMEZONES.map((t) => ({ label: t, value: t }))}
                onChange={(e) => setTimezone(e.value)}
                style={{ width: "100%" }}
                aria-label="Timezone"
              />
            </span>
            <div style={{ color: "var(--text-3)", fontSize: "0.82rem", marginTop: 6 }}>
              Used to pair you with clubs in similar timezones when leagues are rebuilt.
            </div>
          </div>

          <div>
            <label className="field-label" style={{ display: "block", marginBottom: 6, fontWeight: 600 }}>{strings.saves.stadium}</label>
            <span className="p-input-icon-left" style={{ width: "100%" }}>
              <Home size={15} />
              <InputText value={stadiumName} onChange={(e) => setStadiumName(e.target.value)} placeholder="Stadium name" style={{ width: "100%" }} />
            </span>
          </div>

          <div>
            <label className="field-label" style={{ display: "block", marginBottom: 6, fontWeight: 600 }}>{strings.saves.colors}</label>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {COLORS.map((c, i) => (
                <button
                  key={c.label}
                  type="button"
                  title={c.label}
                  onClick={() => setColorIdx(i)}
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: 10,
                    background: `linear-gradient(135deg, ${c.primary} 50%, ${c.secondary} 50%)`,
                    border: colorIdx === i ? "2px solid var(--gold-2)" : "1px solid var(--line)",
                    cursor: "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {colorIdx === i && <Palette size={14} color="#fff" style={{ filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.6))" }} />}
                </button>
              ))}
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--text-3)", fontSize: "0.85rem" }}>
            <Info size={14} /> Your club keeps its identity, roster and finances permanently. Joining early lets you take over a top AI slot.
          </div>
        </div>

        <div style={{ marginTop: 18, display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button className="btn gold" onClick={() => void join()} disabled={joining || !selectedCountry || !clubName.trim()}>
            <Shield size={15} /> {joining ? strings.common.loading : strings.saves.continue}
          </button>
        </div>
      </div>
    </div>
  );
}
