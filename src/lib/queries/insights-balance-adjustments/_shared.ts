import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "@/lib/queries/_blacklist";
import { officialStreamAdjustmentSqlPredicate } from "@/lib/balance-adjustment-categories";
import {
  daysForInsightsPeriod,
  cacheTtlForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";

/**
 * Shared helpers for every balance-adjustment query in this folder.
 *
 * The page sweeps a lot of lenses over `ledger_transactions` filtered to
 * `type = 'admin_balance_adjustment'` — the canonical row written by the
 * adjust-balance + record-manual-withdrawal flows in
 * `src/app/(admin)/users/[id]/actions.ts`. Every helper here is read-only
 * against the main DB and ties cache invalidation to the
 * `insights-balance-adjustments` tag so the page can refresh in one shot.
 *
 * SIGN CONVENTION (verified against actions.ts:158, :575):
 *   - amount > 0  → CREDIT: house GAVE the user balance.
 *   - amount < 0  → DEBIT:  house TOOK balance back (incl. manual
 *                            withdrawals, which use this same type with a
 *                            negative amount + a "Manual withdrawal:"
 *                            description prefix).
 *
 * HOUSE-POV color (per CLAUDE.md): a CREDIT to a user is a payout the
 * house gives → ROSE. A DEBIT (house takes back) → EMERALD. Net liability
 * for the house (credits exceed debits) → rose.
 *
 * REASON: there is no `reason` column on the ledger row. The admin's
 * free-text reason is embedded in `description` as
 * `"Admin adjustment: <reason>"` or `"Manual withdrawal: <reason> …"`.
 * We classify rows by that prefix; the raw reason is recovered by
 * stripping the prefix.
 */

/** Cache tag bucket every helper in this folder writes to. */
export const BALANCE_ADJ_CACHE_TAGS = [
  "insights-balance-adjustments",
] as const;

/** The ledger type that backs this whole surface. */
export const ADJ_TYPE = "admin_balance_adjustment" as const;

/**
 * The two description prefixes the write flows use to distinguish the
 * general balance adjustment from the manual-withdrawal subset. Kept in
 * sync with `adjustBalance` / `recordManualWithdrawal` in
 * `src/app/(admin)/users/[id]/actions.ts`.
 */
export const ADJ_DESC_PREFIX = "Admin adjustment: ";
export const MANUAL_WD_DESC_PREFIX = "Manual withdrawal:";

/**
 * Window-start expression for an `InsightsRewardsPeriod`. Returns the raw
 * SQL fragment that resolves to the lower-bound timestamp the window
 * opens at, or `-infinity` when the period is lifetime.
 */
export function windowStartExpr(period: InsightsRewardsPeriod): string {
  const days = daysForInsightsPeriod(period);
  return days !== null
    ? `NOW() - INTERVAL '${days} days'`
    : `'-infinity'::timestamp`;
}

/**
 * AND-fragment that filters `ledger_transactions` to the active window.
 * Defaults to the alias `lt`. Returns the empty string when the period is
 * lifetime — every helper unconditionally concatenates the result.
 *
 * LIFETIME BOUND (deliberate): unlike the deposit-bonus / cross-category
 * sweeps over the FULL ledger, this surface filters to a SINGLE ledger
 * type (`admin_balance_adjustment`) — rows written only by the admin
 * adjust-balance / manual-withdrawal flows. That population is intrinsically
 * bounded (orders of magnitude smaller than the gaming ledger), so the
 * `all` window is left UNBOUNDED on purpose: this is an accountability /
 * audit surface and capping it to a rolling year would hide older
 * adjustments an admin may need to audit. The lifetime scan is kept safe
 * instead by the REWARD_QUERY_TIMEOUT_MS wrapper on every tab's safeQuery
 * (so a pathological case degrades to a fallback tile rather than hanging
 * the segment) — see the balance-adjustments tab components.
 */
export function windowDateFilter(
  period: InsightsRewardsPeriod,
  alias = "lt",
): string {
  const days = daysForInsightsPeriod(period);
  return days !== null
    ? `AND ${alias}.created_at >= NOW() - INTERVAL '${days} days'`
    : "";
}

/**
 * Resolved exclusion list — dynamic blacklist (`excluded_users` table).
 * Returned sorted so callers participate in the cache key.
 *
 * NOTE: unlike the rewards helpers we do NOT exclude staff roles here.
 * Admin balance adjustments are an accountability surface — a credit
 * handed to a staff/creator account is exactly the kind of thing this
 * page exists to surface, so excluding staff would hide the most
 * interesting rows. We only honour the explicit blacklist
 * (`excluded_users`) to drop hand-picked test accounts.
 */
export async function getResolvedBlacklist(): Promise<string[]> {
  const blacklist = await getExcludedUserIds();
  return [...blacklist].sort();
}

/**
 * AND-fragment dropping blacklisted user_ids from a column. Returns the
 * empty string when the blacklist is empty so the fragment can be
 * concatenated unconditionally. `column` is inlined verbatim — pass only
 * trusted hardcoded identifiers (e.g. `lt.user_id`).
 */
export function blacklistFilter(
  blacklistIds: string[],
  column = "lt.user_id",
): string {
  return blacklistNotInClause(column, blacklistIds);
}

/**
 * AND-fragment that EXCLUDES the FAKE-BALANCE `official_stream` adjustments
 * from this surface. official_stream is owner-designated fake balance that
 * must be hidden absolutely everywhere — including this accountability
 * surface — so every lens (overview / by-user / direction-reason /
 * audit-trail) concatenates this fragment. Defaults to the alias `lt`; the
 * `type`/`metadata` columns are resolved off that alias.
 *
 * Returned as a leading-`AND` fragment so it can be concatenated
 * unconditionally onto an existing WHERE.
 */
export function notOfficialStreamFilter(alias = "lt"): string {
  return `AND NOT (${officialStreamAdjustmentSqlPredicate({
    typeColumn: `${alias}.type`,
    metadataColumn: `${alias}.metadata`,
  })})`;
}

/** Cache TTL for a given period — re-exported for convenience. */
export { cacheTtlForInsightsPeriod };
