import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Decorative surface ornaments — Packy Liquid Glass v3.
 *
 * Two reusable texture fields implemented from the owner-supplied
 * reference SVGs. Both render as ONE `<svg>` element backed by a
 * `<pattern>` in `<defs>` (never hundreds of inline paths), fill with
 * `currentColor` so a `text-*` utility on the component controls the
 * tint per theme, and fade out via a CSS `mask-image` gradient.
 *
 * Usage rules (binding):
 *   - Purely decorative: always `aria-hidden` + `pointer-events-none`.
 *   - Absolutely positioned inside a `relative overflow-hidden` parent.
 *   - Subtle, never behind dense data — PageHero, auth screens, large
 *     empty states only.
 *   - Tint via className: dark theme = warm champagne (`text-amber-100/…`)
 *     or white at 6–15%; light theme = `text-foreground` / `text-primary`
 *     at 4–8%. The components carry NO default tint so the caller's
 *     theme-aware classes are always explicit.
 *
 * Both components accept a `className` passthrough for size, position,
 * tint and mask overrides. The default fade mask is a Tailwind arbitrary
 * `[mask-image:…]` utility merged BEFORE the caller's className, so a
 * caller can replace the fade direction by passing its own
 * `[mask-image:…]` class (tailwind-merge dedupes same-property
 * arbitrary utilities, caller wins).
 */

/**
 * DiamondGrid — a checkerboard field of tiny 45°-rotated squares on a
 * ~9px pitch that fades out along a diagonal (linear-gradient mask).
 * Reference: white at 20% opacity fading to 0 — expressed here through
 * `currentColor` + the caller's text-opacity class.
 */
export function DiamondGrid({
  className,
  ...props
}: React.SVGProps<SVGSVGElement>) {
  const id = React.useId();
  return (
    <svg
      aria-hidden
      className={cn(
        "pointer-events-none absolute [mask-image:linear-gradient(135deg,black,transparent_75%)]",
        className,
      )}
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <defs>
        <pattern
          id={id}
          width="9"
          height="9"
          patternUnits="userSpaceOnUse"
        >
          {/* One tiny square, rotated 45° around the cell center — tiled
              on the 9px pitch it reads as the reference's diamond
              checkerboard. */}
          <rect
            x="2.75"
            y="2.75"
            width="3.5"
            height="3.5"
            transform="rotate(45 4.5 4.5)"
            fill="currentColor"
          />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill={`url(#${id})`} />
    </svg>
  );
}

/**
 * SparkleField — a grid on a ~16px pitch of tiny 4-point star / plus
 * sparkles fading out radially from a corner (radial-gradient mask).
 * Reference tint: warm champagne (≈ #FFE8CB) at 20% max — use
 * `text-amber-100/20` (dark) / `text-primary/5` (light) on the caller.
 */
export function SparkleField({
  className,
  ...props
}: React.SVGProps<SVGSVGElement>) {
  const id = React.useId();
  return (
    <svg
      aria-hidden
      className={cn(
        "pointer-events-none absolute [mask-image:radial-gradient(closest-side_at_100%_0%,black,transparent)]",
        className,
      )}
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <defs>
        <pattern
          id={id}
          width="16"
          height="16"
          patternUnits="userSpaceOnUse"
        >
          {/* Tiny 4-point sparkle: a concave star centered in the cell.
              Cubic curves pull the edges inward so it reads as a
              star/plus glint rather than a diamond. */}
          <path
            d="M8 5.4 C8.35 6.7 9.3 7.65 10.6 8 C9.3 8.35 8.35 9.3 8 10.6 C7.65 9.3 6.7 8.35 5.4 8 C6.7 7.65 7.65 6.7 8 5.4 Z"
            fill="currentColor"
          />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill={`url(#${id})`} />
    </svg>
  );
}
