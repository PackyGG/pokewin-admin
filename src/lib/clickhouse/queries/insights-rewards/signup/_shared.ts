import "server-only";

import {
  daysForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";

import { chDateTime } from "../../_shared";

/**
 * Shared ClickHouse read helpers for the /insights/rewards/signup CH
 * comparison twins.
 *
 * The signup PG surface scopes to a TWO-role customer set
 * (`role NOT IN ('admin','support')` — creators are KEPT, unlike the wholesale
 * 3-role dashboard scope) plus the excluded-users blacklist (every helper in
 * `src/lib/queries/insights-rewards/signup/*` uses `role NOT IN ('admin','support')`
 * + `blacklistNotInClause`). These helpers replicate that scope and the cohort
 * window cutoff EXACTLY so comparison drift cleanly signals a real bug rather
 * than an intended scope difference.
 *
 * Cohort definition (mirrors `_shared.ts` in the PG folder): the "signup
 * cohort" is `public_user` rows whose `created_at` falls inside the selected
 * window (`null`/lifetime → unbounded). The "claimant cohort" is the subset
 * with ≥1 `balance_reward_claim` ledger row at ANY time (NOT window-bounded) —
 * the join carries no date filter on the claim.
 *
 * CH boundary: this module imports NO Postgres/Prisma client (directly or
 * transitively) — `daysForInsightsPeriod` is a pure mapping whose only import
 * is a type-only `RewardsPeriod`, and `chDateTime`/`CH_DB` come from the shared
 * CH read helpers. Money stays Decimal end-to-end (toString(sum(...)) in SQL,
 * toNumber() in TS, never Float).
 */

export const MS_PER_DAY = 86_400_000;

/** Role predicate replicated VERBATIM from every signup PG twin. */
export const SIGNUP_ROLE_SCOPE = "role NOT IN ('admin','support')";

/**
 * Wager-side ledger types — mirrors `WAGER_PAYOUT_WAGER_TYPES` /
 * `WAGER_TYPES_SQL` in `src/lib/queries/_wager-payout-types.ts`. Inlined here
 * (rather than imported) per the CH-module convention so the CQRS layer stays
 * Postgres-free with zero transitive risk.
 */
export const WAGER_TYPES_CH =
  "('pack_opening','battle_bet','battle_sponsorship','upgrader_bet','withdrawal_shipping_fee')";

/**
 * ClickHouse DateTime64 cutoff literal for the standard signup cohort window
 * (`u.created_at >= NOW() - INTERVAL 'N days'`), or `null` for the lifetime
 * (`all`) window where the PG fragment is empty (unbounded). `now` is injected
 * so a parity harness can feed the IDENTICAL cutoff to both engines.
 */
export function signupCutoff(
  period: InsightsRewardsPeriod,
  now: Date,
): string | null {
  const days = daysForInsightsPeriod(period);
  return days !== null
    ? chDateTime(new Date(now.getTime() - days * MS_PER_DAY))
    : null;
}

/**
 * Cutoff for the legs whose lifetime window is capped to a finite lookback
 * instead of being unbounded (daily caps at 365d, geo-timeseries at 90d). For
 * finite periods this equals {@link signupCutoff}.
 */
export function signupCutoffCapped(
  period: InsightsRewardsPeriod,
  now: Date,
  lifetimeDays: number,
): string {
  const days = daysForInsightsPeriod(period) ?? lifetimeDays;
  return chDateTime(new Date(now.getTime() - days * MS_PER_DAY));
}

/**
 * Cutoff for the cohort-matrix leg, whose window is rounded UP to whole weeks
 * (`weeksBack * 7` days, where `weeksBack = ceil(days/7)` or 52 for lifetime) —
 * matching the PG twin's `DATE_TRUNC('week', …)` cohort range exactly.
 */
export function signupCohortMatrixCutoff(
  period: InsightsRewardsPeriod,
  now: Date,
): string {
  const days = daysForInsightsPeriod(period);
  const weeksBack = days !== null ? Math.ceil(days / 7) : 52;
  return chDateTime(new Date(now.getTime() - weeksBack * 7 * MS_PER_DAY));
}

/** `AND <col> >= {cutoff:DateTime64(6)}` or empty string for an unbounded window. */
export function cutoffClause(cutoff: string | null, col: string): string {
  return cutoff !== null ? `AND ${col} >= {cutoff:DateTime64(6)}` : "";
}

/** `AND <col> NOT IN {blacklist:Array(String)}` or empty string when no blacklist. */
export function blacklistClause(hasBlacklist: boolean, col: string): string {
  return hasBlacklist ? `AND ${col} NOT IN {blacklist:Array(String)}` : "";
}

export { CH_DB, chDateTime } from "../../_shared";
export { toNumber } from "@/lib/utils/decimal";
