import { unstable_cache } from "next/cache";
import { readDbEnv } from "@/lib/db-env";
import { getUserDetail, getUserHeader } from "./users-detail";
import { getUserPnlBreakdown, type PnlBreakdown } from "./users-financial";
import { computeRiskScore } from "@/lib/fraud/score";
import type { RiskScoreBreakdown } from "@/lib/fraud/score-types";

/**
 * Cross-request cache for the THREE heaviest per-user reads behind
 * /users/[id] — the detail aggregate (~19 Main-DB round-trips + the
 * canonical P&L helper), the Platform-P&L breakdown (multiple ledger
 * aggregates + the 5-window rolling scan), and the fraud/risk score
 * (cross-table aggregate + network/timeline fan-out).
 *
 * Why this exists
 * ───────────────
 * The detail page re-fetches its whole body every 60s (the AutoRefresh
 * tick) AND on every "Try again" press from the segment error boundary.
 * On a DB that lacks the per-user perf indexes these scans are slow, so
 * without a cache layer EVERY refresh / retry re-pays the full scan cost
 * — which is exactly the window in which a query blows past the
 * safeQuery timeout and the band degrades. Caching keyed on the user id
 * means the expensive scan runs at most once per 60s; repeat loads and
 * retries resolve from the warmed entry instantly, so the degrade path
 * is hit far less often and "Try again" actually succeeds.
 *
 * The numbers are UNCHANGED — this only memoizes the existing query
 * results. Same pattern as `cachedUsersListStats` in users-list.ts.
 *
 * DB-env correctness (prod-only cache)
 * ────────────────────────────────────
 * `getUserDetail` / `getUserPnlBreakdown` / `computeRiskScore` each call
 * `getDb()` internally, which resolves the per-admin `admin_db_env`
 * cookie. `unstable_cache` runs its callback OUTSIDE the request's
 * dynamic scope, so a `cookies()` read inside it throws and `readDbEnv`
 * falls back to "prod" — the cached callback therefore always queries the
 * PROD client. To avoid serving prod data to a dev-toggled admin we cache
 * ONLY when the request is on prod (the default, and the path the
 * production "fails all the time" bug is about). A dev-toggled admin
 * bypasses the cache and runs the query directly so they always see live
 * dev data. The dev toggle is a rare debugging affordance, so the missing
 * cache layer there is acceptable.
 */

const REVALIDATE_SECONDS = 60;

// `unstable_cache` also de-duplicates within a single render, so if two
// code paths request the same user's detail in one pass they share the
// single underlying query. The cached callbacks always run against prod
// (see module doc), so the cache key needs no env dimension.

const cachedUserDetail = unstable_cache(
  (userId: string) => getUserDetail(userId),
  ["users-detail-aggregate-v1"],
  { revalidate: REVALIDATE_SECONDS, tags: ["users-detail"] },
);

// Keypart bumped v1 → v2 (2026-06-03) to FORCE-DISCARD the pre-fix cached
// rolling-P&L values across the deploy. The wipe-aware rolling-P&L correction
// (commit c836684) changed the numbers `getUserPnlBreakdown` returns for any
// user with recent admin wipes, but the Vercel data cache persists `unstable_cache`
// entries ACROSS deployments (the key is the static keyParts + a closure hash,
// not the deployment id). So the old code's value (e.g. FloridaManJeff's phantom
// −$20,794 24h tile) kept being served stale-while-revalidate under the v1 key
// after the corrected code shipped. A new keypart is a fresh cache namespace
// with no pre-fix entry, so the corrected value computes on the first post-deploy
// load — same force-invalidate-on-code-change pattern used in cards.ts (v2→v3).
const cachedUserPnlBreakdown = unstable_cache(
  (userId: string): Promise<PnlBreakdown> => getUserPnlBreakdown(userId),
  ["users-detail-pnl-v2"],
  { revalidate: REVALIDATE_SECONDS, tags: ["users-detail"] },
);

const cachedRiskScore = unstable_cache(
  (userId: string): Promise<RiskScoreBreakdown> => computeRiskScore(userId),
  ["users-detail-risk-v1"],
  { revalidate: REVALIDATE_SECONDS, tags: ["users-detail"] },
);

/** Cached `getUserDetail` on prod; direct (uncached) on a dev-toggled
 * admin so they see live dev data — see module doc. */
export async function getUserDetailCached(
  userId: string,
): Promise<Awaited<ReturnType<typeof getUserDetail>>> {
  const env = await readDbEnv();
  if (env !== "prod") return getUserDetail(userId);
  return cachedUserDetail(userId);
}

/** Cached `getUserPnlBreakdown` on prod; direct on dev — see module doc. */
export async function getUserPnlBreakdownCached(
  userId: string,
): Promise<PnlBreakdown> {
  const env = await readDbEnv();
  if (env !== "prod") return getUserPnlBreakdown(userId);
  return cachedUserPnlBreakdown(userId);
}

/** Cached `computeRiskScore` on prod; direct on dev — see module doc.
 * Layered on top of the score module's own 60s in-process memo: this
 * adds the cross-request Next data-cache layer so a fresh function
 * instance (cold start) or a second concurrent request still avoids
 * re-running the scan. */
export async function getRiskScoreCached(
  userId: string,
): Promise<RiskScoreBreakdown> {
  const env = await readDbEnv();
  if (env !== "prod") return computeRiskScore(userId);
  return cachedRiskScore(userId);
}

/**
 * Slim header read with a SHORT wall-clock bound for the critical path.
 *
 * `getUserHeader` is two indexed identity reads, normally sub-millisecond
 * — but it runs UN-streamed on the page's critical path (the page can't
 * render the back-link header or 404-decide without it). If the Postgres
 * pool is momentarily starved (a couple of runaway per-user scans pinning
 * the `max: 5` slots — the exact failure `db.ts` documents), even this
 * cheap read can block long enough that the platform tears the request
 * down, and the WHOLE page hits the segment error boundary
 * ("Couldn't load this user", digest 497656675).
 *
 * Returns:
 *   - `{ found: true, header }`            — user exists (header may be the
 *                                            real row, or a minimal id-only
 *                                            placeholder if the read timed
 *                                            out / failed),
 *   - `{ found: false }`                   — definitively no such user (only
 *                                            returned on a clean null), so
 *                                            the caller 404s.
 *
 * On timeout/failure we DEGRADE rather than 404: we can't prove the user
 * is missing, so we render the shell with an id-only header and let the
 * streamed body load the real identity. This guarantees a slow identity
 * read can never take the page down — matching the "load till it's
 * possible" requirement.
 */
const HEADER_TIMEOUT_MS = 4_000;

export type CriticalHeaderResult =
  | {
      found: true;
      degraded: boolean;
      header: { id: string; username: string | null; email: string | null };
    }
  | { found: false };

export async function getUserHeaderCritical(
  id: string,
): Promise<CriticalHeaderResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("getUserHeader exceeded critical-path budget")),
      HEADER_TIMEOUT_MS,
    );
  });
  try {
    const header = await Promise.race([getUserHeader(id), timeout]);
    if (!header) return { found: false };
    return { found: true, degraded: false, header };
  } catch (err) {
    // Slow or failed identity read. We can NOT conclude the user is
    // missing — degrade to an id-only header so the shell still renders
    // and the streamed body (its own timeout-wrapped getUserDetail) fills
    // in the real identity. Logged so the slow read is visible upstream.
    console.error(
      "[users/[id]] critical-path getUserHeader degraded:",
      err instanceof Error ? err.message : err,
    );
    return {
      found: true,
      degraded: true,
      header: { id, username: null, email: null },
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
