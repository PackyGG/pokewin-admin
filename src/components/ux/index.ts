/**
 * ──────────────────────────────────────────────────────────────────────────
 *  UX primitives — centralized loading + motion foundation
 *  pokewin-admin · src/components/ux
 * ──────────────────────────────────────────────────────────────────────────
 *
 * ONE coherent foundation the whole app builds loading states, motion, and
 * layout-stability on. Import everything from `@/components/ux`.
 *
 *   Motion system          → DURATION, EASE_OUT, EASE_STANDARD, transition(),
 *                            pressable(), prefersReducedMotion()
 *   Skeleton atoms         → SkeletonText, SkeletonCard, SkeletonTable,
 *                            SkeletonChart, SkeletonKpiTile, SkeletonKpiStrip,
 *                            SkeletonBoundary
 *   Loading fallbacks      → Spinner, DelayedSpinnerFallback, useDelayedFlag
 *   Overlay laziness       → LazyModalContent
 *   Route pending          → LinkPending, LinkPendingShell
 *   Reveal                 → FadeIn (re-exported from components/fade-in)
 *
 * Design contract for every export here:
 *   - Reduced-motion safe: nothing animates under `prefers-reduced-motion`.
 *   - Dark-mode native: uses theme tokens (bg-card / border / muted), no
 *     hardcoded colors.
 *   - Non-blocking: motion never gates interaction.
 *   - No new deps: Tailwind v4 + base-ui + lucide + the existing base
 *     `<Skeleton>` and globals.css shimmer only.
 *
 * Note: client-only pieces (`spinner`, `lazy-modal-content`, `route-transition`)
 * carry their own `"use client"` directive, so importing them through this
 * barrel from a Server Component is safe — only the client subtree ships to
 * the browser. The motion module, skeleton atoms, and stability wrappers are
 * server-safe and have no client runtime cost.
 */

// Motion system (server-safe)
export * from "./motion";

// Skeleton atoms (server-safe)
export {
  SkeletonBoundary,
  SkeletonText,
  SkeletonCard,
  SkeletonKpiTile,
  SkeletonKpiStrip,
  SkeletonTable,
  SkeletonChart,
} from "./skeleton";

// Reveal (server-safe re-export)
export { FadeIn } from "./fade";

// Loading fallbacks (client)
export {
  Spinner,
  DelayedSpinnerFallback,
  useDelayedFlag,
} from "./spinner";

// Overlay laziness (client)
export { LazyModalContent } from "./lazy-modal-content";

// Route pending treatments (client)
export {
  LinkPending,
  LinkPendingShell,
} from "./route-transition";

// URL-driven chip selectors (client)
export { PeriodChips, TabChips, type ChipItem } from "./period-chips";
