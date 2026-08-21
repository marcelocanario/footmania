import type { ReactNode } from "react";

/**
 * Pattern registry for the kit renderer. Geometry ported from the studied
 * Kit Lab generator (league-builder.app/kit-lab). The jersey body lives in a
 * 200x200 viewBox; patterns draw inside the body bounds (x 30..170, y 40..170)
 * and are clipped to the shirt silhouette by the renderer.
 *
 * Two families:
 *  - "simple" patterns are drawn directly as shapes inside the clipped group;
 *  - "tiled" patterns define an SVG <pattern> and paint one full-body rect
 *    with it; "gradient" patterns use a linearGradient instead.
 */

export interface KitPatternDef {
  id: string;
  label: string;
}

/** Ordered catalog, matching the studied designer's grid order. */
export const KIT_PATTERNS: KitPatternDef[] = [
  { id: "solid", label: "Solid" },
  { id: "stripes", label: "Stripes" },
  { id: "broad-stripes", label: "Broad stripes" },
  { id: "pinstripes", label: "Pinstripes" },
  { id: "tricolor-stripes", label: "Tricolor stripes" },
  { id: "vertical-band", label: "Vertical band" },
  { id: "vertical-band-half-and-half", label: "Vertical band half-and-half" },
  { id: "vertical-band-pinstripes", label: "Vertical band pinstripes" },
  { id: "double-stripe", label: "Double stripe" },
  { id: "hoops", label: "Hoops" },
  { id: "broad-hoops", label: "Broad hoops" },
  { id: "chest-band", label: "Chest band" },
  { id: "halves", label: "Halves" },
  { id: "quarters", label: "Quarters" },
  { id: "sash", label: "Sash" },
  { id: "checkered", label: "Checkered" },
  { id: "herringbone", label: "Herringbone" },
  { id: "pattern-grid", label: "Pattern grid" },
  { id: "top-gradient", label: "Top gradient" },
  { id: "zig-zag", label: "Zig zag" },
  { id: "chevron", label: "Chevron" },
  { id: "hexagonal", label: "Hexagonal" },
  { id: "geometric", label: "Geometric" },
  { id: "grid", label: "Grid" },
  { id: "abstract", label: "Abstract" },
  { id: "gradient", label: "Gradient" },
  { id: "graphics", label: "Graphics" },
  { id: "sunburst", label: "Sunburst" },
  { id: "wavy-hoops", label: "Wavy hoops" },
  { id: "jagged-chest-band", label: "Jagged chest band" },
  { id: "jagged-teeth", label: "Jagged teeth" },
  { id: "motion-stripes", label: "Motion stripes" },
  { id: "halftone-stripes", label: "Halftone stripes" },
  { id: "blurred-stripes", label: "Blurred stripes" },
  { id: "plus-grid", label: "Plus grid" },
  { id: "diagonal-split", label: "Diagonal split" },
  { id: "mosaic-shoulders", label: "Mosaic shoulders" },
  { id: "distressed-stripes", label: "Distressed stripes" },
  { id: "city-map", label: "City map" },
  { id: "water-ripple", label: "Water ripple" },
  { id: "digital-camo", label: "Digital camo" },
  { id: "eiffel-graphic", label: "Eiffel graphic" },
  { id: "shoulders", label: "Shoulders" },
  { id: "cross", label: "Cross" },
];

const PATTERN_IDS = new Set(KIT_PATTERNS.map((p) => p.id));

/** Resolve an arbitrary stored id to a safe pattern id. */
export function safePattern(id: string | undefined | null): string {
  return id && PATTERN_IDS.has(id) ? id : "solid";
}

/** Shoulder panels shared by "shoulders" and "mosaic-shoulders". */
export const SHOULDER_LEFT = "M30,100 L50,40 L85,40 Q48,75 60,110 Z";
export const SHOULDER_RIGHT = "M170,100 L150,40 L115,40 Q152,75 140,110 Z";

const GRADIENT_PATTERNS = new Set(["gradient", "top-gradient"]);

/** Patterns painted via a linearGradient instead of shapes/tiles. */
export function isGradientPattern(pattern: string): boolean {
  return GRADIENT_PATTERNS.has(pattern);
}

