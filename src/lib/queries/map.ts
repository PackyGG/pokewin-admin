import { getDb } from "@/lib/db";

export type Period = "today" | "7d" | "30d" | "90d" | "all";

const periodToDays: Record<Exclude<Period, "all">, number> = {
  today: 1,
  "7d": 7,
  "30d": 30,
  "90d": 90,
};

// Hardcoded values — no injection risk when used with $queryRawUnsafe
function periodToDateFilter(period: Period): string {
  if (period === "all") return "";
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
 * Aggregates real users (staff excluded) by country_code for the map view.
 * Staff = role IN ('admin','creator') per the project-wide analytics convention.
 * Users without country_code are counted separately (not plotted on the map).
 */
export async function getUsersByCountry(period: Period): Promise<MapData> {
  const db = await getDb();
  const dateFilter = periodToDateFilter(period);
  const staffFilter = `role NOT IN ('admin', 'support')`;

  // dateFilter above is phrased as "AND created_at >= ...", works for both
  // u.created_at (signups) and lt.created_at (tx) because each query
  // unambiguously owns the column name. For the tx query we rename it.
  const txDateFilter =
    period === "all"
      ? ""
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
        WHERE ${staffFilter}
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
          COALESCE(SUM(CASE WHEN lt.type = 'deposit' AND lt.status = 'completed' THEN ABS(lt.amount::numeric) ELSE 0 END), 0)::text AS total_deposits,
          COUNT(*) FILTER (WHERE lt.type = 'deposit' AND lt.status = 'completed')::text AS deposit_count,
          COALESCE(SUM(CASE WHEN lt.type IN ('pack_opening','battle_bet','battle_sponsorship','upgrader_bet') AND lt.status = 'completed' THEN ABS(lt.amount::numeric) ELSE 0 END), 0)::text AS total_wager
        FROM "user" u
        INNER JOIN ledger_transactions lt ON lt.user_id = u.id
        WHERE u.${staffFilter}
          AND u.country_code IS NOT NULL
          ${txDateFilter}
        GROUP BY u.country_code
      `),
      db.$queryRawUnsafe<Array<{ total: string }>>(`
        SELECT COUNT(*)::text AS total
        FROM "user"
        WHERE ${staffFilter}
          ${dateFilter}
      `),
      db.$queryRawUnsafe<Array<{ total: string }>>(`
        SELECT COUNT(*)::text AS total
        FROM "user"
        WHERE ${staffFilter}
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
