import { useEffect, useMemo, useState, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Dropdown } from "primereact/dropdown";
import { InputText } from "primereact/inputtext";
import { Toast } from "primereact/toast";
import {
  Flag,
  Home,
  Palette,
  Play,
  Shield,
  Info,
  Clock,
  BadgeCheck,
  Building2,
  Globe2,
  CalendarClock,
  Shirt,
  Sparkles,
  ChevronRight,
  ChevronLeft,
  Check,
  HelpCircle,
  Trophy,
  Users,
  AlertTriangle,
  ArrowRight,
} from "lucide-react";
import { api, type CountryOption, type MpStatus } from "../api/client";
import { AvailabilityPicker, PRESET_EVENINGS, MIN_SLOTS } from "../components/AvailabilityPicker";
import { ClubBadge } from "../components/ClubBadge";
import { FootballKit } from "../components/kit/FootballKit";
import { ColorRow, KitDesigner } from "../components/kit/KitDesigner";
import { applyTeamColorPreset, deriveKitDefaults } from "../components/kit/defaults";
import { PREVIEW_NUMBERS, type ClubKits } from "../components/kit/types";
import { strings } from "../strings";
import { useGame } from "../store/game";

const TIMEZONES = [
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Lisbon",
  "Europe/Paris",
  "Europe/Madrid",
  "Europe/Berlin",
  "Europe/Rome",
  "Europe/Amsterdam",
  "Europe/Athens",
  "Africa/Cairo",
  "Asia/Dubai",
  "Asia/Karachi",
  "Asia/Kolkata",
  "Asia/Bangkok",
  "Asia/Singapore",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Asia/Seoul",
  "Australia/Sydney",
  "Pacific/Auckland",
];

/** Default club identity colors (Classic Red over White). */
const DEFAULT_PRIMARY = "#d40000";
const DEFAULT_SECONDARY = "#ffffff";

type TabId = "identity" | "style" | "schedule";

const TABS: { id: TabId; label: string; icon: React.ReactNode }[] = [
  { id: "identity", label: "Club", icon: <Shield size={16} /> },
  { id: "style", label: "Kit", icon: <Shirt size={16} /> },
  { id: "schedule", label: "Schedule", icon: <CalendarClock size={16} /> },
];

