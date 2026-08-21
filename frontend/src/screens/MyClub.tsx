import { useEffect, useRef, useState } from "react";
import { InputText } from "primereact/inputtext";
import { Toast } from "primereact/toast";
import { Flag, Globe2, Home, Save as SaveIcon, Shirt } from "lucide-react";
import { api } from "../api/client";
import { KitDesigner } from "../components/kit/KitDesigner";
import { deriveKitDefaults } from "../components/kit/defaults";
import type { ClubKits } from "../components/kit/types";
import { useGame } from "../store/game";

/**
 * Post-creation club editing (Kit Lab companion): rename the club and its
 * stadium, and redesign all three kits. Country is intentionally locked — it
 * drives player-name pools and next-season division clustering.
 */
export function MyClub() {
  const { snapshot, loadClub, loadStatus } = useGame();
  const toast = useRef<Toast>(null);
  const club = snapshot?.club;

  const [loadedId, setLoadedId] = useState<number | null>(null);
  const [clubName, setClubName] = useState("");
  const [stadiumName, setStadiumName] = useState("");
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileDirty, setProfileDirty] = useState(false);
  const [kits, setKits] = useState<ClubKits>(() => deriveKitDefaults("#d40000", "#ffffff"));
  const [kitsDirty, setKitsDirty] = useState(false);
  const [savingKits, setSavingKits] = useState(false);

  // Adopt server state once per loaded club (initial load and after save+refresh).
  useEffect(() => {
    if (!club || club.id === loadedId) return;
    setLoadedId(club.id);
    setClubName(club.name);
    setStadiumName(club.stadiumName);
    setKits(club.kits ?? deriveKitDefaults(club.primaryColor, club.secondaryColor));
    setKitsDirty(false);
    setProfileDirty(false);
  }, [club, loadedId]);

  const nameValid = clubName.trim().length >= 3 && clubName.trim().length <= 30;
  const stadiumValid = stadiumName.trim().length > 0;

  const saveProfile = async () => {
    if (!nameValid || !stadiumValid) {
      toast.current?.show({ severity: "warn", summary: "Check your club", detail: !nameValid ? "Club name must be 3–30 characters." : "Name your home ground." });
      return;
    }
    setSavingProfile(true);
    try {
      await api.updateClubProfile({ clubName: clubName.trim(), stadiumName: stadiumName.trim() });
      await Promise.all([loadStatus(), loadClub()]);
      setProfileDirty(false);
      toast.current?.show({ severity: "success", summary: "Saved", detail: "Club identity updated.", life: 2000 });
    } catch (e) {
      toast.current?.show({ severity: "error", summary: "Error", detail: (e as Error).message });
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
      toast.current?.show({ severity: "success", summary: "Saved", detail: "Your new kits are live.", life: 2000 });
    } catch (e) {
      toast.current?.show({ severity: "error", summary: "Error", detail: (e as Error).message });
    } finally {
      setSavingKits(false);
    }
  };

  if (!club) {
    return <div className="empty-state" style={{ paddingTop: 80 }}>Loading your club…</div>;
  }

  return (
    <div>
      <Toast ref={toast} />
      <div className="page-head">
        <div>
          <div className="kicker">Club office</div>
          <h1>My Club</h1>
        </div>
      </div>

      <div className="card" style={{ maxWidth: 640 }}>
        <h2 className="card-title">
          <Flag size={17} /> Club identity
        </h2>
        <div className="form-group" style={{ marginTop: 12 }}>
          <label className="jm-label" htmlFor="myclub-name">
            <Flag size={13} /> Club name
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
            <Home size={13} /> Stadium
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
          <label className="jm-label">
            <Globe2 size={13} /> Nation
          </label>
          <input className="select" value={club.country} disabled style={{ width: "100%" }} />
          <div className="jm-hint">Locked — your nation shapes youth recruitment and league clustering.</div>
        </div>
        <button
          className="btn gold"
          style={{ marginTop: 8 }}
          onClick={() => void saveProfile()}
          disabled={savingProfile || !profileDirty || !nameValid || !stadiumValid}
        >
          <SaveIcon size={15} /> {savingProfile ? "Saving…" : "Save identity"}
        </button>
      </div>

      <div className="card kd-card" style={{ maxWidth: 960, marginTop: 16 }}>
        <h2 className="card-title">
          <Shirt size={17} /> Kits
        </h2>
        <div style={{ color: "var(--text-3)", fontSize: "0.9rem", marginBottom: 14 }}>
          Design your Home, Away and Goalkeeper kits. Changes are visible to every manager immediately.
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
          <SaveIcon size={15} /> {savingKits ? "Saving…" : "Save kits"}
        </button>
      </div>
    </div>
  );
}
