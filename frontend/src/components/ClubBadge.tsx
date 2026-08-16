export function ClubBadge({ name, primary, secondary, size = 40 }: { name: string; primary?: string; secondary?: string; size?: number }) {
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
