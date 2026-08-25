import { useEffect, useState } from "react";
import { FootballKit } from "./kit/FootballKit";
import { KIT_PATTERNS } from "./kit/patterns";
import { contrastInk } from "./kit/defaults";
import type { KitDesign } from "./kit/types";

/** Seconds between jersey swaps on the landing page. */
const ROTATE_MS = 3200;
const MAX_NUMBER = 40;

function hslToHex(h: number, s: number, l: number): string {
  const hue = (v: number) => ((v % 1) + 1) % 1;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number) => {
    t = hue(t);
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const byte = (t: number) => Math.round(Math.min(1, Math.max(0, channel(t))) * 255).toString(16).padStart(2, "0");
  return `#${byte(h + 1 / 3)}${byte(h)}${byte(h - 1 / 3)}`;
}

function randomSaturation(): number {
  return 0.55 + Math.random() * 0.32;
}

/**
 * Randomly compose a plausible kit design: a vibrant shell hue, a detail color
 * that either flips contrast or jumps to a complementary hue, and trim/number
 * ink chosen for readability on the shell.
 */
function randomDesign(previousPattern?: string): KitDesign {
  const h = Math.random();
  const sat = randomSaturation();
  const light = 0.38 + Math.random() * 0.34;
  const primary = hslToHex(h, sat, light);

  const contrasting = Math.random() < 0.55;
  const secondary = contrasting
    ? contrastInk(primary)
    : hslToHex((h + 0.5) % 1, randomSaturation(), light < 0.5 ? Math.min(0.8, light + 0.28) : Math.max(0.2, light - 0.28));

  const patternPool = KIT_PATTERNS.map((p) => p.id);
  const pool = previousPattern ? patternPool.filter((id) => id !== previousPattern) : patternPool;
  const pattern = pool[Math.floor(Math.random() * pool.length)];

  return {
    primary,
    secondary,
    accent: contrastInk(primary),
    numberColor: contrastInk(primary),
    pattern,
  };
}

/**
 * Keeps rendering a different random jersey every few seconds, as a showcase
 * of the in-game kit generator. Pure decoration — no state leaks to the app.
 */
export function RotatingJersey() {
  const [serial, setSerial] = useState(0);
  const [design, setDesign] = useState<KitDesign>(() => randomDesign());
  const [number, setNumber] = useState<number>(() => 1 + Math.floor(Math.random() * MAX_NUMBER));

  useEffect(() => {
    const id = window.setInterval(() => {
      setDesign((prev) => randomDesign(prev.pattern));
      setNumber(1 + Math.floor(Math.random() * MAX_NUMBER));
      setSerial((s) => s + 1);
    }, ROTATE_MS);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className="landing-kit" aria-hidden>
      <div className="landing-kit-enter" key={serial}>
        <FootballKit {...design} number={number} />
      </div>
    </div>
  );
}
