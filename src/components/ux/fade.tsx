/**
 * ──────────────────────────────────────────────────────────────────────────
 *  Fade / reveal re-exports  (pokewin-admin · src/components/ux)
 * ──────────────────────────────────────────────────────────────────────────
 *
 * `FadeIn` already exists at `src/components/fade-in.tsx` and is used across
 * the app. Rather than duplicate it, the centralized UX surface re-exports it
 * so everything can be pulled from a single `@/components/ux` barrel. The
 * implementation stays in one place; this is purely an aggregation point.
 *
 * `FadeIn` is reduced-motion aware (it uses `motion-safe:` variants over the
 * `tw-animate-css` keyframes already imported in globals.css) and matches the
 * motion system's "subtle, never a stage effect" intent.
 */
export { FadeIn } from "@/components/fade-in";
