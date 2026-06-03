/**
 * wager-window.ts — the SINGLE client+server-safe source of truth for the
 * Wager / gameplay wipe's recent-WINDOW selector (12h / 24h / 48h / All).
 *
 * Pure constants + pure functions (no DB, no secrets, no env, no "server-only",
 * and CRITICALLY no "use server"). Imported by BOTH the server wipe action
 * (`wipe-wager-actions.ts`) AND the "use client" wipe dialog
 * (`wipe-data-dialog.tsx`) so the offered windows + the cutoff resolution can
 * never drift between the preview UI and the destructive server logic.
 *
 * ─── WHY THIS LIVES IN ITS OWN CLIENT-SAFE MODULE (regression fix) ─────────
 *
 * These constants USED to be exported from `wipe-wager-actions.ts`, which is a
 * `"use server"` module. Next.js transforms EVERY export of a `"use server"`
 * file into a server-action reference on the client — so a `"use client"`
 * component importing the runtime `WAGER_WIPE_WINDOW_OPTIONS` array from it did
 * NOT receive the array `[12, 24, 48]`: it received a `createServerReference`
 * function proxy. Calling `.map(...)` on that proxy at render time threw
 * `TypeError: ... .map is not a function`, which bubbled to the root error
 * boundary and white-screened the whole app the instant the wager wipe section
 * mounted. `next build` does NOT catch this (it compiles fine) — it only
 * surfaces at runtime. `import type { ... }` from a server module is safe
 * (erased at build); importing a runtime VALUE is not. The fix, matching the
 * existing `categories.ts` pattern, is to keep shared runtime constants in a
 * pure module like this one and import them from here in both places.
 */

/**
 * The selectable recent-window options for the wager wipe, in hours. `null`
 * means "All / everything" (no lower time bound — the full-wipe behaviour).
 * A bounded value caps the delete to gameplay whose timestamp is ≥ the cutoff
 * so a heavy account completes inside the statement timeout.
 */
export type WagerWipeWindowHours = 12 | 24 | 48 | null;

/** The bounded window options offered in the UI (excludes the "All" sentinel). */
export const WAGER_WIPE_WINDOW_OPTIONS = [12, 24, 48] as const;

/**
 * Validate + normalize an incoming window selection to a `WagerWipeWindowHours`.
 * Anything that isn't one of the three bounded options is treated as "All"
 * (null) — the safe, explicit default for an unknown value is the unbounded
 * behaviour the action always had, NOT a silent narrower window.
 */
export function normalizeWindowHours(v: unknown): WagerWipeWindowHours {
  if (v === 12 || v === 24 || v === 48) return v;
  return null;
}

/**
 * Resolve a window selection to an absolute cutoff `Date` (rows with the
 * relevant timestamp ≥ this are in-window), or `null` for "All / everything"
 * (no lower bound). The caller computes this ONCE per wipe so the ledger /
 * inventory / upgrader reads + deletes all share the exact same instant (no
 * drift between the snapshot read and the destructive delete).
 */
export function resolveWindowCutoff(hours: WagerWipeWindowHours): Date | null {
  if (hours === null) return null;
  return new Date(Date.now() - hours * 60 * 60 * 1000);
}
