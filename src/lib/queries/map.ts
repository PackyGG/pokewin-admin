import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "./_blacklist";

export type Period = "today" | "7d" | "30d" | "90d" | "all";

const periodToDays: Record<Exclude<Period, "all" | "today">, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
};

/**
 * UTC start-of-current-day boundary. The "Today" chip means the CURRENT
 * CALENDAR DAY since midnight UTC, NOT a rolling past-24h window — same
 * convention as `dashboard-today-pnl.ts` and `src/lib/queries/analytics.ts`.
 */
function utcStartOfDay(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

// Hardcoded values — no injection risk when used with $queryRawUnsafe.
// `today` binds an ISO timestamp literal cast to timestamptz so the window
// is "since midnight UTC today", not a rolling 24-hour interval.
function periodToDateFilter(period: Period): string {
  if (period === "all") return "";
  if (period === "today") {
    return `AND created_at >= '${utcStartOfDay().toISOString()}'::timestamptz`;
  }
  const days = periodToDays[period];
  return `AND created_at >= NOW() - INTERVAL '${days} days'`;
}

export type CountryUserCount = {
  country_code: string; // ISO 3166-1 alpha-2
  country: string | null;
  user_count: number;
  // Financial aggregates (in selected period) — all optional so countries
  // with no tx activity still render on the map.
  total_deposits: number;
  deposit_count: number;
  total_wager: number;
};

export type MapData = {
  byCountry: CountryUserCount[];
  totalUsers: number;
  withoutLocation: number;
};

/**
 * Aggregates real users (staff + excluded-users blacklist dropped) by
 * country_code for the map view. Users without country_code are counted
 * separately (not plotted on the map).
 */
async function computeUsersByCountry(
  period: Period,
  excluded: string[],
): Promise<MapData> {
  const db = await getDb();
  const dateFilter = periodToDateFilter(period);
  const blacklistFragment = blacklistNotInClause("id", excluded);
  const userScope = `role NOT IN ('admin', 'support') ${blacklistFragment}`;
  // Join-scoped variant for the financials query: it joins
  // ledger_transactions (which also has an `id` column), so the blacklist
  // column must be alias-qualified. The previous `WHERE u.${userScope}`
  // only qualified `role` — the fragment's bare `id NOT IN (...)` was
  // ambiguous (Postgres 42702) and threw whenever the excluded-users
  // blacklist was non-empty, killing the whole map tab.
  const userScopeJoined = `u.role NOT IN ('admin', 'support') ${blacklistNotInClause("u.id", excluded)}`;

  // dateFilter above is phrased as "AND created_at >= ...", works for both
  // u.created_at (signups) and lt.created_at (tx) because each query
  // unambiguously owns the column name. For the tx query we re-derive the
  // boundary on lt.created_at so the period semantics stay consistent —
  // `today` anchored at midnight UTC, the others rolling N days.
  // The financials leg joins ledger_transactions (heavy). Lifetime (`all`)
  // is capped at 365d here so it bounds the ledger scan instead of an
  // unbounded full-history sweep (CLAUDE.md "Performance & Daten-Laden";
  // mirrors the reward-side INSIGHTS_LIFETIME_LOOKBACK_DAYS). The signup
  // user-count leg (dateFilter above) stays lifetime — it scans the much
  // smaller users table, not the ledger.
  const txDateFilter =
    period === "all"
      ? "AND lt.created_at >= NOW() - INTERVAL '365 days'"
      : period === "today"
        ? `AND lt.created_at >= '${utcStartOfDay().toISOString()}'::timestamptz`
        : `AND lt.created_at >= NOW() - INTERVAL '${periodToDays[period]} days'`;

  const [byCountryRaw, financialsRaw, totalRaw, withoutLocationRaw] =
    await Promise.all([
      db.$queryRawUnsafe<
        Array<{
          country_code: string;
          country: string | null;
          user_count: string;
        }>
      >(`
        SELECT
          country_code,
          MAX(country) AS country,
          COUNT(*)::text AS user_count
        FROM "user"
        WHERE ${userScope}
          AND country_code IS NOT NULL
          ${dateFilter}
        GROUP BY country_code
        ORDER BY COUNT(*) DESC
      `),
      // Per-country deposit/wager aggregates, filtered by transaction date
      // in the same period. Users without a country_code are ignored.
      db.$queryRawUnsafe<
        Array<{
          country_code: string;
          total_deposits: string;
          deposit_count: string;
          total_wager: string;
        }>
      >(`
        SELECT
          u.country_code,
          COALESCE(SUM(CASE WHEN lt.type::text = 'deposit' AND lt.status = 'completed' THEN ABS(lt.amount::numeric) ELSE 0 END), 0)::text AS total_deposits,
          COUNT(*) FILTER (WHERE lt.type::text = 'deposit' AND lt.status = 'completed')::text AS deposit_count,
          COALESCE(SUM(CASE WHEN lt.type::text IN ('pack_opening','battle_bet','battle_sponsorship','upgrader_bet') AND lt.status = 'completed' THEN ABS(lt.amount::numeric) ELSE 0 END), 0)::text AS total_wager
        FROM "user" u
        INNER JOIN ledger_transactions lt ON lt.user_id = u.id
        WHERE ${userScopeJoined}
          AND u.country_code IS NOT NULL
          ${txDateFilter}
        GROUP BY u.country_code
      `),
      db.$queryRawUnsafe<Array<{ total: string }>>(`
        SELECT COUNT(*)::text AS total
        FROM "user"
        WHERE ${userScope}
          ${dateFilter}
      `),
      db.$queryRawUnsafe<Array<{ total: string }>>(`
        SELECT COUNT(*)::text AS total
        FROM "user"
        WHERE ${userScope}
          AND country_code IS NULL
          ${dateFilter}
      `),
    ]);

  const financialsMap = new Map(
    financialsRaw.map((f) => [
      f.country_code,
      {
        total_deposits: Number(f.total_deposits),
        deposit_count: Number(f.deposit_count),
        total_wager: Number(f.total_wager),
      },
    ]),
  );

  return {
    byCountry: byCountryRaw.map((r) => {
      const fin = financialsMap.get(r.country_code);
      return {
        country_code: r.country_code,
        country: r.country,
        user_count: Number(r.user_count),
        total_deposits: fin?.total_deposits ?? 0,
        deposit_count: fin?.deposit_count ?? 0,
        total_wager: fin?.total_wager ?? 0,
      };
    }),
    totalUsers: Number(totalRaw[0]?.total ?? "0"),
    withoutLocation: Number(withoutLocationRaw[0]?.total ?? "0"),
  };
}

/**
 * Cross-request cache for the map's per-country aggregate. `/analytics` →
 * Map tab re-runs on every 5-minute `AutoRefresh` tick for every viewer;
 * without a shared cache the 4-query country/financials batch re-ran per
 * tick per viewer. Two `unstable_cache` layers — 60s for the finite windows,
 * 300s for the lifetime view — both keyed on `(period, sortedBlacklist)`.
 * Logic identical to `computeUsersByCountry`; mirrors the `getAnalyticsData`
 * cache idiom in `analytics.ts`.
 *
 * NOTE: the `all` window is still an UNBOUNDED lifetime scan over `user` +
 * `ledger_transactions` (money-exact per-country totals — capping would
 * change displayed numbers, so it is left for owner sign-off). The cache +
 * the caller's `safeQuery` timeout keep a cold lifetime fill from hanging.
 */
const cachedUsersByCountry = unstable_cache(
  computeUsersByCountry,
  ["analytics-map-users-by-country-v1"],
  { revalidate: 60, tags: ["analytics"] },
);

const cachedUsersByCountryLifetime = unstable_cache(
  computeUsersByCountry,
  ["analytics-map-users-by-country-lifetime-v1"],
  { revalidate: 300, tags: ["analytics"] },
);

export async function getUsersByCountry(period: Period): Promise<MapData> {
  const blacklist = await getExcludedUserIds();
  const sorted = [...blacklist].sort();
  return period === "all"
    ? cachedUsersByCountryLifetime(period, sorted)
    : cachedUsersByCountry(period, sorted);
}