/** Patterns that require an SVG <pattern> definition with the given id. */
export function needsPatternDef(pattern: string): boolean {
  if (isGradientPattern(pattern)) return false;
  switch (pattern) {
    case "solid":
    case "stripes":
    case "broad-stripes":
    case "double-stripe":
    case "pinstripes":
    case "tricolor-stripes":
    case "hoops":
    case "broad-hoops":
    case "halves":
    case "quarters":
    case "sash":
    case "chest-band":
    case "vertical-band":
    case "vertical-band-half-and-half":
    case "vertical-band-pinstripes":
    case "diagonal-split":
    case "shoulders":
    case "jagged-chest-band":
    case "jagged-teeth":
      return false;
    default:
      // Everything else (checkered, herringbone, sunburst, camo, ...) is tiled.
      return true;
  }
}

interface ShapeProps {
  pattern: string;
  secondary: string;
  accent: string;
}

/**
 * Direct shape rendering for simple patterns. Returns null when the pattern
 * is tiled/gradient/solid so the renderer falls back to the full-body fill.
 */
export function renderPatternShapes({ pattern, secondary, accent }: ShapeProps): ReactNode {
  switch (pattern) {
    case "stripes":
      return [65, 95, 125].map((x) => <rect key={x} x={x} y="40" width="15" height="130" fill={secondary} />);
    case "broad-stripes":
      return (
        <>
          <rect x="62" y="40" width="28" height="130" fill={secondary} />
          <rect x="110" y="40" width="28" height="130" fill={secondary} />
        </>
      );
    case "double-stripe":
      return (
        <>
          <rect x="62" y="40" width="28" height="130" fill={secondary} />
          <rect x="110" y="40" width="28" height="130" fill={secondary} />
          <rect x="60" y="40" width="2" height="130" fill={accent} />
          <rect x="90" y="40" width="2" height="130" fill={accent} />
          <rect x="108" y="40" width="2" height="130" fill={accent} />
          <rect x="138" y="40" width="2" height="130" fill={accent} />
        </>
      );
    case "pinstripes":
      return [70, 85, 100, 115, 130].map((x) => <rect key={x} x={x} y="40" width="2" height="130" fill={secondary} />);
    case "tricolor-stripes":
      return (
        <>
          <rect x="52" y="40" width="16" height="130" fill={secondary} />
          <rect x="84" y="40" width="16" height="130" fill={accent} />
          <rect x="116" y="40" width="16" height="130" fill={secondary} />
          <rect x="148" y="40" width="16" height="130" fill={accent} />
        </>
      );
    case "hoops":
      return [65, 95, 125].map((y) => <rect key={y} x="30" y={y} width="140" height="15" fill={secondary} />);
    case "broad-hoops":
      return (
        <>
          <rect x="30" y="72" width="140" height="32" fill={secondary} />
          <rect x="30" y="136" width="140" height="32" fill={secondary} />
        </>
      );
    case "halves":
      return <rect x="100" y="40" width="70" height="130" fill={secondary} />;
    case "quarters":
      return (
        <>
          <rect x="100" y="40" width="70" height="65" fill={secondary} />
          <rect x="30" y="105" width="70" height="65" fill={secondary} />
        </>
      );
    case "sash":
      return <path d="M50,40 L75,40 L170,145 L170,170 Z" fill={secondary} />;
    case "chest-band":
      return (
        <>
          <rect x="30" y="70" width="140" height="12" fill={secondary} />
          <rect x="30" y="82" width="140" height="12" fill={accent} />
        </>
      );
    case "vertical-band":
      return <rect x="80" y="40" width="40" height="130" fill={secondary} />;
    case "vertical-band-half-and-half":
      return (
        <>
          <rect x="80" y="40" width="20" height="130" fill={secondary} />
          <rect x="100" y="40" width="20" height="130" fill={accent} />
        </>
      );
    case "vertical-band-pinstripes":
      return [85, 95, 105, 115].map((x) => <rect key={x} x={x} y="40" width="2" height="130" fill={secondary} />);
    case "diagonal-split":
      return <path d="M30,40 L170,40 L170,170 Z" fill={secondary} />;
    case "shoulders":
      return (
        <g fill={secondary}>
          <path d={SHOULDER_LEFT} />
          <path d={SHOULDER_RIGHT} />
        </g>
      );
    case "jagged-chest-band":
      return (
        <path
          d="M30,70 L40,65 L50,70 L60,65 L70,70 L80,65 L90,70 L100,65 L110,70 L120,65 L130,70 L140,65 L150,70 L160,65 L170,70 L170,90 L160,95 L150,90 L140,95 L130,90 L120,95 L110,90 L100,95 L90,90 L80,95 L70,90 L60,95 L50,90 L40,95 L30,90 Z"
          fill={secondary}
        />
      );
    case "jagged-teeth":
      return (
        <>
          <path d="M30,40 L30,90 L45,105 L60,90 L75,105 L90,90 L105,105 L120,90 L135,105 L150,90 L165,105 L170,105 L170,40 Z" fill={secondary} />
          <path d="M30,40 L30,85 L45,100 L60,85 L75,100 L90,85 L105,100 L120,85 L135,100 L150,85 L165,100 L170,100 L170,40 Z" fill={accent} opacity="0.5" />
        </>
      );
    default:
      return null;
  }
}

