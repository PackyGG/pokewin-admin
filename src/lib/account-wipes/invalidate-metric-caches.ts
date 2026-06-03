import "server-only";

import { revalidatePath, revalidateTag } from "next/cache";

/**
 * invalidate-metric-caches.ts — ONE shared cache-bust used by every account
 * wipe + restore so a destructive change shows up in the GLOBAL metric
 * surfaces (dashboard, /ggr, /analytics, /insights/*) IMMEDIATELY instead of
 * lingering for up to a cache TTL.
 *
 * WHY THIS EXISTS (owner mandate): each wipe action (wipeBalance / wipeVault
 * / wipeInventory in wipe-account-targets-actions.ts, and
 * wipeBalanceAdjustments in wipe-adjustments-actions.ts) genuinely DELETES
 * rows / zeroes the live balance pool in the main DB — the underlying data IS
 * gone. But the global metric surfaces are served from `unstable_cache`
 * (60–300s TTLs, tag-keyed). So after a wipe the just-removed data (most
 * visibly inventory `value_at_obtained`, which feeds the canonical GGR
 * inventory-payout leg in `src/lib/queries/ggr.ts`, and the live balance pools
 * the P&L `onSiteBalance` term reads) keeps showing in those cached numbers
 * until the TTL lapses → it looks like the wipe "didn't count". Each wipe only
 * called `revalidatePath('/users/${id}')`, refreshing the user page alone.
 *
 * Centralising the tag/path list here (rather than copy-pasting it into the
 * six call sites) keeps every wipe + restore busting the EXACT same caches,
 * so the list can never drift between modes.
 *
 * ── How the surfaces are cached (verified against the query modules) ──────
 *
 * The GLOBAL metric numbers are NOT live-rendered everywhere — most read a
 * tag-keyed `unstable_cache` layer:
 *
 *   • /dashboard         → dashboard.ts / dashboard-upgrader.ts /
 *                          dashboard-live.ts / _realized-pnl.ts:
 *                          tags `dashboard-lifetime`, `dashboard-stats`,
 *                          `dashboard-activity`.
 *   • /analytics         → analytics.ts: tag `analytics`.
 *   • /insights/analytics→ insights-analytics/*: tags `insights-analytics`
 *                          (+ `dashboard-lifetime` / `dashboard-stats` on the
 *                          shared bridges).
 *   • /insights/rewards  → insights-rewards/**: tags `rewards-analytics`,
 *                          `insights-rewards`, `insights-rewards-rakeback`,
 *                          `insights-rewards-race`, `insights-rewards-signup`,
 *                          `insights-rewards-affiliate`,
 *                          `insights-rewards-deposit-bonus`.
 *   • /insights/balance-adjustments → insights-balance-adjustments/*:
 *                          tag `insights-balance-adjustments`.
 *   • /insights/streamers→ insights-streamers/*: tag `insights-streamers`.
 *
 * `/ggr` is the exception — its page reads `getGgrPageData` /
 * `getGgrTopContributors` (in `src/lib/queries/ggr.ts`) DIRECTLY in the
 * server component with no `unstable_cache` wrapper, so it is dynamically
 * rendered. For it, `revalidatePath('/ggr')` is what forces a fresh render
 * (there is no tag to bust).
 *
 * The per-user page is NOT live-rendered for its P&L: `/users/[id]` reads its
 * detail aggregate, Platform-P&L breakdown (incl. the rolling windowed-P&L
 * tiles), and risk score through `unstable_cache` entries tagged `users-detail`
 * (src/lib/queries/users-detail-cache.ts). `revalidatePath('/users/${id}')`
 * clears the route's RENDER cache but does NOT invalidate those data-cache
 * entries — only `revalidateTag('users-detail')` does. So both are needed for
 * that page, and `users-detail` is in the tag list below.
 *
 * We therefore do BOTH: `revalidateTag(...)` for every tag bucket above, and
 * `revalidatePath(...)` for the dynamically-rendered surfaces + the user
 * surfaces. The `/insights` segment is busted with `revalidatePath(..,
 * 'layout')` so every nested insights route clears in one call.
 *
 * NOTE on denormalized counters (audited, intentionally NOT touched here):
 * `balances.total_deposited/withdrawn/wagered/won` are stored lifetime
 * counters the dashboard sums (`SUM(total_*)`). The targeted balance / vault
 * / inventory wipes are NARROW + RECOVERABLE and (like the already-merged
 * balance-adjustments wipe) adjust ONLY the live pool, never these lifetime
 * counters — matching that sibling wipe's established precedent. The full,
 * non-recoverable `wipeUserAccount` is the only flow that zeroes them
 * wholesale (it deletes the entire account). Adjusting the lifetime counters
 * for a partial wipe would require verified backend-increment semantics that
 * are owned by the packy.gg backend, not this panel — so this cache-bust does
 * NOT write to them. The metric surfaces this helper refreshes (GGR inv-leg,
 * P&L on-site/inventory terms, analytics) are all LIVE-computed from the rows
 * the wipe deletes, so busting their caches is what makes the change appear.
 */

