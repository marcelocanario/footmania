import { useState } from "react";
import { Dialog } from "primereact/dialog";
import { Ban, ImageOff, ShieldCheck, Sparkles, Wrench } from "lucide-react";
import { api, type AdminClubDetail } from "../../api/client";
import { useAdminFetch, type TabProps } from "./adminShared";
import { StatusChip } from "./StatusChip";
import { ConfirmDialog, type ConfirmRequest } from "./ConfirmDialog";
import { ModerationDialog, WarningsDialog, type ModerationRequest } from "./moderationShared";

/**
 * Per-club moderation drawer for the admin competition drill-down. Surfaces
 * the existing moderation endpoints (name/stadium reset, logo removal,
 * nickname clearing, owner warn/ban/unban) in the club's context instead of
 * asking for raw ids.
 */
export function ClubModerationDialog({ clubId, onClose, notify }: { clubId: number | null; onClose: () => void; notify: TabProps["notify"] }) {
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [moderation, setModeration] = useState<ModerationRequest | null>(null);
  const [warningsFor, setWarningsFor] = useState<{ id: number; name: string } | null>(null);
  // Reroll counter for generated name suggestions; deterministic per attempt.
  const [nameAttempt, setNameAttempt] = useState(0);
  const [reloadTick, setReloadTick] = useState(0);

  const detail = useAdminFetch(
    () => (clubId !== null ? api.adminClubDetail(clubId).then((res) => res.club) : Promise.resolve(null)),
    [clubId, reloadTick],
  );
  const reloadDetail = () => setReloadTick((t) => t + 1);
  const club = clubId !== null ? detail.data : null;

  const act = async (action: () => Promise<unknown>, done: string) => {
    try {
      await action();
      notify("success", done);
      reloadDetail();
    } catch (e) {
      notify("error", "Action failed", (e as Error).message);
    }
  };

  const openResetName = async () => {
    if (!club) return;
    let suggested: string | undefined;
    try {
      suggested = (await api.adminSuggestedClubName(nameAttempt)).name;
      setNameAttempt((a) => a + 1);
    } catch {
      // Suggestion is optional; an empty field still restores a generated default.
    }
    setModeration({
      title: `Reset club name · ${club.name}`,
      description: <>Overwrites the club's display name and issues a warning to the owner. Clearing the field restores a generated default.</>,
      submitLabel: "Reset name",
      fields: [{ key: "name", label: `New name${suggested ? " (suggested)" : " (empty = generated default)"}`, type: "text", placeholder: suggested ?? "generated default" }],
      initialValues: suggested ? { name: suggested } : {},
      run: async (values) => {
        await api.adminResetClubName(club.id, values.name.trim() || undefined, values.reason);
        notify("success", "Club name reset");
        reloadDetail();
      },
    });
  };

  const openBan = () => {
    if (!club?.ownerUserId || !club.ownerUsername) return;
    const ownerId = club.ownerUserId;
    const ownerName = club.ownerUsername;
    setModeration({
      title: `Ban ${ownerName}`,
      description: <>Banning blocks login and kills all active sessions immediately.</>,
      submitLabel: "Ban user",
      fields: [{ key: "reason", label: "Reason", type: "text", placeholder: "Shown to the user and kept in the audit log" }],
      run: async (values) => {
        await api.adminBanUser(ownerId, values.reason);
        notify("success", `${ownerName} banned`);
        reloadDetail();
      },
    });
  };

  const openWarn = () => {
    if (!club?.ownerUserId || !club.ownerUsername) return;
    const ownerId = club.ownerUserId;
    const ownerName = club.ownerUsername;
    setModeration({
      title: `Warn ${ownerName}`,
      description: <>The warning surfaces as a banner until the user acknowledges it.</>,
      submitLabel: "Send warning",
      fields: [{ key: "reason", label: "Warning text", type: "text", placeholder: "What should the user change?" }],
      run: async (values) => {
        await api.adminWarnUser(ownerId, values.reason);
        notify("success", `${ownerName} warned`);
      },
    });
  };

  const openClearNickname = (player: { id: number; name: string; nickname: string }) =>
    setModeration({
      title: `Clear nickname · ${player.nickname}`,
      description: <>Removes <b>{player.nickname}</b> so {player.name} is shown by their real name everywhere again. A warning is issued to the club owner.</>,
      submitLabel: "Clear nickname",
      fields: [
        { key: "playerId", label: "Player id", type: "number", optional: true },
        { key: "reason", label: "Reason", type: "text", placeholder: "Required for the audit log" },
      ],
      initialValues: { playerId: String(player.id) },
      run: async (values) => {
        await api.adminClearNickname(player.id, values.reason);
        notify("success", "Nickname cleared");
        reloadDetail();
      },
    });

  const footerActions = (target: AdminClubDetail) => (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div className="section-label" style={{ marginBottom: 2 }}>Content moderation</div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button className="btn ghost sm" onClick={() => void openResetName()}><Wrench size={13} /> Reset club name…</button>
        <button
          className="btn ghost sm"
          onClick={() =>
            setModeration({
              title: `Reset stadium name · ${target.name}`,
              description: <>Overwrites the stadium name, e.g. after an inappropriate custom entry. A warning is issued to the owner.</>,
              submitLabel: "Reset stadium",
              fields: [{ key: "stadiumName", label: "New stadium name", type: "text", placeholder: target.stadiumName }],
              run: async (values) => {
                await api.adminResetStadiumName(target.id, values.stadiumName, values.reason);
                notify("success", "Stadium name reset");
                reloadDetail();
              },
            })
          }
        >
          <Wrench size={13} /> Reset stadium name…
        </button>
        {target.hasCustomLogo && (
          <button
            className="btn ghost sm"
            onClick={() =>
              setModeration({
                title: `Remove custom logo · ${target.name}`,
                description: <>Deletes the uploaded custom logo. The club falls back to its procedural badge. A warning is issued to the owner.</>,
                submitLabel: "Remove logo",
                fields: [{ key: "reason", label: "Reason", type: "text", placeholder: "Required for the audit log" }],
                run: async (values) => {
                  await api.adminRemoveLogo(target.id, values.reason);
                  notify("success", "Logo removed");
                  reloadDetail();
                },
              })
            }
          >
            <ImageOff size={13} /> Remove logo…
          </button>
        )}
      </div>

      {target.nicknamedPlayers.length > 0 && (
        <>
          <div className="section-label" style={{ marginBottom: 2 }}>Player nicknames</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {target.nicknamedPlayers.map((player) => (
              <div key={player.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                <span style={{ fontSize: "0.9rem" }}>
                  <span style={{ fontWeight: 600 }}>{player.nickname}</span>
                  <span style={{ color: "var(--text-3)" }}> · {player.name} #{player.id}</span>
                </span>
                <button className="btn ghost sm" onClick={() => openClearNickname(player)}><Sparkles size={13} /> Clear…</button>
              </div>
            ))}
          </div>
        </>
      )}

      {target.ownerUserId !== null && target.ownerUsername && (
        <>
          <div className="section-label" style={{ marginBottom: 2 }}>Owner</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <span>{target.ownerUsername} <span style={{ color: "var(--text-3)" }}>#{target.ownerUserId}</span></span>
            {target.ownerBannedAt && <StatusChip label="BANNED" tone="failed" />}
            {!target.ownerBannedAt && <button className="btn ghost danger sm" onClick={openBan}><Ban size={13} /> Ban…</button>}
            {!target.ownerBannedAt && <button className="btn ghost sm" onClick={openWarn}>Warn…</button>}
            {target.ownerBannedAt && (
              <button
                className="btn sm"
                onClick={() =>
                  setConfirm({
                    title: `Unban ${target.ownerUsername}?`,
                    message: <>The user can log in again immediately and regains access to the world.</>,
                    confirmLabel: "Unban",
                    onConfirm: () => act(() => api.adminUnbanUser(target.ownerUserId!), `${target.ownerUsername} unbanned`),
                  })
                }
              >
                <ShieldCheck size={13} /> Unban…
              </button>
            )}
            <button className="btn ghost sm" onClick={() => setWarningsFor({ id: target.ownerUserId!, name: target.ownerUsername! })}>Warnings</button>
          </div>
        </>
      )}
    </div>
  );

  return (
    <>
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
      <ModerationDialog request={moderation} onClose={() => setModeration(null)} />
      <WarningsDialog user={warningsFor} onClose={() => setWarningsFor(null)} />
      <Dialog header="Club moderation" visible={clubId !== null} onHide={onClose} style={{ width: 560 }}>
        {detail.error && <div style={{ color: "#ff6b6b" }}>{detail.error}</div>}
        {!detail.error && detail.loading && !club && <div className="empty-state" style={{ padding: 24 }}>Loading…</div>}
        {!detail.error && club && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontFamily: "var(--font-display)", fontSize: "1.15rem", fontWeight: 700 }}>{club.name}</span>
              <span style={{ color: "var(--text-3)" }}>#{club.id}</span>
              <StatusChip label={club.competitionState} tone={club.competitionState === "ACTIVE" ? "done" : club.competitionState === "DORMANT" ? "failed" : "neutral"} />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, fontSize: "0.9rem" }}>
              <div><span style={{ color: "var(--text-3)" }}>Stadium:</span> {club.stadiumName}</div>
              <div><span style={{ color: "var(--text-3)" }}>Division:</span> {club.division ? `D${club.division.tier} · Group ${club.division.groupIndex + 1}` : "—"}</div>
              <div><span style={{ color: "var(--text-3)" }}>Cash:</span> {club.cash.toLocaleString()}</div>
              <div>
                <span style={{ color: "var(--text-3)" }}>Cushion:</span>{" "}
                <span style={{ color: club.financialCushion < 0 ? "#ff6b6b" : undefined }}>{club.financialCushion.toLocaleString()}</span>
              </div>
              <div><span style={{ color: "var(--text-3)" }}>Squad:</span> {club.squadSize} seniors{club.avgOverall !== null ? ` · avg ${club.avgOverall.toFixed(1)} OVR` : ""}</div>
              <div><span style={{ color: "var(--text-3)" }}>Custom logo:</span> {club.hasCustomLogo ? "yes" : "no"}</div>
            </div>
            <div style={{ borderTop: "1px solid var(--line)", paddingTop: 12 }}>{footerActions(club)}</div>
          </div>
        )}
      </Dialog>
    </>
  );
}