// --- Tiled pattern definitions ---------------------------------------------
//
// Each function receives the per-instance pattern id plus colors and returns
// one <pattern> element. `pattern` names which tile to build; the id is used
// as the def's id so the full-body rect can reference url(#id).

type TileFn = (args: { id: string; secondary: string; accent: string }) => ReactNode;

const zigZagTile: TileFn = ({ id, secondary }) => (
  <pattern key={id} id={id} patternUnits="userSpaceOnUse" width="30" height="20">
    <path d="M0,10 L7.5,0 L22.5,20 L30,10" fill="none" stroke={secondary} strokeWidth="3" />
  </pattern>
);

const checkeredTile: TileFn = ({ id, secondary }) => (
  <pattern key={id} id={id} patternUnits="userSpaceOnUse" width="40" height="40">
    <rect x="0" y="0" width="20" height="20" fill={secondary} />
    <rect x="20" y="20" width="20" height="20" fill={secondary} />
  </pattern>
);

const hexagonalTile: TileFn = ({ id, secondary }) => (
  <pattern key={id} id={id} patternUnits="userSpaceOnUse" width="20" height="34.6" patternTransform="scale(0.8)">
    <path d="M10,0 L20,5.8 L20,17.3 L10,23.1 L0,17.3 L0,5.8 Z" fill="none" stroke={secondary} strokeWidth="1" opacity="0.6" />
  </pattern>
);

const geometricTile: TileFn = ({ id, secondary }) => (
  <pattern key={id} id={id} patternUnits="userSpaceOnUse" width="40" height="40">
    <path d="M20,0 L40,20 L20,40 L0,20 Z" fill="none" stroke={secondary} strokeWidth="1.5" />
    <path d="M0,0 L40,40 M40,0 L0,40" stroke={secondary} strokeWidth="0.5" opacity="0.5" />
  </pattern>
);

const chevronTile: TileFn = ({ id, secondary }) => (
  <pattern key={id} id={id} patternUnits="userSpaceOnUse" width="100" height="40">
    <path d="M0,10 L50,30 L100,10" fill="none" stroke={secondary} strokeWidth="6" />
  </pattern>
);

const crossTile: TileFn = ({ id, secondary }) => (
  <pattern key={id} id={id} patternUnits="userSpaceOnUse" width="200" height="200">
    <rect x="85" y="0" width="30" height="200" fill={secondary} />
    <rect x="0" y="70" width="200" height="30" fill={secondary} />
  </pattern>
);

const gridTile: TileFn = ({ id, secondary }) => (
  <pattern key={id} id={id} patternUnits="userSpaceOnUse" width="25" height="25">
    <path d="M 25 0 L 0 0 0 25" fill="none" stroke={secondary} strokeWidth="1.5" opacity="0.8" />
  </pattern>
);

const herringboneTile: TileFn = ({ id, secondary }) => (
  <pattern key={id} id={id} patternUnits="userSpaceOnUse" width="20" height="20">
    <path d="M0,10 L10,0 M10,20 L20,10" stroke={secondary} strokeWidth="2" />
    <path d="M0,0 L10,10 M10,10 L20,20" stroke={secondary} strokeWidth="1" opacity="0.5" />
  </pattern>
);