/**
 * Every `unstable_cache` tag bucket a balance / vault / inventory / adjustment
 * wipe (or its restore) can move. Deleting inventory rows / zeroing balance
 * changes GGR, NGR, P&L, money-flow, and the rewards/affiliate giveback
 * ratios, so the full metric tag surface is busted (a superset is safe — a
 * tag that didn't actually change just re-warms on next read).
 *
 * Hardcoded string literals (not imported from the query modules) on purpose:
 * those modules are `server-only` query layers and several pull in the DB
 * client transitively; importing them here just to read a const would drag
 * that surface into the wipe action's module graph. The strings are asserted
 * against the query modules in this file's header and must stay in sync if a
 * surface's tag is renamed.
 */
const METRIC_CACHE_TAGS = [
  // Dashboard (lifetime KPIs, windowed stats, live activity feed).
  "dashboard-lifetime",
  "dashboard-stats",
  "dashboard-activity",
  // /analytics.
  "analytics",
  // /insights/analytics (+ its shared dashboard bridges already above).
  "insights-analytics",
  // /insights/rewards — the whole reward-giveback surface.
  "rewards-analytics",
  "insights-rewards",
  "insights-rewards-rakeback",
  "insights-rewards-race",
  "insights-rewards-signup",
  "insights-rewards-affiliate",
  "insights-rewards-deposit-bonus",
  // /insights/balance-adjustments.
  "insights-balance-adjustments",
  // /insights/streamers.
  "insights-streamers",
  // /users/[id] — the per-user detail aggregate, Platform-P&L breakdown
  // (which carries the rolling 12h/24h/3d/7d/14d windowed P&L tiles), and the
  // fraud/risk score are ALL served from `unstable_cache` entries tagged
  // `users-detail` (see src/lib/queries/users-detail-cache.ts). A wipe DELETES
  // the rows those reads aggregate, so without busting this tag the per-user
  // page keeps serving the STALE cached numbers — most visibly the rolling
  // P&L tiles, which showed a phantom ~$20k house loss for a wiped user
  // (FloridaManJeff) because the cached pre-wipe value survived. `revalidatePath`
  // alone does NOT invalidate `unstable_cache` data entries — only a
  // `revalidateTag` on a tag the entry declared does — so the path revalidation
  // below is necessary for the route's render cache but insufficient for these
  // tag-keyed reads. This tag closes that gap.
  "users-detail",
] as const;

/**
 * Dynamically-rendered metric surfaces (no tag to bust) + the user surfaces.
 * `/ggr` renders its numbers live, so a path revalidation is what refreshes it.
 * The per-user page's render cache is cleared here too, but its P&L/detail/risk
 * numbers come from `users-detail`-tagged `unstable_cache` entries that the
 * `revalidateTag('users-detail')` in the tag loop busts (a path revalidation
 * alone would leave them stale). `/insights` is revalidated at the `layout`
 * level so every nested insights route clears in a single call.
 */
function revalidateMetricPaths(userId: string): void {
  // Dynamically-rendered surfaces.
  revalidatePath("/ggr");
  revalidatePath("/dashboard");
  revalidatePath("/analytics");
  // All nested /insights/* routes in one shot.
  revalidatePath("/insights", "layout");
  // User surfaces — the list and the specific user whose data was wiped.
  revalidatePath("/users");
  revalidatePath(`/users/${userId}`);
}

/**
 * Bust every global metric cache + revalidate the dynamically-rendered metric
 * and user surfaces, so a wipe / restore reflects across the whole site
 * immediately. Call this AFTER the destructive main-DB commit (or after a
 * successful restore) in every wipe action.
 *
 * `userId` is the wiped/restored user, used to revalidate `/users/${userId}`.
 *
 * Best-effort and non-throwing: cache invalidation is a refresh hint, never
 * the source of truth. The wipe itself has already committed by the time this
 * runs, so if a `revalidate*` call were ever to throw we must NOT turn a
 * succeeded-and-committed wipe into a reported failure — the data is already
 * gone and will refresh on the next TTL lapse regardless. Any failure is
 * logged and swallowed.
 */
export function invalidateMetricCaches(userId: string): void {
  try {
    for (const tag of METRIC_CACHE_TAGS) {
      revalidateTag(tag);
    }
    revalidateMetricPaths(userId);
  } catch (err) {
    // The wipe/restore is already committed; a failed refresh hint must not
    // surface as a failure. Log loudly so a broken revalidation is visible.
    console.error(
      "[invalidateMetricCaches] failed to invalidate metric caches after a wipe/restore (the destructive change is already committed; caches will refresh on TTL lapse):",
      err,
    );
  }
}
