import { useEffect, useState } from "react";
import { Settings as SettingsIcon, Clock, Users, Languages } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import { useGame } from "../store/game";
import { AvailabilityPicker, PRESET_EVENINGS, MIN_SLOTS } from "../components/AvailabilityPicker";
import { localSlotsToUtc, utcSlotsToLocal } from "../utils/time";
import { LanguagePicker } from "../components/LanguagePicker";

export function SettingsScreen() {
  const { t } = useTranslation();
  const { status, loadStatus } = useGame();
  const [preferredHours, setPreferredHours] = useState<number[]>(PRESET_EVENINGS);
  const [hoursSaved, setHoursSaved] = useState(false);
  const [savingHours, setSavingHours] = useState(false);
  const [friendGrouping, setFriendGrouping] = useState(true);
  const [friendGroupingSaved, setFriendGroupingSaved] = useState(false);
  const [pushState, setPushState] = useState<"idle" | "subscribed" | "unsupported">("idle");
  const [pushBusy, setPushBusy] = useState(false);

  useEffect(() => {
    if (status?.club?.preferredHours) setPreferredHours(utcSlotsToLocal(status.club.preferredHours));
    if (status?.club) setFriendGrouping(status.club.friendGroupingOptIn);
    if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) setPushState("unsupported");
  }, [status?.club?.preferredHours, status?.club?.friendGroupingOptIn]);

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="kicker">{t("settings.preferences")}</div>
          <h1>{t("settings.title")}</h1>
        </div>
      </div>

      <div className="card" style={{ maxWidth: 640 }}>
        <h2 className="card-title"><Languages size={17} /> {t("settings.language")}</h2>
        <LanguagePicker />
      </div>

      <div className="card" style={{ maxWidth: 640, marginTop: 16 }}>
        <h2 className="card-title"><Clock size={17} /> {t("settings.preferredMatchTimes")}</h2>
        <div style={{ color: "var(--text-3)", fontSize: "0.9rem", marginBottom: 14 }}>
          {t("settings.preferredMatchTimesDescription")}
        </div>
        <AvailabilityPicker value={preferredHours} onChange={(next) => { setPreferredHours(next); setHoursSaved(false); }} disabled={!status?.club} />
        <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 12 }}>
          <button
            className="btn gold"
            onClick={() => void (async () => {
              setSavingHours(true);
              try {
                await api.updatePreferredHours(localSlotsToUtc(preferredHours));
                await loadStatus();
                setHoursSaved(true);
                setTimeout(() => setHoursSaved(false), 2000);
              } finally {
                setSavingHours(false);
              }
            })()}
            disabled={!status?.club || savingHours || preferredHours.length < MIN_SLOTS}
          >
            <SettingsIcon size={15} /> {savingHours ? t("common.saving") : t("common.save")}
          </button>
          {hoursSaved && <span style={{ color: "var(--grass-2)", fontSize: "0.9rem" }}>{t("settings.saved")}</span>}
        </div>
      </div>

      <div className="card" style={{ maxWidth: 640, marginTop: 16 }}>
        <h2 className="card-title"><Users size={17} /> {t("settings.groupFriends")}</h2>
        <div style={{ color: "var(--text-3)", fontSize: "0.9rem", marginBottom: 14 }}>
          {t("settings.groupFriendsDescription")}
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: status?.club ? "pointer" : "default" }}>
          <input
            type="checkbox"
            checked={friendGrouping}
            disabled={!status?.club}
            onChange={(e) => { setFriendGrouping(e.target.checked); setFriendGroupingSaved(false); }}
          />
          <span style={{ fontSize: "0.92rem" }}>{t("settings.groupFriendsLabel")}</span>
        </label>
        <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 12 }}>
          <button
            className="btn"
            onClick={() => void (async () => {
              await api.updateFriendGrouping(friendGrouping);
              await loadStatus();
              setFriendGroupingSaved(true);
              setTimeout(() => setFriendGroupingSaved(false), 2000);
            })()}
            disabled={!status?.club}
          >
            {t("common.save")}
          </button>
          {friendGroupingSaved && <span style={{ color: "var(--grass-2)", fontSize: "0.9rem" }}>{t("settings.saved")}</span>}
        </div>
      </div>

      <div className="card" style={{ maxWidth: 640, marginTop: 16 }}>
        <h2 className="card-title"><SettingsIcon size={17} /> {t("settings.pushNotifications")}</h2>
        <div style={{ color: "var(--text-3)", fontSize: "0.9rem", marginBottom: 12 }}>
          {t("settings.pushDescription")}
        </div>
        {pushState === "unsupported" ? (
          <div style={{ color: "var(--text-3)", fontSize: "0.85rem" }}>{t("settings.pushUnsupported")}</div>
        ) : (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              className="btn"
              disabled={pushBusy}
              onClick={() => void (async () => {
                setPushBusy(true);
                try {
                  const perm = await Notification.requestPermission();
                  if (perm !== "granted") throw new Error(t("settings.permissionDenied"));
                  const reg = await navigator.serviceWorker.ready;
                  const { publicKey } = await api.getVapidKey();
                  if (!publicKey) throw new Error("Push not configured on server (VAPID keys missing)");
                  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
                  const json = sub.toJSON();
                  await api.pushSubscribe(json.endpoint!, json.keys!.p256dh!, json.keys!.auth!);
                  setPushState("subscribed");
                } catch (e) { alert((e as Error).message); } finally { setPushBusy(false); }
              })()}
            >
              {pushBusy ? "…" : pushState === "subscribed" ? t("settings.subscribed") : t("settings.enablePush")}
            </button>
            {pushState === "subscribed" && <button className="btn ghost" onClick={() => void (async () => { const reg = await navigator.serviceWorker.ready; const sub = await reg.pushManager.getSubscription(); if (sub) { await sub.unsubscribe(); await api.pushUnsubscribe(sub.endpoint); } setPushState("idle"); })()}>{t("settings.unsubscribe")}</button>}
          </div>
        )}
      </div>
    </div>
  );
}

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = base64String.replace(/-/g, "+").replace(/_/g, "/") + padding;
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}
