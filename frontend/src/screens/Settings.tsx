import { useEffect, useState } from "react";
import { Settings as SettingsIcon, Clock, Users } from "lucide-react";
import { api } from "../api/client";
import { useGame } from "../store/game";
import { strings } from "../strings";
import { AvailabilityPicker, PRESET_EVENINGS, MIN_SLOTS } from "../components/AvailabilityPicker";
import { localSlotsToUtc, utcSlotsToLocal } from "../utils/time";

export function SettingsScreen() {
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
          <div className="kicker">Preferences</div>
          <h1>Settings</h1>
        </div>
      </div>

      <div className="card" style={{ maxWidth: 640 }}>
        <h2 className="card-title"><Clock size={17} /> Preferred match times</h2>
        <div style={{ color: "var(--text-3)", fontSize: "0.9rem", marginBottom: 14 }}>
          When can you usually play? Fixtures are scheduled inside these windows whenever possible, and players with similar
          schedules are grouped into the same division next season. Changes apply from the next season — current fixtures never move.
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
            <SettingsIcon size={15} /> {savingHours ? strings.common.saving : strings.common.save}
          </button>
          {hoursSaved && <span style={{ color: "var(--grass-2)", fontSize: "0.9rem" }}>{strings.settings.saved}</span>}
        </div>
      </div>

      <div className="card" style={{ maxWidth: 640, marginTop: 16 }}>
        <h2 className="card-title"><Users size={17} /> Group me with my friends</h2>
        <div style={{ color: "var(--text-3)", fontSize: "0.9rem", marginBottom: 14 }}>
          When enabled, accepted friendships (see the Friends tab) influence next season's division grouping so you and your
          friends land in the same group when possible. It only takes effect if your friend enables it too.
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: status?.club ? "pointer" : "default" }}>
          <input
            type="checkbox"
            checked={friendGrouping}
            disabled={!status?.club}
            onChange={(e) => { setFriendGrouping(e.target.checked); setFriendGroupingSaved(false); }}
          />
          <span style={{ fontSize: "0.92rem" }}>Try to place me in a group with my friends</span>
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
            {strings.common.save}
          </button>
          {friendGroupingSaved && <span style={{ color: "var(--grass-2)", fontSize: "0.9rem" }}>{strings.settings.saved}</span>}
        </div>
      </div>

      <div className="card" style={{ maxWidth: 640, marginTop: 16 }}>
        <h2 className="card-title"><SettingsIcon size={17} /> Push notifications</h2>
        <div style={{ color: "var(--text-3)", fontSize: "0.9rem", marginBottom: 12 }}>
          Match started / finished pushes land in your in-app bell. Enable browser pushes to receive them when the site is closed. <b>Pro</b> also gets goal pings and league digests.
        </div>
        {pushState === "unsupported" ? (
          <div style={{ color: "var(--text-3)", fontSize: "0.85rem" }}>Push is not supported in this browser.</div>
        ) : (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              className="btn"
              disabled={pushBusy}
              onClick={() => void (async () => {
                setPushBusy(true);
                try {
                  const perm = await Notification.requestPermission();
                  if (perm !== "granted") throw new Error("Permission denied");
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
              {pushBusy ? "…" : pushState === "subscribed" ? "Subscribed ✓" : "Enable browser pushes"}
            </button>
            {pushState === "subscribed" && <button className="btn ghost" onClick={() => void (async () => { const reg = await navigator.serviceWorker.ready; const sub = await reg.pushManager.getSubscription(); if (sub) { await sub.unsubscribe(); await api.pushUnsubscribe(sub.endpoint); } setPushState("idle"); })()}>Unsubscribe</button>}
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
