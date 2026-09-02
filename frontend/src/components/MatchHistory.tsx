import type { LiveEvent } from "../api/client";
import { useTranslation } from "react-i18next";
import i18n from "i18next";
import { automationSubtypeKey } from "../automation";

function eventLabel(type: number): string {
  return (i18n.t as unknown as (k: string) => string)(`matchHistory.${type}`);
}

/** i18next's t() is typed against the literal key union derived from en.ts;
 *  a runtime-computed key (e.g. automationSubtypeKey's result) needs the same
 *  escape hatch eventLabel uses above. */
function tDynamic(key: string): string {
  return (i18n.t as unknown as (k: string) => string)(key);
}

function EventIcon({ type, subtype }: { type: number; subtype: number }) {
  let cls = "event-ico event-miss";
  let glyph = "⚽";
  if (type === 1) { cls = "event-ico event-goal"; glyph = subtype === 2 ? "🥅" : "⚽"; }
  else if (type === 2) { cls = "event-ico event-yellow"; glyph = "🟨"; }
  else if (type === 3 || type === 4) { cls = "event-ico event-red"; glyph = "🟥"; }
  else if (type === 5) { cls = "event-ico event-inj"; glyph = "🩹"; }
  else if (type === 6) { cls = "event-ico event-sub"; glyph = "🔄"; }
  else if (type === 7) { cls = "event-ico event-miss"; glyph = "❌"; }
  else if (type === 9) { cls = "event-ico event-miss"; glyph = "🪙"; }
  else if (type === 10) { cls = "event-ico event-neutral"; glyph = "⏸️"; }
  else if (type === 11) { cls = "event-ico event-neutral"; glyph = "▶️"; }
  else if (type === 12) { cls = "event-ico event-neutral"; glyph = "🏁"; }
  else if (type === 13) { cls = "event-ico event-miss"; glyph = "🎯"; }
  else if (type === 14) { cls = "event-ico event-detail"; glyph = "🚩"; }
  else if (type === 15) { cls = "event-ico event-detail"; glyph = "🧤"; }
  else if (type === 16) { cls = "event-ico event-detail"; glyph = "💥"; }
  else if (type === 17) { cls = "event-ico event-detail"; glyph = "↗"; }
  else if (type === 18) { cls = "event-ico event-detail"; glyph = "🛡️"; }
  else if (type === 19) { cls = "event-ico event-mvp"; glyph = "🏆"; }
  else if (type === 20) { cls = "event-ico event-auto"; glyph = "🤖"; }
  return <span className={cls}>{glyph}</span>;
}

function formatMinute(event: LiveEvent): string {
  return event.addedTime ? `${event.minute}+${event.addedTime}'` : `${event.minute}'`;
}

function PlayerLink({ playerId, name, onPlayerClick }: { playerId?: number | null; name: string; onPlayerClick?: (id: number, name: string) => void }) {
  if (!name) return null;
  if (playerId == null || !onPlayerClick) return <span className="ev-name">{name}</span>;
  return <button type="button" className="event-player-link" onClick={(click) => { click.stopPropagation(); onPlayerClick(playerId, name); }}>{name}</button>;
}

/** Score snapshot (home-away) just before each event, reconstructed from the
 *  recorded in-play goals so boundary rows can read "Half-time · 2-1". */
function scoreSnapshots(orderedNewestFirst: LiveEvent[], homeClubId: number): Map<LiveEvent, [number, number]> {
  const snapshots = new Map<LiveEvent, [number, number]>();
  let home = 0;
  let away = 0;
  for (const event of orderedNewestFirst.slice().reverse()) {
    snapshots.set(event, [home, away]);
    if (event.type === 1 && event.minute < 100) {
      if (event.clubId === homeClubId) home++;
      else away++;
    }
  }
  return snapshots;
}