const patternGridTile: TileFn = ({ id, secondary }) => (
  <pattern key={id} id={id} patternUnits="userSpaceOnUse" width="30" height="30">
    <rect width="30" height="30" fill="none" stroke={secondary} strokeWidth="0.5" />
    <circle cx="15" cy="15" r="3" fill={secondary} opacity="0.3" />
  </pattern>
);

const plusGridTile: TileFn = ({ id, secondary }) => (
  <pattern key={id} id={id} patternUnits="userSpaceOnUse" width="25" height="25">
    <path d="M12.5,5 L12.5,20 M5,12.5 L20,12.5" stroke={secondary} strokeWidth="2" opacity="0.6" />
  </pattern>
);

const mosaicShouldersTile: TileFn = ({ id, secondary }) => (
  <pattern key={id} id={id} patternUnits="userSpaceOnUse" width="20" height="20" patternTransform="rotate(45)">
    <rect width="10" height="10" fill={secondary} />
    <rect x="10" y="10" width="10" height="10" fill={secondary} />
  </pattern>
);

const graphicsTile: TileFn = ({ id, secondary, accent }) => (
  <pattern key={id} id={id} patternUnits="userSpaceOnUse" width="60" height="60" patternTransform="rotate(45)">
    <rect width="60" height="60" fill="none" />
    <path d="M0,30 Q15,0 30,30 T60,30" stroke={secondary} strokeWidth="2" fill="none" opacity="0.4" />
    <path d="M0,45 Q15,15 30,45 T60,45" stroke={accent} strokeWidth="1" fill="none" opacity="0.2" />
  </pattern>
);

const abstractTile: TileFn = ({ id, secondary, accent }) => (
  <pattern key={id} id={id} patternUnits="userSpaceOnUse" width="80" height="80" patternTransform="rotate(15)">
    <path d="M10,10 L30,5 L45,25 L20,40 Z" fill={secondary} opacity="0.3" />
    <path d="M50,40 L70,35 L65,60 L40,70 Z" fill={accent} opacity="0.25" />
    <circle cx="40" cy="15" r="2" fill={accent} opacity="0.3" />
  </pattern>
);

const cityMapTile: TileFn = ({ id, secondary, accent }) => (
  <pattern key={id} id={id} patternUnits="userSpaceOnUse" width="100" height="100">
    <path d="M0,20 L100,20 M20,0 L20,100 M0,50 L40,50 L40,100 M60,0 L60,40 L100,40" stroke={secondary} strokeWidth="0.5" opacity="0.3" fill="none" />
    <path d="M10,10 Q30,40 50,10 T90,10" stroke={accent} strokeWidth="0.3" opacity="0.2" fill="none" />
  </pattern>
);

const waterRippleTile: TileFn = ({ id, secondary, accent }) => (
  <pattern key={id} id={id} patternUnits="userSpaceOnUse" width="60" height="40">
    <path d="M0,10 Q15,0 30,10 T60,10 M0,30 Q15,20 30,30 T60,30" stroke={secondary} strokeWidth="2" opacity="0.4" fill="none" />
    <path d="M0,20 Q15,10 30,20 T60,20" stroke={accent} strokeWidth="1" opacity="0.2" fill="none" />
  </pattern>
);

const digitalCamoTile: TileFn = ({ id, secondary, accent }) => (
  <pattern key={id} id={id} patternUnits="userSpaceOnUse" width="40" height="40">
    <rect x="0" y="0" width="10" height="10" fill={secondary} opacity="0.6" />
    <rect x="20" y="10" width="10" height="10" fill={secondary} opacity="0.4" />
    <rect x="10" y="20" width="10" height="10" fill={accent} opacity="0.3" />
    <rect x="30" y="30" width="10" height="10" fill={accent} opacity="0.5" />
  </pattern>
);

const eiffelGraphicTile: TileFn = ({ id, secondary }) => (
  <pattern key={id} id={id} patternUnits="userSpaceOnUse" width="100" height="130">
    <path d="M40,130 L50,40 L60,130 M45,90 L55,90 M48,60 L52,60" stroke={secondary} strokeWidth="2" fill="none" opacity="0.5" />
  </pattern>
);

