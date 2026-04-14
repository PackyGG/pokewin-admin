import { db } from "@/lib/db";

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
  const dateFilter = periodToDateFilter(period);
  const staffFilter = `role NOT IN ('admin', 'creator')`;

  const [byCountryRaw, totalRaw, withoutLocationRaw] = await Promise.all([
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

  return {
    byCountry: byCountryRaw.map((r) => ({
      country_code: r.country_code,
      country: r.country,
      user_count: Number(r.user_count),
    })),
    totalUsers: Number(totalRaw[0]?.total ?? "0"),
    withoutLocation: Number(withoutLocationRaw[0]?.total ?? "0"),
  };
}
