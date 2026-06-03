/**
 * ──────────────────────────────────────────────────────────────────────────
 *  Centralized motion system  (pokewin-admin)
 * ──────────────────────────────────────────────────────────────────────────
 *
 * ONE source of truth for animation timing + easing across the whole app.
 * Every transition / enter / hover treatment in `src/components/ux/*` reads
 * from here so motion feels coherent instead of ad-hoc.
 *
 * Design intent:
 *   - Durations are deliberately short. This is a dense admin panel, not a
 *     marketing page — motion is polish, never a stage effect.
 *   - The signature easing is the "smooth deceleration" curve
 *     cubic-bezier(0.16, 1, 0.3, 1): punchy on entry, calm landing. It is the
 *     same shape used by `AnimatedNumber`'s easeOutCubic, expressed as a bezier
 *     so it can drive CSS transitions too.
 *   - EVERYTHING is reduced-motion aware. The helpers here emit
 *     `motion-safe:` / `motion-reduce:` Tailwind variants so that users with
 *     `prefers-reduced-motion: reduce` land on the final state instantly with
 *     no transform/opacity tweening. We never animate behind the user's back.
 *   - No new deps. Pure data + string helpers. Safe to import from Server or
 *     Client components (no React, no browser APIs at module scope).
 *
 * Pair-with-active rule: any interactive surface that gets a hover treatment
 * must also pair an `:active` (press) treatment so touch / keyboard users get
 * feedback too. `pressable()` below encodes that pairing.
 *
 * Non-blocking rule: motion must never gate interaction. Enter animations use
 * `pointer-events` defaults (transforms/opacity only) and never disable the
 * element. Skeletons are `aria-hidden` shells, not focus traps.
 */

// ─── Durations (ms) ─────────────────────────────────────────────────────────

/**
 * Canonical durations in milliseconds. Use these everywhere a JS-side timing
 * value is needed (requestAnimationFrame ramps, setTimeout fades, the
 * `style.transitionDuration` of an inline transition).
 *
 *   instant  —  0   : reduced-motion / "no animation" sentinel
 *   fast     — 150   : micro feedback (press, toggle, tooltip)
 *   base     — 220   : the default for most enter/hover transitions
 *   slow     — 320   : larger surfaces (panels, route shells, overlays)
 *   slower   — 480   : hero / first-paint reveals only
 */
export const DURATION = {
  instant: 0,
  fast: 150,
  base: 220,
  slow: 320,
  slower: 480,
} as const;

export type DurationToken = keyof typeof DURATION;

// ─── Easing ─────────────────────────────────────────────────────────────────

/**
 * The signature curve — smooth deceleration. Use for nearly all enter / move
 * transitions. Mirrors `AnimatedNumber`'s 1 - (1 - t)^3 feel.
 */
export const EASE_OUT = "cubic-bezier(0.16, 1, 0.3, 1)";

/** Symmetric ease for things that move both in and out (e.g. shimmer sweep). */
export const EASE_IN_OUT = "cubic-bezier(0.65, 0, 0.35, 1)";

/** Standard Material-ish ease for indeterminate progress / linear sweeps. */
export const EASE_STANDARD = "cubic-bezier(0.4, 0, 0.2, 1)";

export const EASING = {
  out: EASE_OUT,
  inOut: EASE_IN_OUT,
  standard: EASE_STANDARD,
} as const;

export type EasingToken = keyof typeof EASING;

// ─── Tailwind duration class map ────────────────────────────────────────────

/**
 * Tailwind arbitrary-value duration utilities keyed by token. Authored as full
 * class strings (not interpolated) so Tailwind's JIT can see and emit them.
 */
const DURATION_CLASS: Record<Exclude<DurationToken, "instant">, string> = {
  fast: "duration-150",
  base: "duration-200",
  slow: "duration-300",
  slower: "duration-500",
};

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Inline-style transition string for a CSS `transition` property, using the
 * centralized duration + easing. For Client components that animate via
 * `style={{ transition }}` (e.g. progress bars, custom drawers).
 *
 *   transition: transitionStyle("transform", "base")
 *   // → "transform 220ms cubic-bezier(0.16, 1, 0.3, 1)"
 *
 * Callers that need reduced-motion safety for inline styles should branch on
 * `prefersReducedMotion()` and pass `"instant"`.
 */