export function MatchHistory({
  events,
  homeClubId,
  homeName,
  awayName,
  emptyText,
  onPlayerClick,
}: {
  events: LiveEvent[];
  homeClubId: number;
  homeName: string;
  awayName: string;
  emptyText?: string;
  onPlayerClick?: (id: number, name: string) => void;
}) {
  const { t } = useTranslation();
  const empty = emptyText ?? t("matchHistory.defaultEmpty");
  const orderedEvents = events
    .filter((event) => event.type !== 8)
    .slice()
    .sort((a, b) => (b.sequence ?? 0) - (a.sequence ?? 0) || b.minute - a.minute || (b.addedTime ?? 0) - (a.addedTime ?? 0) || b.type - a.type);
  const scoreAt = scoreSnapshots(orderedEvents, homeClubId);

  return (
    <div className="event-feed">
      {orderedEvents.length === 0 && <div className="empty-state" style={{ padding: 14 }}>{empty}</div>}
      {orderedEvents.map((event, index) => {
        const coinWinner = event.type === 9 ? (event.clubId === homeClubId ? homeName : awayName) : "";
        const score = scoreAt.get(event);
        const scoreTag = score ? <span className="ev-label">· {score[0]}–{score[1]}</span> : null;
        return (
          <div className="event-row" key={`${event.sequence ?? "event"}-${index}`}>
            <span className="min">{formatMinute(event)}</span>
            <EventIcon type={event.type} subtype={event.subtype} />
            {event.type === 9 ? (
              <><span className="ev-label">{eventLabel(event.type)}</span><span className="ev-name">{coinWinner} {t("matchHistory.wonToss")}</span></>
            ) : event.type === 1 && event.subtype !== 2 && event.player2 ? (
              <><span className="ev-label">{eventLabel(event.type)}</span><PlayerLink playerId={event.playerId} name={event.player} onPlayerClick={onPlayerClick} /><span className="ev-label">{t("matchHistory.assist")}</span><PlayerLink playerId={event.player2Id} name={event.player2} onPlayerClick={onPlayerClick} /></>
            ) : event.type === 5 ? (
              <><span className="ev-label">{t("matchHistory.5")}</span><PlayerLink playerId={event.playerId} name={event.player} onPlayerClick={onPlayerClick} />{event.goalType != null && event.goalType > 0 && <span className="ev-label">{t("matchHistory.injuryOut", { days: event.goalType })}</span>}</>
            ) : event.type === 6 ? (
              <><span className="ev-label">{eventLabel(event.type)}</span><PlayerLink playerId={event.player2Id} name={event.player2} onPlayerClick={onPlayerClick} /><span className="ev-label">{t("matchHistory.replaces")}</span><PlayerLink playerId={event.playerId} name={event.player} onPlayerClick={onPlayerClick} /></>
            ) : event.type === 10 || event.type === 12 || event.type === 13 ? (
              <><span className="ev-label">{eventLabel(event.type)}</span>{scoreTag}</>
            ) : event.type === 14 ? (
              <><span className="ev-label">{eventLabel(event.type)}</span><PlayerLink playerId={event.playerId} name={event.player} onPlayerClick={onPlayerClick} /></>
            ) : event.type === 15 ? (
              <><PlayerLink playerId={event.playerId} name={event.player} onPlayerClick={onPlayerClick} /><span className="ev-label">{t("matchHistory.savedShotBy")}</span><PlayerLink playerId={event.player2Id} name={event.player2} onPlayerClick={onPlayerClick} /></>
            ) : event.type === 18 && event.player2 ? (
              <><span className="ev-label">{eventLabel(event.type)}</span><PlayerLink playerId={event.playerId} name={event.player} onPlayerClick={onPlayerClick} /><span className="ev-label">{t("matchHistory.blockedBy")}</span><PlayerLink playerId={event.player2Id} name={event.player2} onPlayerClick={onPlayerClick} /></>
            ) : event.type === 19 ? (
              <><span className="ev-label">{eventLabel(event.type)}</span><PlayerLink playerId={event.playerId} name={event.player} onPlayerClick={onPlayerClick} /></>
            ) : event.type === 20 ? (
              // Automation fired (plan §11): subtype distinguishes what the
              // rule actually did. SUB (1) and SWAP_SLOTS (5) name two
              // players; SET_TAKER (4) names one; TACTICS (2) and FORMATION
              // (3) change nothing player-specific, so no PlayerLink.
              <>
                <span className="ev-label">{t("matchHistory.20")}</span>
                <span className="ev-label" style={{ opacity: 0.85 }}>{tDynamic(automationSubtypeKey(event.subtype))}</span>
                {event.subtype === 1 && (
                  <><PlayerLink playerId={event.player2Id} name={event.player2} onPlayerClick={onPlayerClick} /><span className="ev-label">{t("matchHistory.replaces")}</span><PlayerLink playerId={event.playerId} name={event.player} onPlayerClick={onPlayerClick} /></>
                )}
                {event.subtype === 4 && <PlayerLink playerId={event.playerId} name={event.player} onPlayerClick={onPlayerClick} />}
                {event.subtype === 5 && (
                  <><PlayerLink playerId={event.playerId} name={event.player} onPlayerClick={onPlayerClick} /><span className="ev-label">⇄</span><PlayerLink playerId={event.player2Id} name={event.player2} onPlayerClick={onPlayerClick} /></>
                )}
              </>
            ) : (
              <><span className="ev-label">{eventLabel(event.type) ?? t("matchHistory.fallbackEvent")}</span><PlayerLink playerId={event.playerId} name={event.player} onPlayerClick={onPlayerClick} /></>
            )}
          </div>
        );
      })}
    </div>
  );
}
