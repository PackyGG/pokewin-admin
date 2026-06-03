/**
 * ──────────────────────────────────────────────────────────────────────────
 *  Entity-surface view helpers  (pokewin-admin · src/components/entity-surface)
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Server-safe (NO "use client" directive) home for the pure `?view=` param
 * vocabulary shared by the /packs + /cards list surfaces:
 *
 *   • EntityView          — the view enum ("table" | "grid").
 *   • resolveEntityView   — pure reader that maps a raw `?view=` string to a
 *                           valid EntityView, defaulting to the dense triage
 *                           TABLE. No React, no hooks, no browser APIs.
 *
 * Why this lives apart from `view-toggle.tsx`: the SERVER components
 * `cards/page.tsx` + `packs/page.tsx` CALL `resolveEntityView()` during server
 * render to pick which primitive to render. `view-toggle.tsx` carries the
 * "use client" directive (it owns the interactive `EntityViewToggle` + its
 * `useUrlParam` hook), so anything exported from it is a CLIENT reference —
 * and Next 15 forbids invoking a client function from the server (builds green,
 * crashes at runtime). Keeping the pure reader in this directive-free module
 * lets the server call it directly while client components import it just the
 * same. `EntityViewToggle` + `ENTITY_VIEW_OPTIONS` stay in `view-toggle.tsx`.
 */

export type EntityView = "table" | "grid";

/**
 * Resolve the active view from a raw `?view=` value, defaulting to `table`
 * (the triage-first default). Exported so the server `page.tsx` can read the
 * same value the toggle writes and render the matching primitive.
 */
export function resolveEntityView(raw: string | undefined | null): EntityView {
  return raw === "grid" ? "grid" : "table";
}