export function transitionStyle(
  property = "all",
  duration: DurationToken = "base",
  easing: EasingToken = "out",
): string {
  return `${property} ${DURATION[duration]}ms ${EASING[easing]}`;
}

/**
 * Reduced-motion-aware Tailwind classes for an *enter* animation. Emits the
 * animation only under `motion-safe:`; reduced-motion users get the final
 * state with zero tweening.
 *
 * Relies on the `tw-animate-css` keyframes already imported in globals.css
 * (`animate-in`, `fade-in`, `zoom-in-*`, `slide-in-from-*`) — no new CSS.
 *
 *   enter("fade")            → soft opacity reveal
 *   enter("scale")           → fade + 95% zoom (cards, tiles, overlays)
 *   enter("slide-up")        → fade + 4px upward slide (default content blocks)
 *   enter("slide-down")      → fade + 4px downward slide (dropdowns / menus)
 */
export function enter(
  kind: "fade" | "scale" | "slide-up" | "slide-down" | "slide-left" = "fade",
  duration: DurationToken = "base",
): string {
  const base = "motion-safe:animate-in motion-safe:fade-in";
  const dur =
    duration === "instant" ? "" : `motion-safe:${DURATION_CLASS[duration]}`;
  const move =
    kind === "scale"
      ? "motion-safe:zoom-in-95"
      : kind === "slide-up"
        ? "motion-safe:slide-in-from-bottom-1"
        : kind === "slide-down"
          ? "motion-safe:slide-in-from-top-1"
          : kind === "slide-left"
            ? "motion-safe:slide-in-from-right-1"
            : "";
  return [base, move, dur].filter(Boolean).join(" ");
}

/**
 * Reduced-motion-aware transition utility classes for state changes driven by
 * Tailwind (hover/focus/data-state color/opacity/transform tweens). Adds the
 * `transition-*` + duration + ease only under `motion-safe:`.
 *
 *   <div className={cn(transition("colors"), "hover:bg-accent")} />
 */
export function transition(
  property: "all" | "colors" | "transform" | "opacity" | "shadow" = "all",
  duration: DurationToken = "base",
): string {
  const prop =
    property === "colors"
      ? "motion-safe:transition-colors"
      : property === "transform"
        ? "motion-safe:transition-transform"
        : property === "opacity"
          ? "motion-safe:transition-opacity"
          : property === "shadow"
            ? "motion-safe:transition-shadow"
            : "motion-safe:transition-all";
  const dur =
    duration === "instant" ? "" : `motion-safe:${DURATION_CLASS[duration]}`;
  return [prop, dur, "motion-safe:ease-out"].filter(Boolean).join(" ");
}

/**
 * Hover treatment *paired with* an active (press) treatment, the way every
 * interactive surface in this app should behave. Hover lifts/brightens; active
 * settles back so the press reads as a physical tap. All motion is
 * `motion-safe:` gated and never disables pointer events.
 *
 *   lift   — translateY(-1px) on hover, back to 0 on active
 *   scale  — 1.01 on hover, 0.985 on active (use sparingly, buttons/tiles)
 *   none   — colors/opacity only (no transform), still pairs hover+active
 */
export function pressable(
  effect: "lift" | "scale" | "none" = "lift",
): string {
  const movement =
    effect === "lift"
      ? "motion-safe:hover:-translate-y-px motion-safe:active:translate-y-0"
      : effect === "scale"
        ? "motion-safe:hover:scale-[1.01] motion-safe:active:scale-[0.985]"
        : "";
  // transform transition so the lift/scale eases; colors handled by callers.
  return [transition("transform", "fast"), movement, "active:transition-none"]
    .filter(Boolean)
    .join(" ");
}

/**
 * Browser check for reduced-motion. Client-only — returns `false` during SSR
 * so server output matches the un-reduced initial client render (the actual
 * preference is then respected by the `motion-safe:`/`motion-reduce:` CSS, or
 * by re-reading this in an effect). Use for imperative JS ramps.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Convenience: the delay (ms) after which a loading spinner/fallback should
 * appear, so fast resolutions never flash a spinner. Used by
 * `DelayedSpinnerFallback` / `DeferredContent`.
 */
export const SPINNER_DELAY_MS = 300;
