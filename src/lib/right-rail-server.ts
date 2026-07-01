import "server-only";
import { cookies } from "next/headers";
import {
  RAIL_COOKIE,
  parseRailOpenOrder,
  type RailKey,
} from "@/lib/right-rail-cookie";

// ---------------------------------------------------------------------------
// Server-side right-rail state resolution.
// ---------------------------------------------------------------------------
//
// Mirrors `readTzCookie` in `src/lib/timezone/server.ts` precisely:
//   • `try/catch` around `cookies()` so non-request contexts (cron,
//     `unstable_cache`, top-level module code) degrade to `null` instead of
//     throwing.
//   • Returns the insertion-ordered list of OPEN dock keys (or `null` when
//     the cookie is absent — the layout then falls back to the provider's
//     default layout for a first-ever visit).
//
// The layout reads this once per render and passes it to `<RightRailProvider>`
// as `initialOpenOrder`, so the provider seeds its state from the admin's
// ACTUAL saved layout. SSR and the first client paint then agree → no
// post-mount open/close flip.
// ---------------------------------------------------------------------------

/**
 * The insertion-ordered list of open dock keys from the `admin_rail` cookie,
 * or `null` when the cookie is absent / unreadable (non-request context /
 * first-ever visit). An empty array means "explicitly nothing open".
 */
export async function readRailOpenOrder(): Promise<RailKey[] | null> {
  try {
    const jar = await cookies();
    const raw = jar.get(RAIL_COOKIE)?.value;
    return parseRailOpenOrder(raw);
  } catch {
    // cookies() only works inside a request scope — background contexts
    // fall through to null (caller uses the default layout).
    return null;
  }
}
