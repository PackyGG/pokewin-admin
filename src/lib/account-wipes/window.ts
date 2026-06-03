/**
 * window.ts — the SINGLE client+server-safe source of truth for the
 * windowed wipes' recent-WINDOW selector (12h / 24h / 48h).
 *
 * Pure constants + pure functions (no DB, no secrets, no env, no "server-only",
 * and CRITICALLY no "use server"). Imported by BOTH the server wipe actions
 * (`wipe-wager-actions.ts` / `wipe-game-actions.ts` / `wipe-pnl-actions.ts`)
 * AND the "use client" wipe dialog (`wipe-data-dialog.tsx`) so the offered
 * windows + the cutoff resolution can never drift between the preview UI and
 * the destructive server logic.
 *
 * ─── WHY THIS LIVES IN ITS OWN CLIENT-SAFE MODULE (regression fix) ─────────
 *
 * Next.js transforms EVERY export of a `"use server"` file into a server-action
 * reference on the client — so a `"use client"` component importing a runtime
 * value from there receives a `createServerReference` function proxy, NOT the
 * real array/const. Calling `.map(...)` on that proxy at render time throws
 * `TypeError: ... .map is not a function`, bubbles to the root error boundary
 * and white-screens the app the instant the wipe section mounts. `next build`
 * does NOT catch this (it compiles fine) — it only surfaces at runtime.
 * `import type { ... }` from a server module is safe (erased at build);
 * importing a runtime VALUE is not. The fix, matching the existing
 * `categories.ts` pattern, is to keep shared runtime constants in a pure
 * module like this one and import them from here in both places.
 *
 * ─── DESIGN: ONE SHARED WINDOW TYPE FOR ALL THREE WINDOWED WIPES ───────────
 *
 * The PnL / Game / Wager windowed wipes all offer the SAME three bounded
 * options (12h / 24h / 48h) — each is independently selectable per wipe but
 * the offered set + cutoff resolution is identical, so they share this single
 * helper module instead of three near-duplicate files. The original
 * `wager-window.ts` re-exports from here for full back-compat.
 */

/**
 * The selectable recent-window options for a windowed wipe, in hours. Always
 * BOUNDED — every windowed wipe (pnl/game/wager) requires a non-null window so
 * a heavy account's destructive transaction stays inside the statement
 * timeout. The PnL wipe is large enough that an unbounded "All" run can never
 * be made safe inside one transaction; the Game and Wager wipes inherit the
 * same constraint to keep the three flows uniform.
 */
export type WipeWindowHours = 12 | 24 | 48;

/** The bounded window options offered in the UI. */
export const WIPE_WINDOW_OPTIONS = [12, 24, 48] as const;

/**
 * Validate + normalize an incoming window selection to a `WipeWindowHours`.
 * Anything that isn't one of the three bounded options is treated as 24h (the
 * default surfaced in the UI) — a server action must NEVER fall back to a
 * silently wider window than the admin picked.
 */
export function normalizeWipeWindow(v: unknown): WipeWindowHours {
  if (v === 12 || v === 24 || v === 48) return v;
  return 24;
}

/**
 * Resolve a window selection to an absolute cutoff `Date` (rows with the
 * relevant timestamp ≥ this are in-window). The caller computes this ONCE per
 * wipe so the ledger / inventory / upgrader reads + deletes all share the
 * exact same instant (no drift between the snapshot read and the destructive
 * delete).
 */
export function resolveWipeCutoff(hours: WipeWindowHours): Date {
  return new Date(Date.now() - hours * 60 * 60 * 1000);
}
