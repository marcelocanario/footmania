import { safePattern } from "./patterns";
import type { KitDesign } from "./types";

/**
 * Approximate a jersey design as a single CSS background value, for contexts
 * where a full SVG would be unreadable (live-pitch player dots). Pure and
 * synchronous so it can be called per marker without cost.
 */

const VERTICAL = new Set([
  "stripes",
  "broad-stripes",
  "pinstripes",
  "double-stripe",
  "tricolor-stripes",
  "vertical-band",
  "vertical-band-half-and-half",
  "vertical-band-pinstripes",
  "motion-stripes",
]);

const HORIZONTAL = new Set([
  "hoops",
  "broad-hoops",
  "wavy-hoops",
  "chest-band",
  "jagged-chest-band",
  "halftone-stripes",
]);

const DIAGONAL = new Set([
  "sash",
  "diagonal-split",
  "jagged-teeth",
  "zig-zag",
  "chevron",
  "shoulders",
  "mosaic-shoulders",
]);

export function kitDotBackground(kit: Pick<KitDesign, "primary" | "secondary" | "accent" | "pattern">): string {
  const pattern = safePattern(kit.pattern);
  const { primary, secondary } = kit;
  if (VERTICAL.has(pattern)) {
    return `repeating-linear-gradient(90deg, ${primary} 0 5px, ${secondary} 5px 8px)`;
  }
  if (HORIZONTAL.has(pattern)) {
    return `repeating-linear-gradient(0deg, ${primary} 0 5px, ${secondary} 5px 8px)`;
  }
  if (DIAGONAL.has(pattern)) {
    return `linear-gradient(135deg, ${primary} 58%, ${secondary} 58%)`;
  }
  if (pattern === "halves") {
    return `linear-gradient(90deg, ${primary} 50%, ${secondary} 50%)`;
  }
  if (pattern === "quarters") {
    return `conic-gradient(${primary} 0 25%, ${secondary} 25% 50%, ${primary} 50% 75%, ${secondary} 75%)`;
  }
  if (pattern === "checkered") {
    return `conic-gradient(${secondary} 0 25%, ${primary} 25% 50%, ${secondary} 50% 75%, ${primary} 75%)`;
  }
  if (pattern === "gradient" || pattern === "top-gradient") {
    return `linear-gradient(180deg, ${secondary}, ${primary})`;
  }
  return `linear-gradient(145deg, ${primary}, ${secondary})`;
}