function FieldHelp({ text }: { text: string }) {
  return (
    <span className="jm-help" data-tip={text} tabIndex={0} aria-label={text}>
      <HelpCircle size={14} />
      <span className="jm-help-tip" role="tooltip">
        {text}
      </span>
    </span>
  );
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
  const [teamPrimary, setTeamPrimary] = useState(DEFAULT_PRIMARY);
  const [teamSecondary, setTeamSecondary] = useState(DEFAULT_SECONDARY);
  const [kits, setKits] = useState<ClubKits>(() =>
    applyTeamColorPreset(deriveKitDefaults(DEFAULT_PRIMARY, DEFAULT_SECONDARY), DEFAULT_PRIMARY, DEFAULT_SECONDARY),
  );
  const [stadiumName, setStadiumName] = useState("");
  const [preferredHours, setPreferredHours] = useState<number[]>(PRESET_EVENINGS);
  const [joining, setJoining] = useState(false);
  const [countries, setCountries] = useState<CountryOption[]>([]);
  const [featured, setFeatured] = useState<CountryOption[]>([]);
  const [activeTab, setActiveTab] = useState<TabId>("identity");
  const [entryDiv, setEntryDiv] = useState<string | null>(null);
  const nameTrim = clubName.trim();
  const nameLen = nameTrim.length;
  const nameValid = nameLen >= 3 && nameLen <= 30;
  const stadiumValid = stadiumName.trim().length > 0;
  const stadiumPreviewName = stadiumName.trim() || "Name your stadium";

  /** Team colors seed all three kits as a preset; kits stay editable. */
  const applyTeamColors = (primary: string, secondary: string) => {
    setTeamPrimary(primary);
    setTeamSecondary(secondary);
    setKits((current) => applyTeamColorPreset(current, primary, secondary));
  };

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
    api
      .pyramid()
      .then((res) => {
        if (!res.tiers?.length) return;
        const sorted = [...res.tiers].sort((a, b) => a.tier - b.tier);
        const lowest = sorted[sorted.length - 1];
        const withAI = lowest.divisions.find((d) => d.aiCount > 0) ?? lowest.divisions[0];
        if (withAI) setEntryDiv(`Division ${withAI.name}`);
        else setEntryDiv(`Tier ${lowest.tier}`);
      })
      .catch(() => undefined);
  }, []);

  const countryOptions = useMemo(
    () =>
      [
        { label: "★ Featured", items: featured.map((c) => ({ label: c.name, value: c.code })) },
        { label: "All nations", items: countries.map((c) => ({ label: c.name, value: c.code })) },
      ].filter((g) => g.items.length > 0),
    [featured, countries],
  );

  const selectedCountryObj = useMemo(
    () => [...featured, ...countries].find((c) => c.code === selectedCountry) ?? null,
    [featured, countries, selectedCountry],
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
    if (!selectedCountry || !nameValid || !stadiumValid) {
      toast.current?.show({
        severity: "warn",
        summary: "Complete your club",
        detail: !selectedCountry ? "Choose a country." : !nameValid ? "Club name must be 3–30 characters." : "Name your home ground.",
      });
      setActiveTab("identity");
      return;
    }
    if (preferredHours.length < MIN_SLOTS) {
      toast.current?.show({ severity: "warn", summary: "Availability", detail: `Pick at least ${MIN_SLOTS / 2} hours.` });
      setActiveTab("schedule");
      return;
    }
    setJoining(true);
    try {
      await api.join({
        clubName: clubName.trim(),
        country: selectedCountry,
        timezone,
        primaryColor: teamPrimary,
        secondaryColor: teamSecondary,
        kits,
        stadiumName: stadiumName.trim(),
        preferredHours,
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
      <div className="join-wrap">
        <Toast ref={toast} />
        <div className="page-head">
          <div>
            <div className="kicker">{strings.saves.startNew}</div>
            <h1>{strings.saves.title}</h1>
          </div>
        </div>

        <div className="join-hasclub">
          <div className="join-hasclub-hero">
            <div className="join-hasclub-badge">
              <ClubBadge name={status?.club?.name ?? "?"} size={64} />
            </div>
            <div>
              <div className="join-hasclub-kicker">
                <BadgeCheck size={14} /> Active career
              </div>
              <h2 style={{ margin: "6px 0 4px" }}>You manage {status?.club?.name}</h2>
              <div style={{ color: "var(--text-3)", fontSize: "0.9rem" }}>
                {status?.club?.country} · Division {status?.club?.highestDivision} · {clubState}
              </div>
            </div>
          </div>

          <div className="card" style={{ padding: 0, overflow: "hidden" }}>
            <div className="join-hasclub-body">
              {isDormant ? (
                <div className="join-callout warn">
                  <AlertTriangle size={18} />
                  <div>
                    <b>Dormant club</b>
                    <p>Return at the lowest available tier, or wait for next season.</p>
                  </div>
                </div>
              ) : isProvisional ? (
                <div className="join-callout gold">
                  <Clock size={18} />
                  <div>
                    <b>Provisional — next season entry</b>
                    <p>Manage your squad, transfers and practice matches while you wait.</p>
                  </div>
                </div>
              ) : (
                <div className="join-callout good">
                  <Sparkles size={18} />
                  <div>
                    <b>Ready for matchday</b>
                    <p>Fixtures, tables and live matches are ready.</p>
                  </div>
                </div>
              )}

              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 16 }}>
                {isDormant ? (
                  <button className="btn gold" style={{ fontSize: "1rem" }} onClick={() => void returnToPyramid()} disabled={returning}>
                    <Play size={16} /> {returning ? "Returning…" : "Return to the pyramid"}
                  </button>
                ) : (
                  <button className="btn gold" style={{ fontSize: "1rem" }} onClick={() => navigate("/dashboard")}>
                    <Play size={16} /> {strings.dashboard.continue}
                  </button>
                )}
                {isProvisional ? (
                  <button className="btn" onClick={() => void playPractice()}>
                    <Shield size={16} /> Practice match
                  </button>
                ) : (
                  <button className="btn ghost" onClick={() => navigate("/squad")}>
                    <Users size={16} /> Squad <ArrowRight size={14} />
                  </button>
                )}
                <button className="btn ghost" onClick={() => navigate("/my-club")} title="Edit your club name, stadium and kits">
                  <Shirt size={16} /> Edit team
                </button>
              </div>

              {isProvisional && practice && (
                <div className="jm-practice">
                  <div className="jm-practice-score">
                    <span className="jm-practice-club">{status?.club?.name}</span>
                    <span className="jm-practice-result">
                      {practice.homeGoals} – {practice.awayGoals}
                    </span>
                    <span className="jm-practice-opp">{practice.opponentName}</span>
                  </div>
                  <div className="jm-practice-hint">Practice match · no league impact</div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  const season = status?.season;
  const joinOpen = season?.joinState === "OPEN";
  const identityValid = !!selectedCountry && nameValid && stadiumValid;
  const scheduleValid = preferredHours.length >= MIN_SLOTS;
  const allValid = identityValid && scheduleValid;

  const tabIdx = TABS.findIndex((t) => t.id === activeTab);

  const handleNext = () => {
    if (activeTab === "identity") {
          if (!identityValid) {
            toast.current?.show({
              severity: "warn",
              summary: "Complete your club",
              detail: !selectedCountry ? "Choose a national association." : !nameValid ? "Club name must be 3–30 characters." : "Name your home ground.",
            });
        return;
      }
      setActiveTab("style");
    } else if (activeTab === "style") {
      setActiveTab("schedule");
    } else {
      void join();
    }
  };

  const handleBack = () => {
    if (activeTab === "schedule") setActiveTab("style");
    else if (activeTab === "style") setActiveTab("identity");
  };

  return (
    <div className="join-wrap">
      <Toast ref={toast} />

      {/* HERO — floodlit pitch */}
      <div className="jm-hero">
        <div className="jm-hero-glow" aria-hidden />
        <div className="jm-hero-stripes" aria-hidden />
        <div className="jm-hero-inner">
          <div>
            <div className="kicker" style={{ color: "var(--gold-2)" }}>
              <Sparkles size={13} /> {strings.saves.startNew}
            </div>
            <h1 className="jm-title">
              Create your team
            </h1>
          </div>
          <div className="jm-hero-badge">
            <div className="jm-hero-crest">
              <Trophy size={22} />
            </div>
            <div className="jm-hero-meta">
              <div className="jm-hero-season">{entryDiv ?? "Division —"}</div>
              <div className="jm-hero-round">{season ? (joinOpen ? "Open to join" : "Locked for this season") : "Loading"}</div>
            </div>
          </div>
        </div>
      </div>

      {/* Season status */}
      {season && (
        <div className={`jm-season-banner ${joinOpen ? "open" : "locked"}`}>
          <Info size={17} className="jm-season-icon" />
          <div className="jm-season-copy">
            <b>{joinOpen ? `There is still time to enjoy Season ${season.seasonNumber}` : "The next campaign starts here"}</b>
            <span>
              {joinOpen
                ? `Join before round ${season.joinLockRound} to play this season.`
                : `Season ${season.seasonNumber} is locked. Build your club, play practice matches, and enter the league next season.`}
            </span>
          </div>
          <span className={`jm-season-pill ${joinOpen ? "open" : "locked"}`}>
            {joinOpen ? "Open" : "Locked"}
          </span>
        </div>
      )}

      {/* TABS */}
      <div className="jm-shell">
        <div className="jm-tabs" role="tablist" aria-label="Create team steps">
          {TABS.map((t, idx) => {
            const valid = t.id === "identity" ? identityValid : t.id === "schedule" ? scheduleValid : true;
            const active = t.id === activeTab;
            const done = valid && idx < tabIdx;
            return (
              <button
                key={t.id}
                role="tab"
                aria-selected={active}
                aria-controls={`panel-${t.id}`}
                id={`tab-${t.id}`}
                className={`jm-tab ${active ? "active" : ""} ${done ? "done" : ""}`}
                onClick={() => setActiveTab(t.id)}
              >
                <span className="jm-tab-icon">{done ? <Check size={14} /> : t.icon}</span>
                <span className="jm-tab-text"><b>{t.label}</b></span>
              </button>
            );
          })}
        </div>

        <div className="jm-progress" aria-hidden>
          <div className="jm-progress-track">
            <div className="jm-progress-fill" style={{ width: `${((tabIdx + 1) / TABS.length) * 100}%` }} />
          </div>
        </div>

        {/* MAIN CARD */}
        <div className="jm-card">
          <div className="jm-layout">
            {/* FORM SIDE */}
            <div className="jm-form">
              {/* ── Identity ── */}
              {activeTab === "identity" && (
                <div id="panel-identity" role="tabpanel" aria-labelledby="tab-identity" className="jm-panel animate-in">
                  <div className="jm-panel-head">
                    <h2>
                      <Shield size={18} /> Club & nation
                    </h2>
                    <p>Every great campaign starts with a name, a flag, and a home ground. Choose yours.</p>
                  </div>

                  <div className="jm-field">
                    <label className="jm-label">
                      <Flag size={13} /> {strings.saves.teamName}
                      <FieldHelp text="Enter 3–30 characters. This is the name the crowd sees in tables and match results." />
                      <span className="jm-req">*</span>
                    </label>
                    <span className="p-input-icon-left jm-input-wrap">
                      <BadgeCheck size={15} />
                      <InputText
                        value={clubName}
                        onChange={(e) => setClubName(e.target.value)}
                        placeholder="e.g. John Doe FC, São Paulo United, Aurora SC"
                        maxLength={30}
                        className={clubName.length > 0 && !nameValid ? "jm-invalid" : ""}
                        style={{ width: "100%" }}
                      />
                    </span>
                    <div className="jm-hint-row">
                      <span className={`jm-hint ${nameLen > 0 && !nameValid ? "bad" : ""}`}>
                        {nameLen > 0 && !nameValid ? (nameLen < 3 ? "Minimum 3 characters" : "Maximum 30 characters") : ""}
                      </span>
                      <span className="jm-count">{nameLen}/30</span>
                    </div>
                  </div>

                  <div className="jm-field">
                    <label className="jm-label">
                      <Home size={13} /> {strings.saves.stadium}
                      <FieldHelp text="Name your home ground. It is where your club welcomes opponents on matchday." />
                      <span className="jm-req">*</span>
                    </label>
                    <span className="p-input-icon-left jm-input-wrap">
                      <Building2 size={15} />
                      <InputText
                        value={stadiumName}
                        onChange={(e) => setStadiumName(e.target.value)}
                        placeholder={`${nameTrim || "Your club"} Stadium`}
                        maxLength={40}
                        className={stadiumName.length > 0 && !stadiumValid ? "jm-invalid" : ""}
                        style={{ width: "100%" }}
                      />
                    </span>
                    <div className="jm-hint-row">
                      <span className={`jm-hint ${stadiumName.length > 0 && !stadiumValid ? "bad" : ""}`}>
                        {stadiumName.length > 0 && !stadiumValid ? "Name your home ground" : ""}
                      </span>
                    </div>
                  </div>

                  <div className="jm-field">
                    <label className="jm-label">
                      <Globe2 size={13} /> {strings.saves.country}
                      <FieldHelp text="Choose the nation your club represents. It shapes the names of players and academy recruits you meet." />
                      <span className="jm-req">*</span>
                    </label>
                    <Dropdown
                      value={selectedCountry}
                      options={countryOptions}
                      optionGroupLabel="label"
                      optionGroupChildren="items"
                      onChange={(e) => setSelectedCountry(e.value)}
                      filter
                      filterBy="label"
                      showClear
                      placeholder="Select your football association"
                      style={{ width: "100%" }}
                      aria-label={strings.saves.country}
                      panelClassName="jm-dropdown-panel"
                    />
                    {selectedCountryObj ? (
                      <div className="jm-country-meta">
                        <span className="jm-country-name">{selectedCountryObj.name}</span>
                        <span className={`jm-country-tier s${selectedCountryObj.strength}`}>
                          {selectedCountryObj.featured ? "★ Featured · Larger pool" : "Standard pool"}
                        </span>
                      </div>
                    ) : (
                      <div className="jm-hint">Player names and academy pool</div>
                    )}
                  </div>
                </div>
              )}

              {/* ── Style ── */}
              {activeTab === "style" && (
                <div id="panel-style" role="tabpanel" aria-labelledby="tab-style" className="jm-panel animate-in">
                  <div className="jm-panel-head">
                    <h2>
                      <Palette size={18} /> Club colours
                    </h2>
                    <p>Pick your club's two main colors. Your kits are pre-filled from them.</p>
                  </div>

                  <div className="jm-field">
                    <ColorRow
                      label="Primary color"
                      value={teamPrimary}
                      onChange={(hex) => applyTeamColors(hex, teamSecondary)}
                    />
                    <div style={{ height: 8 }} />
                    <ColorRow
                      label="Secondary color"
                      value={teamSecondary}
                      onChange={(hex) => applyTeamColors(teamPrimary, hex)}
                    />
                  </div>

                  {/* ── Kits (separate section) ── */}
                  <div className="jm-panel-head" style={{ marginTop: 22 }}>
                    <h2>
                      <Shirt size={18} /> Match kits
                    </h2>
                    <p>Home and away are seeded from your club colors (away reversed) — customize every kit independently.</p>
                  </div>
                  <KitDesigner value={kits} onChange={setKits} />
                </div>
              )}

              {/* ── Schedule ── */}
              {activeTab === "schedule" && (
                <div id="panel-schedule" role="tabpanel" aria-labelledby="tab-schedule" className="jm-panel animate-in">
                  <div className="jm-panel-head">
                    <h2>
                      <Clock size={18} /> Matchday schedule
                    </h2>
                    <p>Pick the hours when you can answer the call of matchday.</p>
                  </div>

                  <div className="jm-field">
                    <label className="jm-label">
                      <Globe2 size={13} /> Timezone
                      <FieldHelp text="Choose your local timezone so we can find opponents who play at similar hours." />
                    </label>
                    <span className="p-input-icon-left jm-input-wrap">
                      <Globe2 size={15} />
                      <Dropdown
                        value={timezone}
                        options={TIMEZONES.map((t) => ({ label: t, value: t }))}
                        onChange={(e) => setTimezone(e.value)}
                        style={{ width: "100%" }}
                        aria-label="Timezone"
                      />
                    </span>
                  </div>

                  <div className="jm-field">
                    <label className="jm-label">
                      <Clock size={13} /> Preferred match times
                      <FieldHelp text="Mark at least 8 hours when you can play. We use these windows to place your fixtures at a time you can enjoy them." />
                      <span className="jm-req">*</span>
                    </label>
                    <div className="jm-availability-card">
                      <AvailabilityPicker value={preferredHours} onChange={setPreferredHours} />
                    </div>
                    {preferredHours.length < MIN_SLOTS && (
                      <div className="jm-warn">
                        <AlertTriangle size={13} /> Pick at least {MIN_SLOTS / 2} hours — {preferredHours.length / 2} h selected.
                      </div>
                    )}
                  </div>

                </div>
              )}

              {/* NAV */}
              <div className="jm-nav">
                <button className="btn ghost" onClick={handleBack} disabled={activeTab === "identity"} type="button">
                  <ChevronLeft size={16} /> Back
                </button>
                <div className="jm-nav-hint">
                  {activeTab === "schedule" ? (
                    <span className={scheduleValid ? "good" : "bad"}>{preferredHours.length / 2} h · {scheduleValid ? "ready" : `need ${MIN_SLOTS / 2} h`}</span>
                  ) : (
                    <span>{activeTab === "identity" && !identityValid ? "Finish the Club step" : ""}</span>
                  )}
                </div>
                <button
                  className={`btn gold ${activeTab === "schedule" ? "jm-cta" : ""}`}
                  onClick={handleNext}
                  disabled={joining || (activeTab === "schedule" && !allValid)}
                  type="button"
                >
                  {joining ? (
                    strings.common.loading
                  ) : activeTab === "schedule" ? (
                    <>
                      <Sparkles size={16} /> Create club
                    </>
                  ) : (
                    <>
                      Next <ChevronRight size={16} />
                    </>
                  )}
                </button>
              </div>
              {activeTab === "schedule" && !allValid && (
                <div className="jm-foot-warn">
                  <HelpCircle size={13} />
                  {!identityValid ? "Complete the Club step first." : `Availability needs ${MIN_SLOTS / 2} hours.`}
                </div>
              )}
            </div>

            {/* PREVIEW SIDE — sticky live badge */}
            <div className="jm-preview">
              <div className="jm-preview-sticky">
                <div className="jm-preview-card">
                  <div className="jm-preview-pitch" aria-hidden>
                    <div className="jm-preview-stripes" />
                    <div className="jm-preview-glow" />
                  </div>

                  <div className="jm-preview-badge-wrap">
                    <div className="jm-preview-kit">
                      <FootballKit {...kits.home} number={PREVIEW_NUMBERS.home} size="100%" />
                    </div>
                    <div className="jm-preview-club">
                      <div className="jm-preview-name">{nameTrim || "Your Club"}</div>
                      <div className="jm-preview-sub">
                        {selectedCountryObj ? selectedCountryObj.name : "Pick a nation"}
                        {selectedCountryObj?.featured ? " · ★ Featured" : ""}
                      </div>
                    </div>
                  </div>

                  <div className="jm-preview-divs">
                    <div className="jm-preview-row">
                      <span className="jm-preview-k">Primary</span>
                      <span className="jm-preview-v">
                        <i className="jm-preview-dot" style={{ background: teamPrimary }} /> {teamPrimary}
                      </span>
                    </div>
                    <div className="jm-preview-row">
                      <span className="jm-preview-k">Secondary</span>
                      <span className="jm-preview-v">
                        <i className="jm-preview-dot" style={{ background: teamSecondary }} /> {teamSecondary}
                      </span>
                    </div>
                    <div className="jm-preview-row">
                      <span className="jm-preview-k">Home</span>
                      <span className="jm-preview-v">{stadiumPreviewName}</span>
                    </div>
                    <div className="jm-preview-row">
                      <span className="jm-preview-k">Timezone</span>
                      <span className="jm-preview-v" style={{ fontSize: "0.82rem" }}>{timezone}</span>
                    </div>
                  </div>

                  <div className="jm-preview-stadium">
                    <div className="jm-preview-stadium-illustration" aria-hidden>
                      <div className="jm-stadium-stand" />
                      <div className="jm-stadium-pitch">
                        <div className="jm-stadium-line" />
                        <div className="jm-stadium-circle" />
                      </div>
                    </div>
                    <div>
                      <div className="jm-preview-stadium-name">{stadiumPreviewName}</div>
                      <div className="jm-preview-stadium-hint">Home ground</div>
                    </div>
                  </div>
                </div>

              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
