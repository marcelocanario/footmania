import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { InputText } from "primereact/inputtext";
import { Toast } from "primereact/toast";
import { BadgeCheck, Flag, Globe2, Home, Save as SaveIcon, Shirt, Image as ImageIcon, Upload, UserRound } from "lucide-react";
import { api } from "../api/client";
import { KitDesigner } from "../components/kit/KitDesigner";
import { deriveKitDefaults } from "../components/kit/defaults";
import { ClubCrest } from "../components/ClubCrest";
import type { ClubKits } from "../components/kit/types";
import { useGame } from "../store/game";
import { useIsMobile } from "../hooks/useIsMobile";

/**
 * Post-creation club editing (Kit Lab companion): rename the club and its
 * stadium, and redesign all three kits. Country is intentionally locked — it
 * drives player-name pools and next-season division clustering.
 */
export function MyClub() {
  const { t } = useTranslation();
  const { snapshot, loadClub, loadStatus } = useGame();
  const isMobile = useIsMobile();
  const toast = useRef<Toast>(null);
  const club = snapshot?.club;

  const [loadedId, setLoadedId] = useState<number | null>(null);
  const [clubName, setClubName] = useState("");
  const [stadiumName, setStadiumName] = useState("");
  const [coachName, setCoachName] = useState("");
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileDirty, setProfileDirty] = useState(false);
  const [kits, setKits] = useState<ClubKits>(() => deriveKitDefaults("#d40000", "#ffffff"));
  const [kitsDirty, setKitsDirty] = useState(false);
  const [savingKits, setSavingKits] = useState(false);
  const [logoVariant, setLogoVariant] = useState(0);
  const [customLogoPreview, setCustomLogoPreview] = useState<string | null>(null);
  const [uploadingLogo, setUploadingLogo] = useState(false);

  // Adopt server state once per loaded club (initial load and after save+refresh).
  useEffect(() => {
    if (!club || club.id === loadedId) return;
    setLoadedId(club.id);
    setClubName(club.name);
    setStadiumName(club.stadiumName);
    setCoachName(club.coachName);
    setKits(club.kits ?? deriveKitDefaults(club.primaryColor, club.secondaryColor));
    setLogoVariant((club as unknown as { logoVariant?: number }).logoVariant ?? 0);
    setKitsDirty(false);
    setProfileDirty(false);
  }, [club, loadedId]);

  // Load custom logo preview if present (browser cache: use server image)
  useEffect(() => {
    if (!club) return;
    const has = (club as unknown as { hasCustomLogo?: boolean }).hasCustomLogo;
    if (has) setCustomLogoPreview(`/api/clubs/${club.id}/logo?ts=${Date.now()}`);
    else setCustomLogoPreview(null);
  }, [club?.id, (club as unknown as { hasCustomLogo?: boolean })?.hasCustomLogo]);

  const nameValid = clubName.trim().length >= 3 && clubName.trim().length <= 30;
  const stadiumValid = stadiumName.trim().length > 0;
  const coachNameValid = coachName.trim().length >= 2 && coachName.trim().length <= 40;

  const saveProfile = async () => {
    if (!club) return;
    if (!nameValid || !stadiumValid || !coachNameValid) {
      toast.current?.show({ severity: "warn", summary: t("myclub.checkYourClub"), detail: !nameValid ? t("myclub.nameTooShort") : !stadiumValid ? t("myclub.nameStadium") : t("myclub.nameCoach") });
      return;
    }
    setSavingProfile(true);
    try {
      const coachChanged = coachName.trim() !== club.coachName;
      await api.updateClubProfile({ clubName: clubName.trim(), stadiumName: stadiumName.trim(), ...(coachChanged ? { coachName: coachName.trim() } : {}) });
      await Promise.all([loadStatus(), loadClub()]);
      setProfileDirty(false);
      toast.current?.show({ severity: "success", summary: t("myclub.saved"), detail: t("myclub.identityUpdated"), life: 2000 });
    } catch (e) {
      toast.current?.show({ severity: "error", summary: t("myclub.errorTitle"), detail: (e as Error).message });
    } finally {
      setSavingProfile(false);
    }
  };

  const saveKits = async () => {
    setSavingKits(true);
    try {
      await api.updateClubKit(kits);
      await Promise.all([loadStatus(), loadClub()]);
      setKitsDirty(false);
      toast.current?.show({ severity: "success", summary: t("myclub.saved"), detail: t("myclub.kitsLive"), life: 2000 });
    } catch (e) {
      toast.current?.show({ severity: "error", summary: t("myclub.errorTitle"), detail: (e as Error).message });
    } finally {
      setSavingKits(false);
    }
  };

  const saveLogoVariant = async (v: number) => {
    setLogoVariant(v);
    try {
      await api.updateLogoVariant(v);
      await loadClub();
      toast.current?.show({ severity: "success", summary: t("myclub.crestUpdated"), life: 2000 });
    } catch (e) {
      toast.current?.show({ severity: "error", summary: t("myclub.errorTitle"), detail: (e as Error).message });
    }
  };

  const onLogoFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      toast.current?.show({ severity: "warn", summary: t("myclub.unsupportedFile"), detail: t("myclub.usePngJpegWebp") });
      return;
    }
    if (file.size > 262144) {
      toast.current?.show({ severity: "warn", summary: t("myclub.tooLarge"), detail: t("myclub.max256kb") });
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      const base64 = (reader.result as string).split(",")[1] ?? "";
      setUploadingLogo(true);
      try {
        await api.uploadCustomLogo(file.type, base64);
        await loadClub();
        toast.current?.show({ severity: "success", summary: t("myclub.logoUploaded"), detail: t("myclub.crestLive"), life: 2000 });
      } catch (err) {
        toast.current?.show({ severity: "error", summary: t("myclub.errorTitle"), detail: (err as Error).message });
      } finally {
        setUploadingLogo(false);
      }
    };
    reader.readAsDataURL(file);
  };

  const removeLogo = async () => {
    try {
      await api.deleteCustomLogo();
      await loadClub();
      toast.current?.show({ severity: "success", summary: t("myclub.logoRemoved"), life: 2000 });
    } catch (e) {
      toast.current?.show({ severity: "error", summary: t("myclub.errorTitle"), detail: (e as Error).message });
    }
  };

  if (!club) {
    return <div className="empty-state" style={{ paddingTop: 80 }}>{t("myclub.loadingClub")}</div>;
  }

  return (
    <div>
      <Toast ref={toast} position="bottom-right" />
      <div className="page-head">
        <div>
          <div className="kicker">{t("myclub.clubOffice")}</div>
          <h1>{t("myclub.title")}</h1>
        </div>
      </div>

      {/* Identity hero: shared ClubCrest (custom logo aware) + key facts. */}
      <div className="myclub-hero" style={{ ["--hero-a" as string]: club.primaryColor, ["--hero-b" as string]: club.secondaryColor }}>
        <ClubCrest
          name={club.name}
          primary={club.primaryColor}
          secondary={club.secondaryColor}
          kit={club.kits?.home ?? null}
          size={72}
          clubId={club.id}
          hasCustomLogo={(club as unknown as { hasCustomLogo?: boolean }).hasCustomLogo}
        />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 800, fontSize: "1.3rem" }}>{club.name}</div>
          <div style={{ color: "var(--text-2)", fontSize: "0.88rem", marginTop: 2 }}>
            <Globe2 size={12} /> {club.country} · <Home size={12} /> {club.stadiumName} · <UserRound size={12} /> {club.coachName}
          </div>
        </div>
      </div>

      <div className="myclub-grid" style={{ gridTemplateColumns: isMobile ? "1fr" : "minmax(0, 1fr) minmax(0, 1fr)", alignItems: "start" }}>
        <div className="card">
          <h2 className="card-title">
            <Flag size={17} /> {t("myclub.clubIdentity")}
          </h2>
          <div className="form-group" style={{ marginTop: 12 }}>
            <label className="jm-label" htmlFor="myclub-name">
              <Flag size={13} /> {t("myclub.clubName")}
            </label>
            <InputText
              id="myclub-name"
              value={clubName}
              onChange={(e) => {
                setClubName(e.target.value);
                setProfileDirty(true);
              }}
              maxLength={30}
              style={{ width: "100%" }}
            />
          </div>
          <div className="form-group">
            <label className="jm-label" htmlFor="myclub-stadium">
              <Home size={13} /> {t("myclub.stadium")}
            </label>
            <InputText
              id="myclub-stadium"
              value={stadiumName}
              onChange={(e) => {
                setStadiumName(e.target.value);
                setProfileDirty(true);
              }}
              maxLength={40}
              style={{ width: "100%" }}
            />
          </div>
          <div className="form-group">
            <label className="jm-label" htmlFor="myclub-coach">
              <UserRound size={13} /> {t("myclub.manager")}
            </label>
            <InputText
              id="myclub-coach"
              value={coachName}
              onChange={(e) => {
                setCoachName(e.target.value);
                setProfileDirty(true);
              }}
              maxLength={40}
              disabled={!club.coachEditAllowed}
              style={{ width: "100%" }}
            />
            <div className="jm-hint">
              {!club.coachEditAllowed ? t("myclub.coachHintPro") : t("myclub.coachHint")}
            </div>
          </div>
          <div className="form-group">
            <label className="jm-label">
              <Globe2 size={13} /> {t("myclub.nation")}
            </label>
            <input className="select" value={club.country} disabled style={{ width: "100%" }} />
            <div className="jm-hint">{t("myclub.nationHint")}</div>
          </div>
          <button
            className="btn gold"
            style={{ marginTop: 8 }}
            onClick={() => void saveProfile()}
            disabled={savingProfile || !profileDirty || !nameValid || !stadiumValid || !coachNameValid}
          >
            <SaveIcon size={15} /> {savingProfile ? t("myclub.savingDots") : t("myclub.saveIdentity")}
          </button>
        </div>

        <div className="card">
          <h2 className="card-title">
            <ImageIcon size={17} /> {t("myclub.crest")}
          </h2>
          <div style={{ color: "var(--text-3)", fontSize: "0.9rem", marginBottom: 12 }}>
            {t("myclub.crestDescription")}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 12 }}>
            <div style={{ width: 72, height: 72, borderRadius: 12, border: "1px solid var(--line)", display: "grid", placeItems: "center", overflow: "hidden", background: "#0f2a43" }}>
              {customLogoPreview ? <img src={customLogoPreview} alt="crest" style={{ width: "100%", height: "100%", objectFit: "contain" }} /> : <span style={{ fontWeight: 800, color: "white" }}>{club.name.slice(0, 2).toUpperCase()}</span>}
            </div>
            <div>
              <div style={{ fontWeight: 700 }}>{club.name}</div>
              <div style={{ color: "var(--text-3)", fontSize: "0.85rem" }}>{customLogoPreview ? t("myclub.customCrest") : t("myclub.defaultCrest")}</div>
            </div>
          </div>
          <div className="form-group">
            <label className="jm-label">{t("myclub.variant")}</label>
            <select className="select" value={logoVariant} onChange={(e) => void saveLogoVariant(Number(e.target.value))} style={{ width: "100%" }}>
              <option value={0}>{t("myclub.classicShield")}</option>
            </select>
            <div className="jm-hint">{t("myclub.variantsHint")}</div>
          </div>
          <div className="form-group">
            <label className="jm-label"><BadgeCheck size={13} /> {t("myclub.customCrest")} {useGame.getState().user?.isPro ? t("myclub.pro") : t("myclub.proOnly")}</label>
            {useGame.getState().user?.isPro ? (
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <label className="btn" style={{ cursor: "pointer" }}>
                  <Upload size={14} /> {uploadingLogo ? t("myclub.uploadingDots") : t("myclub.uploadCrest")}
                  <input type="file" accept="image/png,image/jpeg,image/webp" onChange={onLogoFile} style={{ display: "none" }} disabled={uploadingLogo} />
                </label>
                {customLogoPreview && <button className="btn ghost danger" onClick={() => void removeLogo()}>{t("myclub.removeCustom")}</button>}
              </div>
            ) : (
              <div style={{ color: "var(--text-3)", fontSize: "0.88rem" }}>{t("myclub.upgradeToPro")}</div>
            )}
          </div>
        </div>

        <div className="card kd-card myclub-kits-card">
          <h2 className="card-title">
            <Shirt size={17} /> {t("myclub.kits")}
          </h2>
          <div style={{ color: "var(--text-3)", fontSize: "0.9rem", marginBottom: 14 }}>
            {t("myclub.kitsDescription")}
          </div>
          <KitDesigner
            value={kits}
            onChange={(next) => {
              setKits(next);
              setKitsDirty(true);
            }}
          />
          <button
            className="btn gold"
            style={{ marginTop: 14 }}
            onClick={() => void saveKits()}
            disabled={savingKits || !kitsDirty}
          >
            <SaveIcon size={15} /> {savingKits ? t("myclub.savingDots") : t("myclub.saveKits")}
          </button>
        </div>
      </div>
    </div>
  );
}
