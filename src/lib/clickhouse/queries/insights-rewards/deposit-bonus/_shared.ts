import "server-only";

import {
  daysForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";

import { CH_DB, chDateTime } from "../../_shared";

/**
 * Shared ClickHouse read helpers for the /insights/rewards/deposit-bonus CH
 * comparison twins.
 *
 * The deposit-bonus PG surface scopes to a TWO-role customer set
 * (`role NOT IN ('admin','support')` — creators are KEPT, unlike the wholesale
 * 3-role dashboard scope) plus the excluded-users blacklist (see
 * `staffAndBlacklistSubquery` in
 * `src/lib/queries/insights-rewards/deposit-bonus/_shared.ts`). These helpers
 * replicate that scope and the `windowDateFilter` cutoff EXACTLY so comparison
 * drift cleanly signals a real bug rather than an intended scope difference.
 *
 * CH boundary: this module imports NO Postgres/Prisma client (directly or
 * transitively) — `daysForInsightsPeriod` is a pure mapping whose only import is
 * a type-only `RewardsPeriod`, and `chDateTime`/`CH_DB` come from the shared CH
 * read helpers. Money stays Decimal end-to-end (toString(sum(...)) in SQL,
 * toNumber() in TS, never Float).
 */

const MS_PER_DAY = 86_400_000;

/**
 * The deposit-bonus customer-scope CTE — drops staff by role
 * (`admin`/`support`; creators KEPT, mirroring the PG twin's
 * `staffAndBlacklistSubquery`) and the excluded-users blacklist when present.
 * Default CTE name is `real_users`; the blacklist binds to the
 * `{blacklist:Array(String)}` query param.
 */
export function depositBonusScopeCte(hasBlacklist: boolean): string {
  return `real_users AS (
      SELECT id
      FROM ${CH_DB}.public_user FINAL
      WHERE _peerdb_is_deleted = 0
        AND role NOT IN ('admin','support')
        ${hasBlacklist ? "AND id NOT IN {blacklist:Array(String)}" : ""}
    )`;
}

/**
 * ClickHouse DateTime64 cutoff literal mirroring the PG `windowDateFilter`
 * (`created_at >= NOW() - INTERVAL 'N days'`), or `null` for the lifetime
 * (`all`) window where the PG fragment is empty (unbounded). `now` is injected
 * so a parity harness can feed the IDENTICAL cutoff to both engines.
 */
export function depositBonusCutoff(
  period: InsightsRewardsPeriod,
  now: Date,
): string | null {
  const days = daysForInsightsPeriod(period);
  return days !== null
    ? chDateTime(new Date(now.getTime() - days * MS_PER_DAY))
    : null;
}

/**
 * AND-fragment bounding `<alias>.created_at` to the window, or the empty string
 * for lifetime. Mirrors `windowDateFilter`.
 */
export function cutoffClause(cutoff: string | null, alias: string): string {
  return cutoff !== null
    ? `AND ${alias}.created_at >= {cutoff:DateTime64(6)}`
    : "";
}

/**
 * Lifetime lookback cap (days) for the heavy deposit↔bonus balance-pairing
 * queries — mirrors `LIFETIME_PAIRING_LOOKBACK_DAYS` in the PG twin's
 * `_shared.ts` (365d). On the lifetime (`all`) window the plain cutoff is
 * unbounded; these capped helpers bound the deposit-side scan to the last year
 * so the pairing stays tractable, EXACTLY matching `windowDateFilterCapped`.
 */
export const LIFETIME_PAIRING_LOOKBACK_DAYS = 365;

/**
 * Like {@link depositBonusCutoff} but NEVER null — on the lifetime window it
 * resolves to `now − LIFETIME_PAIRING_LOOKBACK_DAYS` instead of being
 * unbounded. Mirrors the PG `windowDateFilterCapped`. Finite windows behave
 * identically to {@link depositBonusCutoff}.
 */
export function depositBonusCappedCutoff(
  period: InsightsRewardsPeriod,
  now: Date,
): string {
  const days = daysForInsightsPeriod(period) ?? LIFETIME_PAIRING_LOOKBACK_DAYS;
  return chDateTime(new Date(now.getTime() - days * MS_PER_DAY));
}

/**
 * Like {@link depositBonusCappedCutoff} but extends the lower bound back by an
 * extra `tailDays`. Mirrors the PG `windowDateFilterCappedTail` — used for a
 * SECONDARY scan (e.g. the cohort retention wager scan) whose rows must cover a
 * forward tail after each in-window row. Finite windows get `days + tailDays`;
 * lifetime gets `LIFETIME_PAIRING_LOOKBACK_DAYS + tailDays`.
 */
export function depositBonusCappedTailCutoff(
  period: InsightsRewardsPeriod,
  now: Date,
  tailDays: number,
): string {
  const days = daysForInsightsPeriod(period) ?? LIFETIME_PAIRING_LOOKBACK_DAYS;
  return chDateTime(new Date(now.getTime() - (days + tailDays) * MS_PER_DAY));
}
