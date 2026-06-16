import "server-only";

import { unstable_cache } from "next/cache";
import { withTiming } from "@/lib/observability/query-timings";
import { resolveAdminRead } from "@/lib/clickhouse/resolve-read";
import { getAffiliateReferredPnlTodayFromClickHouse } from "@/lib/clickhouse/queries/dashboard/affiliate-referred-pnl-today";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { calculateWindowedPnl } from "./pnl";

/**
 * Aggregate house P&L on AFFILIATE-REFERRED PLAYERS for the CURRENT CALENDAR
 * DAY since 00:00 UTC — the small corner indicator on the dashboard's
 * "Creators Costs (today)" tile.
 *
 * ─── WHAT IT IS ──────────────────────────────────────────────────────────
 *
 * The same window + UTC-midnight boundary as the Creators Costs box (and the
 * P&L Today / Reward Costs Today tiles), but scoped to the affiliate-referred
 * player population instead of every customer. It REUSES the canonical 5-term
 * windowed P&L formula (`calculateWindowedPnl` — the single source of truth):
 *
 *   pnl = Δdeposits − Δwithdrawals − Δbalance − Δinventory − Δvouchers
 *
 * over [today 00:00 UTC, now). Because it goes through `calculateWindowedPnl`,
 * the fake-balance `official_stream` adjustment is ALREADY netted out exactly
 * as the rest of the app treats it (the balance-Δ term excludes
 * `official_stream` rows via `officialStreamAdjustmentSqlPredicate`), and no
 * money math is hand-rolled here.
 *
 * House-POV per CLAUDE.md: pnl > 0 → house up (emerald); pnl < 0 → house down
 * (rose).
 *
 * ─── POPULATION SCOPE (isolated + swappable) ─────────────────────────────
 *
 * The population is defined in ONE labeled constant,
 * {@link AFFILIATE_REFERRED_POPULATION_SCOPE_SQL}, so it is trivially
 * swappable. Current definition — "affiliate-referred players":
 *
 *   real customer users whose `user.referred_by` points to a CREATOR
 *   (a `role = 'creator'` user).
 *
 * `user.referred_by` is the persistent attribution column the rest of the
 * admin uses to count a creator's referred users (see
 * `creators-detail.ts` signup counts: `WHERE referred_by = <creatorId>`). It
 * is the most stable definition of "a real customer attributed to a creator's
 * affiliate code". The global real-user filter in `calculateWindowedPnl`
 * already drops admin/support/creator roles + the excluded-users blacklist,
 * so the referred user is always a real customer; this fragment additionally
 * requires their referrer to be a creator.
 *
 * ALTERNATIVE the owner may want instead: the CREATORS' OWN account P&L (the
 * P&L of the creator accounts themselves, not the players they referred). To
 * switch to that, replace the scope constant with `u.role = 'creator'` (and
 * remove `creator` from the role exclusion in `calculateWindowedPnl`, since
 * that filter would otherwise drop every creator) — a deliberately different
 * cohort, flagged here so the swap is one obvious place.
 *
 * ─── PERFORMANCE ────────────────────────────────────────────────────────
 *
 * Today-only window — no lifetime scan. `unstable_cache` keyed on the UTC day
 * string + the serialized blacklist (revalidate 60s, same cadence + tag as
 * the Creators Costs / P&L Today tiles), wrapped in `safeQuery` at the call
 * site, streamed inside the existing Creators Costs `<Suspense>`. Degrades to
 * nothing (the card simply omits the corner badge) if the query fails.
 */

/**
 * The affiliate-referred-players population scope — a trusted, hardcoded SQL
 * boolean fragment referencing the `"user" u` alias of the global scope
 * subquery in `calculateWindowedPnl`. THE one place to change the cohort.
 *
 * Current cohort: real customers whose referrer (`u.referred_by`) is a
 * creator account. `EXISTS` against `"user"` (not a join) keeps it a cheap
 * semi-join the planner can satisfy with the PK index on the referrer id.
 */
export const AFFILIATE_REFERRED_POPULATION_SCOPE_SQL = `u.referred_by IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "user" ref
    WHERE ref.id = u.referred_by
      AND ref.role = 'creator'
  )`;

export type AffiliateReferredPnlToday = {
  /** House P&L on affiliate-referred players today (5-term windowed formula). */
  pnl: number;
  /** ISO timestamp of the window start (today 00:00 UTC). */
  dayStartIso: string;
};

/**
 * UTC start-of-day for the instant `now`. Mirrors the Creators Costs / Reward
 * Costs / P&L Today boxes' boundary so the corner figure covers the SAME
 * "today" window as the box it sits on.
 */
function utcStartOfDay(now: Date): Date {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * Cached inner computation. Keyed on the UTC day string + the serialized
 * blacklist so it re-fills when the day rolls over OR when an admin edits the
 * excluded-users list. `revalidate: 60` matches the dashboard's
 * activity-cache cadence. The blacklist is resolved OUTSIDE `unstable_cache`
 * (it reads the admin DB, which can't run inside the cache scope) and passed
 * in as a serializable arg — the same pattern as `cachedTodayPnl`.
 */
const cachedAffiliateReferredPnlToday = unstable_cache(
  async (
    dayKey: string,
    sinceIso: string,
    excludeUserIds: string[],
  ): Promise<number> => {
    void dayKey; // part of the cache key only
    // CQRS serve-path: clickhouse serves the CH twin (SOLE read);
    // off/comparison serve Postgres. Parity confirmed cent-exact.
    return resolveAdminRead<number>("dashboard_affiliate_referred_pnl_today", {
      pg: async () => {
        const { pnl } = await calculateWindowedPnl({
          since: new Date(sinceIso),
          excludeUserIds,
          populationScopeSql: AFFILIATE_REFERRED_POPULATION_SCOPE_SQL,
        });
        return pnl;
      },
      ch: async () => {
        const { pnl } = await getAffiliateReferredPnlTodayFromClickHouse(
          new Date(sinceIso),
          excludeUserIds,
        );
        return pnl;
      },
    });
  },
  ["dashboard-affiliate-referred-pnl-today-v1"],
  { revalidate: 60, tags: ["dashboard-activity"] },
);

/**
 * Aggregate house P&L on affiliate-referred players for the current calendar
 * day (since 00:00 UTC). Resolves the cached today-windowed aggregate.
 */
export async function getAffiliateReferredPnlToday(): Promise<AffiliateReferredPnlToday> {
  return withTiming("pnl.affiliateReferredToday", async () => {
    const now = new Date();
    const since = utcStartOfDay(now);
    const sinceIso = since.toISOString();
    // YYYY-MM-DD in UTC — stable cache key for "today" that rolls at 00:00 UTC.
    const dayKey = sinceIso.slice(0, 10);
    const excluded = await getExcludedUserIds();

    const pnl = await cachedAffiliateReferredPnlToday(dayKey, sinceIso, excluded);
    return { pnl, dayStartIso: sinceIso };
  });
}
