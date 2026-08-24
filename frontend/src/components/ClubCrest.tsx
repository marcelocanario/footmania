import { useMemo } from "react";
import { ClubBadge } from "./ClubBadge";
import type { KitDesign } from "./kit/types";

/**
 * Club identity with custom-logo support. Renders the uploaded custom raster
 * logo when the club has one, otherwise falls through to ClubBadge (home
 * jersey from Kit Lab or the initials circle for legacy clubs).
 */
export function ClubCrest({
  name,
  primary,
  secondary,
  kit,
  size = 26,
  clubId,
  hasCustomLogo,
}: {
  name: string;
  primary?: string;
  secondary?: string;
  kit?: KitDesign | null;
  size?: number;
  clubId?: number;
  hasCustomLogo?: boolean;
}) {
  // Cache-bust only when the logo could actually have changed (club switch
  // or the custom-logo flag flipping), not on every render — otherwise the
  // browser can never cache crest images across re-renders.
  const cacheBust = useMemo(() => Date.now(), [clubId, hasCustomLogo]);
  if (hasCustomLogo && clubId !== undefined) {
    return (
      <img
        src={`/api/clubs/${clubId}/logo?ts=${cacheBust}`}
        alt={name}
        title={name}
        style={{ width: size, height: size, borderRadius: Math.max(4, size * 0.18), objectFit: "contain", background: "rgba(255,255,255,0.06)" }}
      />
    );
  }
  return <ClubBadge name={name} primary={primary} secondary={secondary} kit={kit} size={size} />;
}
