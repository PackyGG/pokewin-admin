import { unstable_cache } from "next/cache";
import { readDbEnv } from "@/lib/db-env";
import { getUserDetail, getUserHeader } from "./users-detail";
import { getUserPnlBreakdown, type PnlBreakdown } from "./users-financial";
import { getUserTransactions } from "./users-transactions";

/**
 * Cross-request cache for the TWO heaviest per-user reads behind
 * /users/[id] — the detail aggregate (~19 Main-DB round-trips + the
 * canonical P&L helper) and the Platform-P&L breakdown (multiple ledger
 * aggregates + the 5-window rolling scan).
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
 * `getUserDetail` / `getUserPnlBreakdown` each call
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

const REVALIDATE_SECONDS = 25;

// The Gaming transaction feed gets a SHORTER TTL than the detail/balances
// aggregate: it's the feed an operator watches update during an
// investigation, so it should be the freshest of the cached per-user reads.
// The underlying query is now index-served (sub-ms — idx_ledger_tx_user_created_at),
// so this cache exists only to skip the repeated enrichment fan-out, not for
// raw speed; 15s keeps it well inside the 60s AutoRefresh tick.
const GAMING_TX_REVALIDATE_SECONDS = 15;

// The Finances / Overview feed (Deposits & Withdrawals) is cached too, but it
// carries owner-gated admin_balance_adjustment rows, so its cache key includes
// the resolved viewer-owner flag (see getUserFinancialTransactionsCached). A
// slightly longer TTL than gaming — these rows change less often than gaming
// activity during an investigation.
const FINANCIAL_TX_REVALIDATE_SECONDS = 30;

// `unstable_cache` also de-duplicates within a single render, so if two
// code paths request the same user's detail in one pass they share the
// single underlying query. The cached callbacks always run against prod
// (see module doc), so the cache key needs no env dimension.

// v1 → v2: getUserDetail's fail-fast legs were drift-proofed (battle-limits
// + signup-usage .catch(() => null); wager breakdown via the LIVE enum
// filter). Pre-fix v1 entries can hold the rejected/zeroed shapes — a fresh
// namespace guarantees the fixed code path's output isn't shadowed.
const cachedUserDetail = unstable_cache(
  (userId: string) => getUserDetail(userId),
  ["users-detail-aggregate-v2"],
  { revalidate: REVALIDATE_SECONDS, tags: ["users-detail"] },
);

// Keypart bumped across 2026-06-03 deploys to FORCE-DISCARD stale cached
// rolling-P&L values, because the Vercel data cache persists `unstable_cache`
// entries ACROSS deployments (the key is the static keyParts + a closure hash,
// not the deployment id), so a code change to `getUserPnlBreakdown` would
// otherwise keep serving the old value stale-while-revalidate under the prior
// key. Same force-invalidate-on-code-change pattern as cards.ts.
//   • v1 → v2: the wipe-aware add-back rolling-P&L correction (commit c836684)
//     changed the numbers for any user with recent admin wipes.
//   • v2 → v3: the GUARANTEED phantom-loss fix — `getUserPnlBreakdown` now also
//     returns per-window `wiped*` flags and the rolling tiles render "—"
//     (reset) for any window crossing an admin wipe. The shape changed (new
//     fields) AND the surfaced value changed (FloridaManJeff's phantom
//     −$18k tiles become "—"), so a fresh namespace guarantees the new code
//     path's output isn't shadowed by a pre-fix v2 entry. The `users-detail`
//     cache-bust tag (70be8d3) is retained so a wipe still revalidates live.
//   • v5 → v6: getUserPnlBreakdown's by-type rows query went enum-drift-proof
//     (`type IN (...)` → `type::text IN (...)`). On prod the old query threw
//     22P02 (live enum lacks the upgrader members) and the breakdown degraded
//     to all-zeros — bump so the fixed query's real numbers replace any
//     zeroed v5 entries immediately instead of stale-while-revalidate.
const cachedUserPnlBreakdown = unstable_cache(
  (userId: string): Promise<PnlBreakdown> => getUserPnlBreakdown(userId),
  ["users-detail-pnl-v6"],
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

/**
 * Cross-request cache for the Gaming tab's FIRST-PAGE transaction read —
 * the heaviest per-user feed on /users/[id].
 *
 * Why this is safe to cache with a VIEWER-AGNOSTIC key
 * ────────────────────────────────────────────────────
 * `getUserTransactions` runs an EXPENSIVE fan-out per page: the base
 * `ledger_transactions` listing PLUS battle / pack / inventory / voucher /
 * upgrader enrichment lookups. For the Gaming type set
 * (pack_opening / battle_bet / battle_sponsorship / battle_refund /
 * upgrader_bet / upgrader_payout) the result is VIEWER-INDEPENDENT: none of
 * those types is `admin_balance_adjustment`, so the owner-only adjustment-
 * visibility gate inside `getUserTransactions` cannot change a single row.
 * That makes a viewer-agnostic cache key (userId + page + perPage + types)
 * correct here. The Finances feed needs an EXTRA key dimension instead (the
 * resolved owner flag) because its type set includes admin_balance_adjustment
 * — see getUserFinancialTransactionsCached below.
 *
 * Cache-safety of the cookie-scoped reads (same as the detail caches above):
 * the callback runs OUTSIDE the request's dynamic scope, so both `getDb()`
 * → `readDbEnv()` (falls back to prod) and `getUserTransactions`'
 * `verifySession()` (caught → fail-closed non-owner, a no-op for gaming
 * types) behave deterministically. We therefore cache ONLY on prod and run
 * the query directly for a dev-toggled admin.
 *
 * This memoizes the whole fan-out for `GAMING_TX_REVALIDATE_SECONDS` (15s), so the 60s
 * AutoRefresh tick, the segment "Try again" retry, and a revisit within the
 * window all resolve from the warmed entry instead of re-paying the scan —
 * bridging the gap until the recommended `(user_id, created_at DESC)` index
 * (prisma/recommended-indexes.sql #19) is applied. Pagination / filtering /
 * load-more still go through the uncached `fetchUserTransactions` action, so
 * only the streamed first page is cached. The `users-detail` tag means an
 * admin balance wipe revalidates it alongside the detail aggregate.
 */
