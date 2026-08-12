import { unstable_cache } from "next/cache";
import { readDbEnv } from "@/lib/db-env";
import { getUserDetail, resolveUserIdFromRouteKey } from "./users-detail";
import { logError } from "@/lib/errors/logger";
import { getUserPnlBreakdown, type PnlBreakdown } from "./users-financial";
import { getUserTransactions } from "./users-transactions";

/**
 * Canonical cache tags for the /users/[id] route. Every `unstable_cache`
 * entry that backs a per-user detail read MUST carry BOTH:
 *   • USERS_DETAIL_GLOBAL_TAG — busts all per-user caches in one go
 *     (preserved so list-level mutations + the legacy refresh path keep
 *     working).
 *   • `userDetailTag(userId)` — busts ONLY this user's caches, so a
 *     refresh on user A doesn't nuke unrelated users' warmed entries and
 *     so per-user mutations (balance adjust, identity edit, ban, lock,
 *     etc.) can target exactly the affected user.
 *
 * Exported so server actions across `users/[id]/*` and admin balance /
 * gift-card / voucher flows can call `revalidateTag(userDetailTag(id))`
 * after writes without re-deriving the string.
 */
export const USERS_DETAIL_GLOBAL_TAG = "users-detail";
export function userDetailTag(userId: string): string {
  return `users-detail-${userId}`;
}
function userDetailTags(userId: string): string[] {
  return [USERS_DETAIL_GLOBAL_TAG, userDetailTag(userId)];
}

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
 * resolve the request-scoped Drizzle client, which reads the per-admin `admin_db_env`
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
// v2 → v3: `balances` now carries `wagerLocked` + `wagerProgress` (frozen-rate
// wager-requirement debt) so the balance breakdown can split the new "Vault"
// (cooldown) line from the new "Locked" (wager-locked bonus) line. The shape
// changed — bump so the new fields aren't `undefined` from a stale v2 entry.
//
// Per-user tags: tags are passed PER CALL via a per-userId wrapper so
// `revalidateTag(userDetailTag(userId))` busts ONLY this user's entry.
// `unstable_cache` identifies an entry by `keyParts`, NOT by the closure
// identity — so re-wrapping inside the call still hits the same cache
// entry while letting the tags depend on the userId. The global
// "users-detail" tag is preserved so list-level + legacy bulk flushes
// (refreshUserDetailCache, admin balance wipes) keep working.
function cachedUserDetail(userId: string) {
  return unstable_cache(
    () => getUserDetail(userId),
    // v4 discards outage-era values retained when PostgreSQL 57P05 prevented
    // stale-while-revalidate from refilling this balance/detail aggregate.
    ["users-detail-aggregate-v4", userId],
    { revalidate: REVALIDATE_SECONDS, tags: userDetailTags(userId) },
  )();
}

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
function cachedUserPnlBreakdown(userId: string): Promise<PnlBreakdown> {
  return unstable_cache(
    (): Promise<PnlBreakdown> => getUserPnlBreakdown(userId),
    // v7 discards outage-era values retained after 57P05 mirror termination.
    ["users-detail-pnl-v7", userId],
    { revalidate: REVALIDATE_SECONDS, tags: userDetailTags(userId) },
  )();
}

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
 * Same prod-only rule and `users-detail` revalidation tag as the detail cache.
 */
function cachedUserFinancialTransactions(
  userId: string,
  page: number,
  perPage: number,
  types: string[],
  viewerIsOwner: boolean,
  viewerCanSeeUltraLossback: boolean,
) {
  return unstable_cache(
    () => getUserTransactions(
      userId,
      page,
      perPage,
      { types },
      viewerIsOwner,
      viewerCanSeeUltraLossback,
    ),
    [
      // v3 clears outage-era Overview finance values retained after 57P05.
      "users-detail-financial-tx-v3",
      userId,
      String(page),
      String(perPage),
      types.join(","),
      viewerIsOwner ? "owner" : "non-owner",
      viewerCanSeeUltraLossback ? "ultra" : "non-ultra",
    ],
    { revalidate: FINANCIAL_TX_REVALIDATE_SECONDS, tags: userDetailTags(userId) },
  )();
}

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
  viewerCanSeeUltraLossback: boolean,
): Promise<Awaited<ReturnType<typeof getUserTransactions>>> {
  const env = await readDbEnv();
  if (env !== "prod") {
    return getUserTransactions(
      userId,
      page,
      perPage,
      { types },
      viewerIsOwner,
      viewerCanSeeUltraLossback,
    );
  }
  return cachedUserFinancialTransactions(
    userId,
    page,
    perPage,
    types,
    viewerIsOwner,
    viewerCanSeeUltraLossback,
  );
}

/**
 * Route-key → canonical user id resolution with a SHORT wall-clock bound,
 * for the page's critical path.
 *
 * `resolveUserIdFromRouteKey` is the FIRST thing `/users/[id]/page.tsx`
 * awaits — it runs UN-streamed, BEFORE any `<Suspense>` boundary, because
 * nothing (not even the shell) can render until we know whether the route
 * key maps to a real user (→ id) or an unknown one (→ 404). It is now a
 * single indexed lookup (a PK read for id/uuid keys, or a
 * `lower(username) = $1` Index Scan for handles). It uses the separate
 * primary pool so slow analytics reads occupying the mirror's two slots do
 * not queue this prerequisite. The short guard remains as protection against
 * a primary connection outage. If the query THROWS, with no Suspense above
 * it, that throw would otherwise go
 * straight to the segment error boundary, white-screening the WHOLE page
 * ("Couldn't load this user", digest 497656675) on the #1-traffic route.
 *
 * This wrapper races the resolve against a short timeout and NEVER lets it
 * throw up to the page:
 *   - `{ found: true, id }`  — resolved to a real user id → render the page,
 *   - `{ found: false }`     — either a genuinely-unknown key (clean null)
 *                              or a slow/failed resolve. The caller uses
 *                              `degraded` to avoid a misleading outage 404.
 *
 * On timeout/failure we DEGRADE to `found: false` rather than re-throwing.
 * `degraded` marks the transient failure so the page can render an honest,
 * retryable load error. Only a real missing user maps to `notFound()`.
 */
const RESOLVE_TIMEOUT_MS = 4_000;

export type CriticalResolveResult =
  | { found: true; id: string }
  | { found: false; degraded: boolean };

export async function resolveUserIdCritical(
  routeKey: string,
): Promise<CriticalResolveResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error("resolveUserIdFromRouteKey exceeded critical-path budget"),
        ),
      RESOLVE_TIMEOUT_MS,
    );
  });
  try {
    const id = await Promise.race([
      resolveUserIdFromRouteKey(routeKey),
      timeout,
    ]);
    if (!id) return { found: false, degraded: false };
    return { found: true, id };
  } catch (err) {
    // Slow or failed resolve (pool starvation / transient DB error). We can
    // NOT render anything without the id, so degrade to a clean notFound
    // instead of throwing to the error boundary and crashing the page.
    // Logged so the degrade is visible upstream and distinguishable from a
    // genuine unknown route key.
    logError(
      "users.detail.resolve",
      "critical-path route-key lookup degraded",
      err,
    );
    return { found: false, degraded: true };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
