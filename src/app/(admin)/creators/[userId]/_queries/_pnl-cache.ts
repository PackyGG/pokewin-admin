import "server-only";

import { cache } from "react";
import { unstable_cache } from "next/cache";

import { getCreatorPnl } from "@/lib/queries/creators-pnl";
import { readDbEnv } from "@/lib/db-env";
import type { CreatorPnlData } from "@/lib/queries/creators-types";

/**
 * Cross-request cache for the per-creator Affiliates P&L scan
 * (`getCreatorPnl`) behind /creators/[userId].
 *
 * ─── WHY THIS EXISTS ─────────────────────────────────────────────────
 *
 * `getCreatorPnl` is the heaviest read on the creator detail page — the
 * coverage-attributed cohort reconstruction (deposits − card-withdrawals)
 * over a 30-day window block + a 365-day lifetime block. It is also fetched
 * TWICE per render: once by `CreatorPnlPanel` (the Affiliates P&L boxes) and
 * once by `CreatorDealCostPanel` (the "Creator Net" block reuses the same
 * lifetime figure so the two reconcile). Without a cache layer EVERY render
 * — including every press of the page's "Refresh to retry" banner after a
 * different heavy panel timed out — re-pays the full scan, and on a prod DB
 * lacking the supporting acu index that scan is exactly what blows past the
 * safeQuery timeout and degrades the panel.
 *
 * `unstable_cache` keyed on the creator id means the scan runs at most once
 * per TTL; the two in-render consumers de-duplicate onto the single
 * underlying query, and repeat loads / retries resolve from the warmed entry
 * instantly. The numbers are UNCHANGED — this only memoizes the existing
 * query result. Same precedent as `users-detail-cache.ts` and the sibling
 * creator-cost caches (`_cost-cache.ts`).
 *
 * ─── COLD-RUN COMPLETION (why caching ALONE isn't enough) ────────────
 *
 * Caching only helps once the cache is warm. If the COLD scan never
 * finishes within the timeout, the cache never populates and the panel
 * stays timed-out forever. `getCreatorPnl` therefore runs its scans inside
 * a transaction with a raised per-statement timeout (55s via `SET LOCAL`,
 * see creators-pnl.ts) so the populating run completes; this TTL is sized so
 * that one populating run serves many subsequent loads. A slow FIRST load
 * that then caches is acceptable; "always times out" is not.
 *
 * ─── ENV NOTE (prod-pinned, matches the repo pattern) ────────────────
 *
 * `getCreatorPnl` resolves the database internally from the per-admin
 * `admin_db_env` cookie. `unstable_cache` runs its callback OUTSIDE the
 * request's dynamic scope, so a `cookies()` read inside it throws and
 * `readDbEnv` falls back to "prod". We therefore cache ONLY when the request
 * is on prod (the default, and the path the production "times out" bug is
 * about); a dev-toggled admin bypasses the cache and runs the query directly
 * so they always see live dev data. Identical to `users-detail-cache.ts`.
 */

// 5 minutes. The lifetime block (365d) dominates the cost and is stable
// minute-to-minute, so a longer TTL than the 180s cost caches is safe here
// while still surfacing a newly-recorded deposit / withdrawal promptly.
const REVALIDATE_SECONDS = 300;

const cachedCreatorPnl = unstable_cache(
  (userId: string): Promise<CreatorPnlData> => getCreatorPnl(userId),
  ["creators-detail-pnl-v2-refunds"],
  { revalidate: REVALIDATE_SECONDS, tags: ["creators-detail-pnl"] },
);

/** Cached `getCreatorPnl` on prod; direct (uncached) on a dev-toggled
 * admin so they see live dev data — see module doc.
 *
 * ─── REQUEST-LEVEL DEDUPE (why the React `cache()` wrapper) ──────────
 *
 * This scan is consumed TWICE per render of /creators/[userId] — once by
 * `CreatorPnlPanel` (the Affiliates P&L boxes) and once by
 * `CreatorDealCostPanel` (the "Creator Net" block reuses the same lifetime
 * figure). Those two consumers live in SEPARATE Suspense boundaries with no
 * shared in-flight promise, and `unstable_cache` does NOT coalesce
 * concurrent COLD callers — so on a cold (cache-miss) load BOTH boundaries
 * would fire the heavy ~5s ledger transaction simultaneously, doubling the
 * contention on the `max: 5` connection pool the rest of the page also
 * needs. Wrapping the entry point in React `cache()` memoizes it per request
 * (keyed on `userId`), so the two consumers de-duplicate onto a SINGLE
 * underlying call within the render — the same `cache()` + `unstable_cache`
 * stacking the LIST page's `getAllCreatorsNetGgr` already uses. The
 * cross-request `unstable_cache` slot still serves warm loads; this only
 * removes the in-request double-scan. */
export const getCreatorPnlCached = cache(async function getCreatorPnlCached(
  userId: string,
): Promise<CreatorPnlData> {
  const env = await readDbEnv();
  if (env !== "prod") return getCreatorPnl(userId);
  return cachedCreatorPnl(userId);
});
