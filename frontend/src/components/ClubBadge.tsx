import { FootballKit } from "./kit/FootballKit";
import type { KitDesign } from "./kit/types";

/**
 * Club identity badge. Renders the club's actual home jersey when kit data is
 * available (Kit Lab), falling back to the legacy initials circle otherwise.
 */
export function ClubBadge({ name, primary, secondary, kit, size = 40 }: { name: string; primary?: string; secondary?: string; kit?: KitDesign | null; size?: number }) {
  if (kit) {
    return (
      <span title={name} style={{ width: size, height: size, display: "inline-block", lineHeight: 0 }}>
        <FootballKit {...kit} flat size="100%" />
      </span>
    );
  }
  const initials = name
    .split(" ")
    .filter((w) => w.length > 0)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
  return (
    <div
      className="club-badge"
      style={{
        width: size,
        height: size,
        background: `linear-gradient(135deg, ${primary ?? "#1f9d55"}, ${secondary ?? "#0f2a43"})`,
        fontSize: size * 0.32,
      }}
      title={name}
    >
      {initials}
    </div>
  );
}
