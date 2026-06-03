/**
 * ──────────────────────────────────────────────────────────────────────────
 *  UX primitives — centralized loading + motion foundation
 *  pokewin-admin · src/components/ux
 * ──────────────────────────────────────────────────────────────────────────
 *
 * ONE coherent foundation the whole app builds loading states, motion, and
 * layout-stability on. Import everything from `@/components/ux`.
 *
 *   Motion system          → DURATION, EASING, EASE_OUT, transition(), enter(),
 *                            pressable(), transitionStyle(), prefersReducedMotion()
 *   Skeleton atoms         → SkeletonText, SkeletonCard, SkeletonTable,
 *                            SkeletonChart, SkeletonKpiTile, SkeletonKpiStrip,
 *                            SkeletonAvatar, SkeletonBoundary
 *   Loading fallbacks      → Spinner, DelayedSpinnerFallback, DeferredContent,
 *                            useDelayedFlag
 *   Overlay laziness       → LazyModalContent
 *   Layout stability (CLS) → StableCard, StableTable, StableBlock,
 *                            PageReadyBoundary
 *   Route pending          → RouteTransitionShell, LinkPending, LinkPendingShell
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
  SkeletonAvatar,
  SkeletonCard,
  SkeletonKpiTile,
  SkeletonKpiStrip,
  SkeletonTable,
  SkeletonChart,
} from "./skeleton";

// Layout-stability wrappers (server-safe)
export {
  StableCard,
  StableTable,
  StableBlock,
  PageReadyBoundary,
} from "./stable";

// Reveal (server-safe re-export)
export { FadeIn } from "./fade";

// Loading fallbacks (client)
export {
  Spinner,
  DelayedSpinnerFallback,
  DeferredContent,
  useDelayedFlag,
} from "./spinner";

// Overlay laziness (client)
export { LazyModalContent } from "./lazy-modal-content";

// Route pending treatments (client)
export {
  RouteTransitionShell,
  LinkPending,
  LinkPendingShell,
} from "./route-transition";
