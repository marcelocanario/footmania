import { useEffect, useMemo, useState, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
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
  UserRound,
} from "lucide-react";
import { api, type CountryOption, type MpStatus } from "../api/client";
import { AvailabilityPicker, PRESET_EVENINGS, MIN_SLOTS } from "../components/AvailabilityPicker";
import { ClubBadge } from "../components/ClubBadge";
import { FootballKit } from "../components/kit/FootballKit";
import { ColorRow, KitDesigner } from "../components/kit/KitDesigner";
import { applyTeamColorPreset, deriveKitDefaults } from "../components/kit/defaults";
import { PREVIEW_NUMBERS, type ClubKits } from "../components/kit/types";
import { useGame } from "../store/game";
import { PageLoading } from "../components/PageLoading";
import { localSlotsToUtc } from "../utils/time";

/** Default club identity colors (Classic Red over White). */
const DEFAULT_PRIMARY = "#d40000";
const DEFAULT_SECONDARY = "#ffffff";

type TabId = "identity" | "style" | "schedule";

const TABS: { id: TabId; label: string; icon: React.ReactNode }[] = [
  { id: "identity", label: "join.tabClub", icon: <Shield size={16} /> },
  { id: "style", label: "join.tabKit", icon: <Shirt size={16} /> },
  { id: "schedule", label: "join.tabSchedule", icon: <CalendarClock size={16} /> },
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
  const { t } = useTranslation();
  const { loadStatus, loadClub, setLiveMatch } = useGame();
  const user = useGame((s) => s.user);
  const navigate = useNavigate();
  const toast = useRef<Toast>(null);
  const [status, setStatus] = useState<MpStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [clubName, setClubName] = useState("");
  const [selectedCountry, setSelectedCountry] = useState<string | null>(null);
  const [teamPrimary, setTeamPrimary] = useState(DEFAULT_PRIMARY);
  const [teamSecondary, setTeamSecondary] = useState(DEFAULT_SECONDARY);
  const [kits, setKits] = useState<ClubKits>(() =>
    applyTeamColorPreset(deriveKitDefaults(DEFAULT_PRIMARY, DEFAULT_SECONDARY), DEFAULT_PRIMARY, DEFAULT_SECONDARY),
  );
  const [stadiumName, setStadiumName] = useState("");
  // The manager's name is the Google display name by default (editable).
  const [coachName, setCoachName] = useState(() => user?.name ?? "");
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
  const coachNameTrim = coachName.trim();
  const coachNameValid = coachNameTrim.length >= 2 && coachNameTrim.length <= 40;
  const stadiumPreviewName = stadiumName.trim() || t("join.nameStadium");

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
      toast.current?.show({ severity: "error", summary: t("join.errorTitle"), detail: (e as Error).message });
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
        if (withAI) setEntryDiv(t("competitions.divisionOption", { tier: withAI.name }));
        else setEntryDiv(t("competitions.divisionOption", { tier: lowest.tier }));
      })
      .catch(() => undefined);
  }, []);

  // A preserved identity (world reset with identity preservation) is restored
  // by the server on join regardless of the wizard payload, so prefill the
  // fields it covers for an accurate preview. This hook must stay above the
  // conditional returns below — React forbids conditional hook order.
  const preserved = status?.preservedIdentity ?? null;
  useEffect(() => {
    if (!preserved) return;
    if (!clubName.trim()) setClubName(preserved.name);
    setTeamPrimary(preserved.primaryColor);
    setTeamSecondary(preserved.secondaryColor);
    // Restore the FULL archived kit set (home/away/GK) so the preview shows
    // the manager's real jerseys — a customized away kit must not be replaced
    // by a color-derived default.
    if (preserved.kits) setKits(preserved.kits);
    else setKits((current) => applyTeamColorPreset(current, preserved.primaryColor, preserved.secondaryColor));
    if (!stadiumName.trim()) setStadiumName(preserved.stadiumName);
    if (!coachName.trim()) setCoachName(preserved.coachName);
    // The country list arrives async; only set the selection once the
    // preserved country is present in the options (the server restores the
    // archived country on join regardless, this is purely for the preview).
    if (!selectedCountry && preserved.country && countries.some((c) => c.code === preserved.country)) {
      setSelectedCountry(preserved.country);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preserved, countries, selectedCountry]);

  const countryOptions = useMemo(
    () =>
      [
        { label: t("join.featured"), items: featured.map((c) => ({ label: c.name, value: c.code })) },
        { label: t("join.allNations"), items: countries.map((c) => ({ label: c.name, value: c.code })) },
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
      toast.current?.show({ severity: "error", summary: t("join.errorTitle"), detail: (e as Error).message });
      setReturning(false);
    }
  };

  const playPractice = async () => {
    try {
      const res = await api.practice();
      setPractice({ homeGoals: res.homeGoals, awayGoals: res.awayGoals, opponentName: res.opponentName });
    } catch (e) {
      toast.current?.show({ severity: "error", summary: t("join.errorTitle"), detail: (e as Error).message });
    }
  };

  const join = async () => {
    if (!selectedCountry || !nameValid || !stadiumValid || !coachNameValid) {
      toast.current?.show({
        severity: "warn",
        summary: t("join.completeYourClub"),
        detail: !selectedCountry ? t("join.chooseCountry") : !nameValid ? t("join.nameTooShort") : !stadiumValid ? t("join.nameStadium") : t("join.nameCoach"),
      });
      setActiveTab("identity");
      return;
    }
    if (preferredHours.length < MIN_SLOTS) {
      toast.current?.show({ severity: "warn", summary: t("join.availability"), detail: t("join.pickHours", { count: MIN_SLOTS / 2 }) });
      setActiveTab("schedule");
      return;
    }
    setJoining(true);
    try {
      await api.join({
        clubName: clubName.trim(),
        country: selectedCountry,
        primaryColor: teamPrimary,
        secondaryColor: teamSecondary,
        kits,
        stadiumName: stadiumName.trim(),
        coachName: coachNameTrim,
        // The server grid is UTC; the picker works in the browser's timezone.
        preferredHours: localSlotsToUtc(preferredHours),
      });
      setLiveMatch(null);
      await loadStatus();
      await loadClub();
      navigate("/dashboard");
    } catch (e) {
      toast.current?.show({ severity: "error", summary: t("join.errorTitle"), detail: (e as Error).message });
      setJoining(false);
    }
  };

  if (loading) {
    return <PageLoading message={t("join.loadingCreation")} />;
  }

  if (hasClub) {
    return (
      <div className="join-wrap">
        <Toast ref={toast} position="bottom-right" />
        <div className="page-head">
          <div>
            <div className="kicker">{t("join.startNew")}</div>
            <h1>{t("join.title")}</h1>
          </div>
        </div>

        <div className="join-hasclub">
          <div className="join-hasclub-hero">
            <div className="join-hasclub-badge">
              <ClubBadge name={status?.club?.name ?? "?"} size={64} />
            </div>
            <div>
              <div className="join-hasclub-kicker">
                <BadgeCheck size={14} /> {t("join.activeCareer")}
              </div>
              <h2 style={{ margin: "6px 0 4px" }}>{t("join.youManage", { name: status?.club?.name ?? "" })}</h2>
              <div style={{ color: "var(--text-3)", fontSize: "0.9rem" }}>
                {t("join.clubMeta", { division: status?.club?.highestDivision ?? "", state: clubState ?? "" })}
              </div>
            </div>
          </div>

          <div className="card" style={{ padding: 0, overflow: "hidden" }}>
            <div className="join-hasclub-body">
              {isDormant ? (
                <div className="join-callout warn">
                  <AlertTriangle size={18} />
                  <div>
                    <b>{t("join.dormantClub")}</b>
                    <p>{t("join.dormantClubText")}</p>
                  </div>
                </div>
              ) : isProvisional ? (
                <div className="join-callout gold">
                  <Clock size={18} />
                  <div>
                    <b>{t("join.provisionalEntry")}</b>
                    <p>{t("join.provisionalText")}</p>
                  </div>
                </div>
              ) : (
                <div className="join-callout good">
                  <Sparkles size={18} />
                  <div>
                    <b>{t("join.readyMatchday")}</b>
                    <p>{t("join.readyMatchdayText")}</p>
                  </div>
                </div>
              )}

              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 16 }}>
                {isDormant ? (
                  <button className="btn gold" style={{ fontSize: "1rem" }} onClick={() => void returnToPyramid()} disabled={returning}>
                    <Play size={16} /> {returning ? t("join.returningDots") : t("join.returnToPyramid")}
                  </button>
                ) : (
                  <button className="btn gold" style={{ fontSize: "1rem" }} onClick={() => navigate("/dashboard")}>
                    <Play size={16} /> {t("dashboard.continue")}
                  </button>
                )}
                {isProvisional ? (
                  <button className="btn" onClick={() => void playPractice()}>
                    <Shield size={16} /> {t("join.practiceMatch")}
                  </button>
                ) : (
                  <button className="btn ghost" onClick={() => navigate("/squad")}>
                    <Users size={16} /> {t("squad.title")} <ArrowRight size={14} />
                  </button>
                )}
                <button className="btn ghost" onClick={() => navigate("/my-club")} title={t("join.editTeamTitle")}>
                  <Shirt size={16} /> {t("join.editTeam")}
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
                  <div className="jm-practice-hint">{t("join.practiceNoImpact")}</div>
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
  const identityValid = !!selectedCountry && nameValid && stadiumValid && coachNameValid;
  const scheduleValid = preferredHours.length >= MIN_SLOTS;
  const allValid = identityValid && scheduleValid;

  const tabIdx = TABS.findIndex((t) => t.id === activeTab);

  const handleNext = () => {
if (activeTab === "identity") {
          if (!identityValid) {
            toast.current?.show({
              severity: "warn",
              summary: t("join.completeYourClub"),
              detail: !selectedCountry ? t("join.chooseCountry") : !nameValid ? t("join.nameTooShort") : !stadiumValid ? t("join.nameStadium") : t("join.nameCoach"),
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
      <Toast ref={toast} position="bottom-right" />

      {/* HERO — floodlit pitch */}
      <div className="jm-hero">
        <div className="jm-hero-glow" aria-hidden />
        <div className="jm-hero-stripes" aria-hidden />
        <div className="jm-hero-inner">
          <div>
            <div className="kicker" style={{ color: "var(--gold-2)" }}>
               <Sparkles size={13} /> {t("join.startNew")}
            </div>
            <h1 className="jm-title">
              {t("join.createYourTeam")}
            </h1>
          </div>
          <div className="jm-hero-badge">
            <div className="jm-hero-crest">
              <Trophy size={22} />
            </div>
            <div className="jm-hero-meta">
              <div className="jm-hero-season">{entryDiv ?? t("join.entryDiv")}</div>
              <div className="jm-hero-round">{season ? (joinOpen ? t("join.openToJoin") : t("join.lockedThisSeason")) : t("join.loadingDots")}</div>
            </div>
          </div>
        </div>
      </div>

      {/* Season status */}
      {preserved && (
        <div className="jm-season-banner open">
          <BadgeCheck size={17} className="jm-season-icon" />
          <div className="jm-season-copy">
            <b>{t("join.welcomeBack")}</b>
            <span>
              {t("join.identityPreserved", { name: preserved.name })}
            </span>
          </div>
          <span className="jm-season-pill open">{t("join.restored")}</span>
        </div>
      )}

      {season && (
        <div className={`jm-season-banner ${joinOpen ? "open" : "locked"}`}>
          <Info size={17} className="jm-season-icon" />
          <div className="jm-season-copy">
            <b>{joinOpen ? t("join.timeForSeason", { season: season.seasonNumber }) : t("join.nextCampaign")}</b>
            <span>
              {joinOpen
                ? t("join.joinBeforeRound", { round: season.joinLockRound })
                : t("join.seasonLocked", { season: season.seasonNumber })}
            </span>
          </div>
          <span className={`jm-season-pill ${joinOpen ? "open" : "locked"}`}>
            {joinOpen ? t("join.open") : t("join.locked")}
          </span>
        </div>
      )}

      {/* TABS */}
      <div className="jm-shell">
        <div className="jm-tabs" role="tablist" aria-label={t("join.createTeamSteps")}>
          {TABS.map((t, idx) => {
            const valid = t.id === "identity" ? identityValid : t.id === "schedule" ? scheduleValid : true;
            const active = t.id === activeTab;
            const done = valid && idx < tabIdx;
            const locked = idx > tabIdx;
            return (
              <button
                key={t.id}
                role="tab"
                aria-selected={active}
                aria-controls={`panel-${t.id}`}
                id={`tab-${t.id}`}
                className={`jm-tab ${active ? "active" : ""} ${done ? "done" : ""} ${locked ? "locked" : ""}`}
                onClick={() => {
                  if (!locked) setActiveTab(t.id);
                }}
                disabled={locked}
              >
                <span className="jm-tab-icon">{done ? <Check size={14} /> : t.icon}</span>
                <span className="jm-tab-text"><b>{(t as unknown as (k: string) => string)(t.label)}</b></span>
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
                      <Shield size={18} /> {t("join.clubAndNation")}
                    </h2>
                    <p>{t("join.identityIntro")}</p>
                  </div>

                  <div className="jm-field">
                    <label className="jm-label">
                       <Flag size={13} /> {t("join.teamName")}
                      <FieldHelp text={t("join.teamNameHelp")} />
                      <span className="jm-req">*</span>
                    </label>
                    <span className="p-input-icon-left jm-input-wrap">
                      <BadgeCheck size={15} />
                      <InputText
                        value={clubName}
                        onChange={(e) => setClubName(e.target.value)}
                        placeholder={t("join.namePlaceholder")}
                        maxLength={30}
                        className={clubName.length > 0 && !nameValid ? "jm-invalid" : ""}
                        style={{ width: "100%" }}
                      />
                    </span>
                    <div className="jm-hint-row">
                      <span className={`jm-hint ${nameLen > 0 && !nameValid ? "bad" : ""}`}>
                        {nameLen > 0 && !nameValid ? (nameLen < 3 ? t("join.min3") : t("join.max30")) : ""}
                      </span>
                      <span className="jm-count">{nameLen}/30</span>
                    </div>
                  </div>

                  <div className="jm-field">
                    <label className="jm-label">
                       <Home size={13} /> {t("join.stadium")}
                      <FieldHelp text={t("join.stadiumHelp")} />
                      <span className="jm-req">*</span>
                    </label>
                    <span className="p-input-icon-left jm-input-wrap">
                      <Building2 size={15} />
                      <InputText
                        value={stadiumName}
                        onChange={(e) => setStadiumName(e.target.value)}
                        placeholder={t("join.stadiumPlaceholder", { name: nameTrim || t("join.yourClub") })}
                        maxLength={40}
                        className={stadiumName.length > 0 && !stadiumValid ? "jm-invalid" : ""}
                        style={{ width: "100%" }}
                      />
                    </span>
                    <div className="jm-hint-row">
                      <span className={`jm-hint ${stadiumName.length > 0 && !stadiumValid ? "bad" : ""}`}>
                        {stadiumName.length > 0 && !stadiumValid ? t("join.nameStadium") : ""}
                      </span>
                    </div>
                  </div>

                  <div className="jm-field">
                    <label className="jm-label" htmlFor="join-coach">
                      <UserRound size={13} /> {t("join.manager")}
                      <FieldHelp text={t("join.managerHelp")} />
                      <span className="jm-req">*</span>
                    </label>
                    <span className="p-input-icon-left jm-input-wrap">
                      <UserRound size={15} />
                      <InputText
                        id="join-coach"
                        value={coachName}
                        onChange={(e) => setCoachName(e.target.value)}
                        placeholder={t("join.managerPlaceholder")}
                        maxLength={40}
                        className={coachName.length > 0 && !coachNameValid ? "jm-invalid" : ""}
                        style={{ width: "100%" }}
                      />
                    </span>
                    <div className="jm-hint-row">
                      <span className={`jm-hint ${coachName.length > 0 && !coachNameValid ? "bad" : ""}`}>
                        {coachName.length > 0 && !coachNameValid ? (coachNameTrim.length < 2 ? t("join.min2") : t("join.max40")) : ""}
                      </span>
                      <span className="jm-count">{coachNameTrim.length}/40</span>
                    </div>
                  </div>

                  <div className="jm-field">
                    <label className="jm-label">
                       <Globe2 size={13} /> {t("join.country")}
                      <FieldHelp text={t("join.countryHelp")} />
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
                      placeholder={t("join.selectAssociation")}
                      style={{ width: "100%" }}
                       aria-label={t("join.country")}
                      panelClassName="jm-dropdown-panel"
                    />
                    {selectedCountryObj ? (
                      <div className="jm-country-meta">
                        <span className="jm-country-name">{selectedCountryObj.name}</span>
                        <span className={`jm-country-tier s${selectedCountryObj.strength}`}>
                          {selectedCountryObj.featured ? t("join.featuredPool") : t("join.standardPool")}
                        </span>
                      </div>
                    ) : (
                      <div className="jm-hint">{t("join.poolHint")}</div>
                    )}
                  </div>
                </div>
              )}

              {/* ── Style ── */}
              {activeTab === "style" && (
                <div id="panel-style" role="tabpanel" aria-labelledby="tab-style" className="jm-panel animate-in">
                  <div className="jm-panel-head">
                    <h2>
                      <Palette size={18} /> {t("join.clubColours")}
                    </h2>
                    <p>{t("join.coloursIntro")}</p>
                  </div>

                  <div className="jm-field">
                    <ColorRow
                      label={t("join.primaryColor")}
                      value={teamPrimary}
                      onChange={(hex) => applyTeamColors(hex, teamSecondary)}
                    />
                    <div style={{ height: 8 }} />
                    <ColorRow
                      label={t("join.secondaryColor")}
                      value={teamSecondary}
                      onChange={(hex) => applyTeamColors(teamPrimary, hex)}
                    />
                  </div>

                  {/* ── Kits (separate section) ── */}
                  <div className="jm-panel-head" style={{ marginTop: 22 }}>
                    <h2>
                      <Shirt size={18} /> {t("join.matchKits")}
                    </h2>
                    <p>{t("join.kitsIntro")}</p>
                  </div>
                  <KitDesigner value={kits} onChange={setKits} />
                </div>
              )}

              {/* ── Schedule ── */}
              {activeTab === "schedule" && (
                <div id="panel-schedule" role="tabpanel" aria-labelledby="tab-schedule" className="jm-panel animate-in">
                  <div className="jm-panel-head">
                    <h2>
                      <Clock size={18} /> {t("join.matchdaySchedule")}
                    </h2>
                    <p>{t("join.scheduleIntro")}</p>
                  </div>

                  <div className="jm-field">
                    <label className="jm-label">
                      <Clock size={13} /> {t("join.preferredTimes")}
                      <FieldHelp text={t("join.preferredTimesHelp")} />
                      <span className="jm-req">*</span>
                    </label>
                    <div className="jm-availability-card">
                      <AvailabilityPicker value={preferredHours} onChange={setPreferredHours} />
                    </div>
                    {preferredHours.length < MIN_SLOTS && (
                      <div className="jm-warn">
                        <AlertTriangle size={13} /> {t("join.pickAtLeast", { count: MIN_SLOTS / 2, hours: preferredHours.length / 2 })}
                      </div>
                    )}
                  </div>

                </div>
              )}

              {/* NAV */}
              <div className="jm-nav">
                <button className="btn ghost" onClick={handleBack} disabled={activeTab === "identity"} type="button">
                  <ChevronLeft size={16} /> {t("join.back")}
                </button>
                <div className="jm-nav-hint">
                  {activeTab === "schedule" ? (
                    <span className={scheduleValid ? "good" : "bad"}>{preferredHours.length / 2} h · {scheduleValid ? t("join.ready") : t("join.needHours", { count: MIN_SLOTS / 2 })}</span>
                  ) : (
                    <span>{activeTab === "identity" && !identityValid ? t("join.finishClubStep") : ""}</span>
                  )}
                </div>
                <button
                  className={`btn gold ${activeTab === "schedule" ? "jm-cta" : ""}`}
                  onClick={handleNext}
                  disabled={joining || (activeTab === "schedule" && !allValid)}
                  type="button"
                >
                  {joining ? (
                    t("common.loading")
                  ) : activeTab === "schedule" ? (
                    <>
                      <Sparkles size={16} /> {t("join.createClub")}
                    </>
                  ) : (
                    <>
                      {t("join.next")} <ChevronRight size={16} />
                    </>
                  )}
                </button>
              </div>
              {activeTab === "schedule" && !allValid && (
                <div className="jm-foot-warn">
                  <HelpCircle size={13} />
                  {!identityValid ? t("join.completeClubFirst") : t("join.availabilityNeeds", { count: MIN_SLOTS / 2 })}
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
                      <div className="jm-preview-name">{nameTrim || t("join.yourClub")}</div>
                      <div className="jm-preview-sub">
                        {selectedCountryObj ? selectedCountryObj.name : t("join.pickNation")}
                        {selectedCountryObj?.featured ? t("join.featuredSuffix") : ""}
                      </div>
                    </div>
                  </div>

                  <div className="jm-preview-divs">
                    <div className="jm-preview-row">
                      <span className="jm-preview-k">{t("join.primary")}</span>
                      <span className="jm-preview-v">
                        <i className="jm-preview-dot" style={{ background: teamPrimary }} /> {teamPrimary}
                      </span>
                    </div>
                    <div className="jm-preview-row">
                      <span className="jm-preview-k">{t("join.secondary")}</span>
                      <span className="jm-preview-v">
                        <i className="jm-preview-dot" style={{ background: teamSecondary }} /> {teamSecondary}
                      </span>
                    </div>
                    <div className="jm-preview-row">
                      <span className="jm-preview-k">{t("join.home")}</span>
                      <span className="jm-preview-v">{stadiumPreviewName}</span>
                    </div>
                    <div className="jm-preview-row">
                      <span className="jm-preview-k">{t("join.previewManager")}</span>
                      <span className="jm-preview-v">{coachNameTrim || t("join.nameYourManager")}</span>
                    </div>
                    <div className="jm-preview-row">
                      <span className="jm-preview-k">{t("join.previewAvailability")}</span>
                      <span className="jm-preview-v" style={{ fontSize: "0.82rem" }}>{t("join.hoursPerWeek", { count: preferredHours.length / 2 })}</span>
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
                      <div className="jm-preview-stadium-hint">{t("join.homeGround")}</div>
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
