import { memo, useId, useMemo } from "react";
import type { KitDesign } from "./types";
import { darkenColor, formatColor, getLuma } from "./colors";
import { isGradientPattern, needsPatternDef, renderPatternShapes, renderTileDef, safePattern, SHOULDER_LEFT, SHOULDER_RIGHT } from "./patterns";

/**
 * Parametric football-jersey renderer (Kit Lab clone). Pure presentation:
 * props in, SVG out — no state, no fetching — so it can be embedded on any
 * screen at any size (designer preview, thumbnails, badges, topbar).
 *
 * Layer order follows the studied generator:
 *   1. defs (clipPath, shading gradient, optional pattern defs)
 *   2. base body filled with the shell color
 *   3. pattern layer clipped to the body
 *   4. collar + cuff trim in the accent color
 *   5. diagonal shading overlay
 *   6. squad number with a contrast-corrected outline
 */

/** Outfield shirt silhouette in the 200x200 viewBox. */
export const SHIRT_PATH = "M50,40 L150,40 L170,100 L140,110 L140,170 L60,170 L60,110 L30,100 Z";

const STROKE_COLOR = "rgba(0,0,0,0.18)";

export interface FootballKitProps extends Omit<Partial<KitDesign>, "number"> {
  /** Squad number printed on the chest; omit for a plain shirt. */
  number?: number | string | null;
  /** Rendered width/height (CSS length). Defaults to 100%. */
  size?: number | string;
  className?: string;
  /** Disable the drop-shadow filter (useful for tiny inline renders). */
  flat?: boolean;
}

function FootballKitImpl({
  primary = "#ffffff",
  secondary = "#f1f5f9",
  accent = "#e2e8f0",
  numberColor,
  pattern,
  number = null,
  size = "100%",
  className,
  flat = false,
}: FootballKitProps) {
  const rawId = useId().replace(/[:]/g, "");
  const clipId = `kit-clip-${rawId}`;
  const shadingId = `kit-shading-${rawId}`;
  const gradientId = `kit-gradient-${rawId}`;
  const tileId = `kit-tile-${rawId}`;

  // Accept bare hex bodies ("d40000") from stored data by prefixing "#".
  const shell = formatColor(primary, "#ffffff");
  const detail = formatColor(secondary, "#f1f5f9");
  const trim = formatColor(accent, "#e2e8f0");
  const resolvedPattern = safePattern(pattern);

  const innerNeck = useMemo(() => darkenColor(shell, 0.25), [shell]);
  const numberFill = numberColor ? formatColor(numberColor, "#ffffff") : "#ffffff";
  // Outline keeps the number legible over busy patterns; on light shells it is
  // derived from the shell itself, otherwise plain white (studied behavior).
  const numberStroke = getLuma(shell) > 160 ? darkenColor(shell, 0.4) : "#ffffff";

  const tiled = needsPatternDef(resolvedPattern);
  const gradient = isGradientPattern(resolvedPattern);

  return (
    <svg
      viewBox="0 0 200 200"
      width={size}
      height={size}
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label={`Football kit${number != null ? ` for ${number}` : ""}`}
      className={`football-kit${className ? ` ${className}` : ""}`}
      style={{
        overflow: "visible",
        ...(flat ? {} : { filter: "var(--kit-drop-shadow, drop-shadow(0 12px 24px rgba(0,0,0,0.15)))" }),
      }}
    >
      <defs>
        <clipPath id={clipId}>
          <path d={SHIRT_PATH} />
        </clipPath>
        <linearGradient id={shadingId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="white" stopOpacity="0.15" />
          <stop offset="50%" stopColor="black" stopOpacity="0" />
          <stop offset="100%" stopColor="black" stopOpacity="0.25" />
        </linearGradient>
        {(gradient || tiled) && (
          <>
            {gradient && (
              <linearGradient id={gradientId} x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stopColor={resolvedPattern === "top-gradient" ? detail : shell} />
                <stop offset="100%" stopColor={resolvedPattern === "top-gradient" ? shell : detail} />
              </linearGradient>
            )}
            {tiled && renderTileDef(resolvedPattern, tileId, detail, trim)}
          </>
        )}
      </defs>

      {/* Base shell */}
      <path d={SHIRT_PATH} fill={shell} stroke={STROKE_COLOR} strokeWidth="1.5" />

      {/* Pattern layer clipped to the body */}
      <g clipPath={`url(#${clipId})`}>
        {gradient ? (
          <rect x="30" y="40" width="140" height="130" fill={`url(#${gradientId})`} />
        ) : tiled ? (
          <rect x="30" y="40" width="140" height="130" fill={`url(#${tileId})`} />
        ) : (
          renderPatternShapes({ pattern: resolvedPattern, secondary: detail, accent: trim })
        )}
        {/* Mosaic shoulders paint their own tiled fill over both panels */}
        {resolvedPattern === "mosaic-shoulders" && (
          <g fill={`url(#${tileId})`}>
            <path d={SHOULDER_LEFT} />
            <path d={SHOULDER_RIGHT} />
          </g>
        )}
      </g>

      {/* Collar and cuffs */}
      <g clipPath={`url(#${clipId})`}>
        <g fill={trim}>
          <path d="M85,40 Q100,55 115,40 L115,45 Q100,60 85,45 Z" />
          <path d="M30,100 L60,110 L60,102 L30,92 Z" />
          <path d="M170,100 L140,110 L140,102 L170,92 Z" />
        </g>
      </g>
      <path d="M85,40 Q100,55 115,40 Z" fill={innerNeck} />

      {/* Shading overlay */}
      <path d={SHIRT_PATH} fill={`url(#${shadingId})`} pointerEvents="none" />

      {/* Squad number */}
      {number != null && (
        <text
          x="100"
          y="115"
          textAnchor="middle"
          dominantBaseline="central"
          fill={numberFill}
          stroke={numberStroke}
          strokeWidth="3"
          strokeLinejoin="round"
          paintOrder="stroke"
          style={{ fontSize: "52px", fontWeight: 900, fontFamily: "Inter, system-ui, sans-serif", userSelect: "none" }}
        >
          {number}
        </text>
      )}
    </svg>
  );
}

/**
 * Memoized so grids of kit thumbnails (44 patterns) and lists of club badges
 * re-render only when their own colors/pattern change.
 */
export const FootballKit = memo(FootballKitImpl);