const cachedUserGamingTransactions = unstable_cache(
  (userId: string, page: number, perPage: number, types: string[]) =>
    getUserTransactions(userId, page, perPage, { types }),
  ["users-detail-gaming-tx-v1"],
  { revalidate: GAMING_TX_REVALIDATE_SECONDS, tags: ["users-detail"] },
);

/**
 * Cached Gaming first-page transactions on prod; direct (uncached) on a
 * dev-toggled admin so they see live dev data — see the doc above and the
 * module-level DB-env note.
 */
export async function getUserGamingTransactionsCached(
  userId: string,
  page: number,
  perPage: number,
  types: string[],
): Promise<Awaited<ReturnType<typeof getUserTransactions>>> {
  const env = await readDbEnv();
  if (env !== "prod") {
    return getUserTransactions(userId, page, perPage, { types });
  }
  return cachedUserGamingTransactions(userId, page, perPage, types);
}

/**
 * Cross-request cache for the Finances / Overview feed's FIRST-PAGE read
 * (the Deposits & Withdrawals tab + the Overview financial preview).
 *
 * Why this one needs a viewer-keyed cache
 * ───────────────────────────────────────
 * The Finances type set includes `admin_balance_adjustment`, whose rows are
 * visible ONLY to the owner (`motha`). `getUserTransactions` normally resolves
 * that gate itself via verifySession() — which CANNOT run inside an
 * `unstable_cache` callback (cookies() throws → it would fail-closed and hide
 * adjustments from the owner). So the caller resolves the SAME gate on the
 * request (isAdjustmentVisibilityOwner, the value the page already computes for
 * the dedicated adjustments block) and we pass it BOTH as a cache-key dimension
 * AND as `viewerIsOwnerOverride`. Owner and non-owner therefore get SEPARATE
 * cached entries — the non-owner entry (the common case) can never leak an
 * adjustment row, and the owner's entry always includes them. Without the gate
 * needing a live session read, the fan-out is now cacheable.
 *
 * Same prod-only rule and `users-detail` revalidation tag as the gaming cache.
 */
const cachedUserFinancialTransactions = unstable_cache(
  (
    userId: string,
    page: number,
    perPage: number,
    types: string[],
    viewerIsOwner: boolean,
  ) => getUserTransactions(userId, page, perPage, { types }, viewerIsOwner),
  ["users-detail-financial-tx-v1"],
  { revalidate: FINANCIAL_TX_REVALIDATE_SECONDS, tags: ["users-detail"] },
);

/**
 * Cached Finances/Overview first-page transactions on prod; direct (uncached)
 * on a dev-toggled admin. `viewerIsOwner` MUST be resolved by the caller on the
 * request (via isAdjustmentVisibilityOwner) — it both keys the cache and gates
 * adjustment-row visibility, so passing the wrong value would mis-scope the
 * owner-only rows. See the doc above.
 */
export async function getUserFinancialTransactionsCached(
  userId: string,
  page: number,
  perPage: number,
  types: string[],
  viewerIsOwner: boolean,
): Promise<Awaited<ReturnType<typeof getUserTransactions>>> {
  const env = await readDbEnv();
  if (env !== "prod") {
    return getUserTransactions(userId, page, perPage, { types }, viewerIsOwner);
  }
  return cachedUserFinancialTransactions(
    userId,
    page,
    perPage,
    types,
    viewerIsOwner,
  );
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
