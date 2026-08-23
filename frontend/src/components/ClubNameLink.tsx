import { useNavigate } from "react-router-dom";
import { ClubCrest } from "./ClubCrest";
import type { KitDesign } from "./kit/types";

/**
 * Crest + club name that opens the team screen (/team/:id). Shared by every
 * screen that renders another club's name, so "click a team name" works
 * everywhere except Admin. stopPropagation-safe for use inside larger
 * clickable cards (fixture rows, stat tiles).
 */
export function ClubNameLink({
  clubId,
  name,
  primary,
  secondary,
  kit,
  hasCustomLogo,
  size = 22,
  showCrest = true,
}: {
  clubId: number;
  name: string;
  primary?: string;
  secondary?: string;
  kit?: KitDesign | null;
  hasCustomLogo?: boolean;
  size?: number;
  /** Render the crest too; false for plain-text contexts without badge data. */
  showCrest?: boolean;
}) {
  const navigate = useNavigate();
  const open = () => navigate(`/team/${clubId}`);
  return (
    <span
      className="club-name-link"
      role="link"
      tabIndex={0}
      title={`Open ${name}`}
      style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}
      onClick={(e) => {
        e.stopPropagation();
        open();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.stopPropagation();
          open();
        }
      }}
    >
      {showCrest && (
        <ClubCrest name={name} primary={primary} secondary={secondary} kit={kit} size={size} clubId={clubId} hasCustomLogo={hasCustomLogo} />
      )}
      <span>{name}</span>
    </span>
  );
}
