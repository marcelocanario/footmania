export function money(v: number): string {
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1000000) return `${sign}$${(abs / 1000000).toFixed(abs >= 10000000 ? 0 : 1)}M`;
  if (abs >= 1000) return `${sign}$${(abs / 1000).toFixed(0)}K`;
  return `${sign}$${abs}`;
}

export function num(v: number): string {
  return v.toLocaleString("en-US");
}
