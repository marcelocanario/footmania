import type { LiveEvent } from "../api/client";

const EVENT_LABELS: Record<number, string> = {
  1: "Goal!",
  2: "Yellow card",
  3: "Red card",
  5: "Injury",
  6: "Substitution",
  7: "Missed penalty",
  9: "Coin toss",
};

function EventIcon({ type, subtype }: { type: number; subtype: number }) {
  let cls = "event-ico event-miss";
  let glyph = "⚽";
  if (type === 1) { cls = "event-ico event-goal"; glyph = subtype === 2 ? "🥅" : "⚽"; }
  else if (type === 2) { cls = "event-ico event-yellow"; glyph = "🟨"; }
  else if (type === 3) { cls = "event-ico event-red"; glyph = "🟥"; }
  else if (type === 5) { cls = "event-ico event-inj"; glyph = "🩹"; }
  else if (type === 6) { cls = "event-ico event-sub"; glyph = "🔄"; }
  else if (type === 7) { cls = "event-ico event-miss"; glyph = "❌"; }
  else if (type === 9) { cls = "event-ico event-miss"; glyph = "🪙"; }
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

export function MatchHistory({
  events,
  homeClubId,
  homeName,
  awayName,
  emptyText = "The match is about to start...",
  onPlayerClick,
}: {
  events: LiveEvent[];
  homeClubId: number;
  homeName: string;
  awayName: string;
  emptyText?: string;
  onPlayerClick?: (id: number, name: string) => void;
}) {
  const visibleEvents = events
    .filter((event) => event.type !== 8)
    .slice()
    .sort((a, b) => (b.sequence ?? 0) - (a.sequence ?? 0) || b.minute - a.minute || (b.addedTime ?? 0) - (a.addedTime ?? 0) || b.type - a.type);

  return (
    <div className="event-feed">
      {visibleEvents.length === 0 && <div className="empty-state" style={{ padding: 14 }}>{emptyText}</div>}
      {visibleEvents.map((event, index) => {
        const coinWinner = event.type === 9 ? (event.clubId === homeClubId ? homeName : awayName) : "";
        return (
          <div className="event-row" key={`${event.sequence ?? "event"}-${index}`}>
            <span className="min">{formatMinute(event)}</span>
            <EventIcon type={event.type} subtype={event.subtype} />
            {event.type === 9 ? (
              <><span className="ev-label">{EVENT_LABELS[event.type]}</span><span className="ev-name">{coinWinner} won toss — kicks off</span></>
            ) : event.type === 1 && event.subtype !== 2 && event.player2 ? (
              <><span className="ev-label">{EVENT_LABELS[event.type]}</span><PlayerLink playerId={event.playerId} name={event.player} onPlayerClick={onPlayerClick} /><span className="ev-label">assist</span><PlayerLink playerId={event.player2Id} name={event.player2} onPlayerClick={onPlayerClick} /></>
            ) : event.type === 6 ? (
              <><span className="ev-label">{EVENT_LABELS[event.type]}</span><PlayerLink playerId={event.playerId} name={event.player} onPlayerClick={onPlayerClick} /><span className="ev-label">↔</span><PlayerLink playerId={event.player2Id} name={event.player2} onPlayerClick={onPlayerClick} /></>
            ) : (
              <><span className="ev-label">{EVENT_LABELS[event.type] ?? "Event"}</span><PlayerLink playerId={event.playerId} name={event.player} onPlayerClick={onPlayerClick} /></>
            )}
          </div>
        );
      })}
    </div>
  );
}
