import { useState } from "react";
import { DataTable } from "primereact/datatable";
import { Column } from "primereact/column";
import { InputText } from "primereact/inputtext";
import { Ban, ShieldCheck, ShieldOff, Sparkles, Users, Wrench } from "lucide-react";
import { api } from "../../api/client";
import { AdminCard, useAdminFetch, type TabProps } from "./adminShared";
import { StatusChip } from "./StatusChip";
import { ConfirmDialog, type ConfirmRequest } from "./ConfirmDialog";
import { ModerationDialog, WarningsDialog, type ModerationRequest } from "./moderationShared";

type AdminUser = { id: number; name: string; email: string; isAdmin: boolean; isPro: boolean; elo: number | null; bannedAt: string | null; banReason: string | null; createdAt: string };

export function UsersTab({ version, notify }: TabProps) {
  const [searchInput, setSearchInput] = useState("");
  const [appliedSearch, setAppliedSearch] = useState<string | undefined>(undefined);
  const users = useAdminFetch(() => api.adminListUsers(appliedSearch, 50).then((r) => r.users), [version, appliedSearch]);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [moderation, setModeration] = useState<ModerationRequest | null>(null);
  const [warningsFor, setWarningsFor] = useState<AdminUser | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const act = async (key: string, action: () => Promise<unknown>, done: string, refetch = true) => {
    setBusyKey(key);
    try {
      await action();
      notify("success", done);
      if (refetch) users.reload();
    } catch (e) {
      notify("error", "Action failed", (e as Error).message);
    } finally {
      setBusyKey(null);
    }
  };

  const togglePro = (u: AdminUser) =>
    void act(`pro:${u.id}`, () => api.adminSetPro(u.id, !u.isPro), `${u.name} Pro ${u.isPro ? "revoked" : "granted"}`);

  const banUser = (u: AdminUser) =>
    setModeration({
      title: `Ban ${u.name}`,
      description: <>Banning blocks login and kills all active sessions immediately.</>,
      submitLabel: "Ban user",
      fields: [{ key: "reason", label: "Reason", type: "text", placeholder: "Shown to the user and kept in the audit log" }],
      run: async (values) => {
        await api.adminBanUser(u.id, values.reason);
        notify("success", `${u.name} banned`);
        users.reload();
      },
    });

  const warnUser = (u: AdminUser) =>
    setModeration({
      title: `Warn ${u.name}`,
      description: <>The warning surfaces as a banner until the user acknowledges it.</>,
      submitLabel: "Send warning",
      fields: [{ key: "reason", label: "Warning text", type: "text", placeholder: "What should the user change?" }],
      run: async (values) => {
        await api.adminWarnUser(u.id, values.reason);
        notify("success", `${u.name} warned`);
      },
    });

  const moderationActions = [
    {
      key: "reset-club-name",
      icon: <Wrench size={14} />,
      label: "Reset club name",
      request: {
        title: "Reset club name",
        description: <>Reverts a club's display name to its generated default and blocks further custom edits.</>,
        submitLabel: "Reset name",
        fields: [
          { key: "clubId", label: "Club id", type: "number", placeholder: "e.g. 42" },
          { key: "name", label: "New name (optional — empty restores the generated name)", type: "text", placeholder: "e.g. restored name" },
          { key: "reason", label: "Reason", type: "text", placeholder: "Required for the audit log" },
        ],
        run: async (values) => {
          await api.adminResetClubName(Number(values.clubId), values.name, values.reason);
          notify("success", "Club name reset");
        },
      } as ModerationRequest,
    },
    {
      key: "reset-stadium-name",
      icon: <Wrench size={14} />,
      label: "Reset stadium name",
      request: {
        title: "Reset stadium name",
        description: <>Overwrites a club's stadium name, e.g. after an inappropriate custom entry.</>,
        submitLabel: "Reset stadium",
        fields: [
          { key: "clubId", label: "Club id", type: "number", placeholder: "e.g. 42" },
          { key: "stadiumName", label: "New stadium name", type: "text", placeholder: "Replacement text" },
          { key: "reason", label: "Reason", type: "text", placeholder: "Required for the audit log" },
        ],
        run: async (values) => {
          await api.adminResetStadiumName(Number(values.clubId), values.stadiumName, values.reason);
          notify("success", "Stadium name reset");
        },
      } as ModerationRequest,
    },
    {
      key: "remove-logo",
      icon: <ShieldOff size={14} />,
      label: "Remove logo",
      request: {
        title: "Remove club logo",
        description: <>Deletes a club's uploaded custom logo. The club falls back to its procedural badge.</>,
        submitLabel: "Remove logo",
        fields: [
          { key: "clubId", label: "Club id", type: "number", placeholder: "e.g. 42" },
          { key: "reason", label: "Reason", type: "text", placeholder: "Required for the audit log" },
        ],
        run: async (values) => {
          await api.adminRemoveLogo(Number(values.clubId), values.reason);
          notify("success", "Logo removed");
        },
      } as ModerationRequest,
    },
    {
      key: "clear-nickname",
      icon: <Sparkles size={14} />,
      label: "Clear player nickname",
      request: {
        title: "Clear player nickname",
        description: <>Removes a player's custom nickname so their real name is shown everywhere again.</>,
        submitLabel: "Clear nickname",
        fields: [
          { key: "playerId", label: "Player id", type: "number", placeholder: "e.g. 1234" },
          { key: "reason", label: "Reason", type: "text", placeholder: "Required for the audit log" },
        ],
        run: async (values) => {
          await api.adminClearNickname(Number(values.playerId), values.reason);
          notify("success", "Nickname cleared");
        },
      } as ModerationRequest,
    },
  ];

  const userActions = (u: AdminUser) => (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      {!u.isAdmin && (
        <button className="btn sm" disabled={busyKey !== null} onClick={() => togglePro(u)}>{u.isPro ? "Revoke Pro" : "Grant Pro"}</button>
      )}
      {u.bannedAt ? (
        <button
          className="btn sm"
          disabled={busyKey !== null}
          onClick={() =>
            setConfirm({
              title: `Unban ${u.name}?`,
              message: <>The user can log in again immediately and regains access to the world.</>,
              confirmLabel: "Unban",
              onConfirm: () => act(`unban:${u.id}`, () => api.adminUnbanUser(u.id), `${u.name} unbanned`),
            })
          }
        >
          <ShieldCheck size={13} /> Unban…
        </button>
      ) : (
        !u.isAdmin && <button className="btn sm ghost danger" disabled={busyKey !== null} onClick={() => banUser(u)}><Ban size={13} /> Ban…</button>
      )}
      {!u.bannedAt && <button className="btn sm ghost" disabled={busyKey !== null} onClick={() => warnUser(u)}>Warn…</button>}
      <button className="btn sm ghost" disabled={busyKey !== null} onClick={() => setWarningsFor(u)}>Warnings</button>
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
      <ModerationDialog request={moderation} onClose={() => setModeration(null)} />
      <WarningsDialog user={warningsFor} onClose={() => setWarningsFor(null)} />

      <AdminCard
        icon={<Users size={17} />}
        title="Users"
        subtitle="Permissions are cumulative: admins always have Pro features. Bans block login and kill sessions; warnings surface as a banner until acknowledged."
      >
        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <InputText
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search name or email"
            aria-label="Search name or email"
            onKeyDown={(e) => e.key === "Enter" && setAppliedSearch(searchInput.trim() || undefined)}
          />
          <button className="btn" disabled={users.loading} onClick={() => setAppliedSearch(searchInput.trim() || undefined)}>Search</button>
          <button className="btn ghost" disabled={users.loading} onClick={() => { setSearchInput(""); setAppliedSearch(undefined); }}>List all</button>
        </div>
        <div className="table-wrap">
          <DataTable
            value={users.data ?? []}
            loading={users.loading}
            dataKey="id"
            paginator
            rows={15}
            className="squad-table"
            tableStyle={{ width: "100%", tableLayout: "fixed" }}
            emptyMessage={users.loading ? "Loading…" : "No users found."}
          >
            <Column header="User" body={(u) => <span>{u.name} <span style={{ color: "var(--text-3)" }}>#{u.id}</span></span>} style={{ width: "auto" }} />
            <Column header="Email" body={(u: AdminUser) => <span style={{ color: "var(--text-3)" }}>{u.email}</span>} style={{ width: "auto" }} />
            <Column header="Flags" body={(u) => (
              <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                {u.isPro && <StatusChip label="PRO" tone="gold" />}
                {u.isAdmin && <StatusChip label="ADMIN" tone="info" />}
                {u.bannedAt && <StatusChip label="BANNED" tone="failed" />}
                {!u.isPro && !u.isAdmin && !u.bannedAt && <StatusChip label="regular" tone="neutral" />}
              </div>
            )} style={{ width: 220 }} />
            <Column header="Elo" body={(u) => u.elo === null ? <span style={{ color: "var(--text-3)" }}>-</span> : u.elo.toLocaleString()} sortable sortField="elo" style={{ width: 90 }} />
            <Column header="Joined" body={(u) => new Date(u.createdAt).toLocaleDateString()} sortable sortField="createdAt" style={{ width: 120 }} />
            <Column header="Ban detail" body={(u) => u.bannedAt ? <span style={{ color: "#ff6b6b" }}>{u.banReason ?? "banned"} · since {new Date(u.bannedAt).toLocaleDateString()}</span> : <span style={{ color: "var(--text-3)" }}>-</span>} style={{ width: "auto" }} />
            <Column header="Actions" body={userActions} style={{ width: 320 }} />
          </DataTable>
        </div>

        <div style={{ borderTop: "1px solid var(--line)", margin: "18px 0 12px" }} />
        <div className="section-label" style={{ marginBottom: 4 }}>Content moderation</div>
        <div style={{ color: "var(--text-2)", fontSize: "0.85rem", marginBottom: 10 }}>
          Targeted clean-ups for inappropriate content. Club and player ids appear in the world data — every action requires a reason and is audit-logged.
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {moderationActions.map((action) => (
            <button key={action.key} className="btn ghost" onClick={() => setModeration(action.request)}>
              {action.icon} {action.label}
            </button>
          ))}
        </div>
      </AdminCard>
    </div>
  );
}

