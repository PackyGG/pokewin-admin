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
 * The selectable recent-window options for a windowed wipe, in hours.
 *
 * `null` = "All" — the full-history reset (owner mandate 2026-06-03 — the
 * FloridaManJeff fix). On an "All" wipe the destructive UPDATE sets the
 * relevant lifetime counters (`total_won` for Game; `total_wagered` /
 * `total_won` / `total_deposited` for PnL) DIRECTLY to 0 instead of
 * decrementing by the deleted-row sums — that lets the admin "treat this user
 * as freshly created" even when earlier wipes already removed the source rows
 * (so the deleted-row sum would be 0 and the lifetime counters would not move).
 * 12 / 24 / 48 keep the original BOUNDED windowed behaviour (decrement by
 * actually-deleted row sums) so a heavy account's destructive transaction
 * still stays inside the statement timeout.
 *
 * BACK-COMPAT NOTE: the WAGER wipe already supported `null` via the parallel
 * `WagerWipeWindowHours` type; Game + PnL gained the `null` option in the
 * 2026-06-03 sweep so the three windowed wipes are uniformly resetting for
 * "All".
 */
export type WipeWindowHours = 12 | 24 | 48 | null;

/** The bounded window options offered in the UI (excludes the "All" sentinel). */
export const WIPE_WINDOW_OPTIONS = [12, 24, 48] as const;

/**
 * Validate + normalize an incoming window selection to a `WipeWindowHours`.
 * 12 / 24 / 48 map to themselves, `null` maps to `null` ("All"), everything
 * else falls back to 24h (the default surfaced in the UI) — a server action
 * must NEVER fall back to a silently wider window than the admin picked,
 * EXCEPT for the explicit `null` "All" sentinel which is an opt-in choice.
 */
export function normalizeWipeWindow(v: unknown): WipeWindowHours {
  if (v === 12 || v === 24 || v === 48) return v;
  if (v === null) return null;
  return 24;
}

/**
 * Resolve a window selection to an absolute cutoff `Date` (rows with the
 * relevant timestamp ≥ this are in-window), or `null` for "All" (no lower
 * bound — every row is in scope). The caller computes this ONCE per wipe so
 * the ledger / inventory / upgrader reads + deletes all share the exact same
 * instant (no drift between the snapshot read and the destructive delete).
 */
export function resolveWipeCutoff(hours: WipeWindowHours): Date | null {
  if (hours === null) return null;
  return new Date(Date.now() - hours * 60 * 60 * 1000);
}