const sunburstTile: TileFn = ({ id, secondary }) => (
  <pattern key={id} id={id} patternUnits="userSpaceOnUse" width="200" height="200" x="-100" y="-100">
    {[0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330].map((deg) => {
      const x1 = (100 + 150 * Math.cos((deg * Math.PI) / 180)).toFixed(4);
      const y1 = (100 + 150 * Math.sin((deg * Math.PI) / 180)).toFixed(4);
      const x2 = (100 + 150 * Math.cos(((deg + 15) * Math.PI) / 180)).toFixed(4);
      const y2 = (100 + 150 * Math.sin(((deg + 15) * Math.PI) / 180)).toFixed(4);
      return <path key={deg} d={`M100,100 L${x1},${y1} L${x2},${y2} Z`} fill={secondary} opacity="0.4" />;
    })}
  </pattern>
);

const wavyHoopsTile: TileFn = ({ id, secondary }) => (
  <pattern key={id} id={id} patternUnits="userSpaceOnUse" width="100" height="30">
    <path d="M0,15 Q25,0 50,15 T100,15" fill="none" stroke={secondary} strokeWidth="8" />
  </pattern>
);

const halftoneStripesTile: TileFn = ({ id, secondary, accent }) => (
  <pattern key={id} id={id} patternUnits="userSpaceOnUse" width="40" height="40">
    <rect x="0" y="0" width="10" height="40" fill={secondary} />
    <circle cx="5" cy="5" r="1.5" fill={accent} />
    <circle cx="5" cy="15" r="1.5" fill={accent} />
    <circle cx="5" cy="25" r="1.5" fill={accent} />
    <circle cx="5" cy="35" r="1.5" fill={accent} />
  </pattern>
);

const motionStripesTile: TileFn = ({ id, secondary }) => (
  <pattern key={id} id={id} patternUnits="userSpaceOnUse" width="30" height="100">
    <rect x="14" y="0" width="2" height="100" fill={secondary} opacity="0.8" />
    <rect x="13" y="0" width="1" height="100" fill={secondary} opacity="0.3" />
    <rect x="16" y="0" width="1" height="100" fill={secondary} opacity="0.3" />
  </pattern>
);

const blurredStripesTile: TileFn = ({ id, secondary }) => (
  <pattern key={id} id={id} patternUnits="userSpaceOnUse" width="60" height="20">
    <rect x="20" y="0" width="20" height="20" fill={secondary} opacity="0.4" />
    <rect x="15" y="0" width="30" height="20" fill={secondary} opacity="0.15" />
  </pattern>
);

const distressedStripesTile: TileFn = ({ id, secondary, accent }) => (
  <pattern key={id} id={id} patternUnits="userSpaceOnUse" width="40" height="100">
    <path d="M5,0 L8,30 L6,70 L9,100 M15,0 L12,40 L16,80 L13,100 M25,0 L28,20 L24,60 L27,100" stroke={secondary} strokeWidth="3" fill="none" opacity="0.6" />
    <path d="M35,0 L32,50 L36,100" stroke={accent} strokeWidth="1" fill="none" opacity="0.3" />
  </pattern>
);

const TILED_TILES: Record<string, TileFn> = {
  "zig-zag": zigZagTile,
  checkered: checkeredTile,
  hexagonal: hexagonalTile,
  geometric: geometricTile,
  chevron: chevronTile,
  grid: gridTile,
  herringbone: herringboneTile,
  "pattern-grid": patternGridTile,
  "plus-grid": plusGridTile,
  cross: crossTile,
  "mosaic-shoulders": mosaicShouldersTile,
  graphics: graphicsTile,
  abstract: abstractTile,
  "city-map": cityMapTile,
  "water-ripple": waterRippleTile,
  "digital-camo": digitalCamoTile,
  "eiffel-graphic": eiffelGraphicTile,
  sunburst: sunburstTile,
  "wavy-hoops": wavyHoopsTile,
  "halftone-stripes": halftoneStripesTile,
  "motion-stripes": motionStripesTile,
  "blurred-stripes": blurredStripesTile,
  "distressed-stripes": distressedStripesTile,
};

/**
 * Render the <pattern> def for a tiled pattern, or null when the pattern is
 * not tiled. `pattern` selects the tile geometry; `defId` is unique per
 * jersey instance so multiple kits on one page never share a def id.
 */
export function renderTileDef(pattern: string, defId: string, secondary: string, accent: string): ReactNode {
  const tile = TILED_TILES[pattern];
  if (!tile) return null;
  return tile({ id: defId, secondary, accent });
}
