import { blacklistNotInSql, daysAgoFilter, queryRows, sql } from "@/lib/queries/insights-rewards/_drizzle-query";
import { unstable_cache } from "next/cache";
import { getReadDrizzleDb } from "@/lib/db";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { toNumber } from "@/lib/utils/decimal";
import {
  daysForInsightsPeriod,
  cacheTtlForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import { SIGNUP_CACHE_TAG } from "./_shared";

/**
 * Hour-of-day + day-of-week temporal patterns for
 * /insights/rewards/signup.
 *
 * Returns three series, all computed off cohort users'
 * `balance_reward_claim` events (signup-cohort restricted):
 *
 *   1. hourly       — 24-bin histogram of claim events by hour (UTC)
 *   2. dayOfWeek    — 7-bin histogram of claim events by day of week
 *                     (0=Sunday, 1=Monday, …, 6=Saturday — matches
 *                     PostgreSQL `EXTRACT(DOW)`)
 *   3. heatmap      — 7 days × 24 hours = 168 cells with claim count
 *                     + volume per cell, for the day-of-week heatmap
 *
 * Time bins are UTC for consistency with the rest of the admin
 * dashboard. The heatmap doubles up as the ops scheduling signal —
 * shows when bonus-claim spikes happen.
 */

export type HourOfDayBucket = {
  /** "00"–"23" as a zero-padded label. */
  label: string;
  count: number;
  volume: number;
};

export type DayOfWeekBucket = {
  /** "Sun"–"Sat" as the label. */
  label: string;
  /** 0=Sun, 6=Sat. */
  index: number;
  count: number;
  volume: number;
};

export type HeatmapCell = {
  dow: number;
  hour: number;
  count: number;
  volume: number;
};

export type HourOfDay = {
  hourly: HourOfDayBucket[];
  dayOfWeek: DayOfWeekBucket[];
  heatmap: HeatmapCell[];
};

const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

async function computeHourOfDay(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<HourOfDay> {
  const db = await getReadDrizzleDb();
  const days = daysForInsightsPeriod(period);
  const signupDateFilter = daysAgoFilter("u.created_at", days);
  const blacklistJoin = blacklistNotInSql("u.id", blacklistIds);

  // One sweep over the heatmap (dow × hour) gives us all three series
  // — the hour-of-day and day-of-week marginals are just sums over
  // the heatmap matrix on the JS side. Cheaper than three SQL queries.
  type Row = { dow: number; hour: number; cnt: string; volume: string };
  const rows = await queryRows<Row[]>(db, sql`
    WITH cohort AS (
      SELECT u.id AS user_id
      FROM "user" u
      WHERE u.role NOT IN ('admin', 'support') ${blacklistJoin}
        ${signupDateFilter}
    )
    SELECT
      EXTRACT(DOW FROM lt.created_at)::int AS dow,
      EXTRACT(HOUR FROM lt.created_at)::int AS hour,
      COUNT(*)::text AS cnt,
      COALESCE(SUM(ABS(lt.amount::numeric)), 0)::text AS volume
    FROM ledger_transactions lt
    JOIN cohort c ON c.user_id = lt.user_id
    WHERE lt.status = 'completed'
      AND lt.type::text = 'balance_reward_claim'
    GROUP BY 1, 2
    ORDER BY 1, 2
  `);

  // Heatmap — pre-fill 7 × 24 grid so empty cells still render.
  const heatmap: HeatmapCell[] = [];
  for (let dow = 0; dow < 7; dow++) {
    for (let hour = 0; hour < 24; hour++) {
      heatmap.push({ dow, hour, count: 0, volume: 0 });
    }
  }
  const heatmapByKey = new Map<string, HeatmapCell>();
  for (const cell of heatmap) {
    heatmapByKey.set(`${cell.dow}:${cell.hour}`, cell);
  }
  for (const r of rows) {
    const key = `${Number(r.dow)}:${Number(r.hour)}`;
    const cell = heatmapByKey.get(key);
    if (cell) {
      cell.count += Number(r.cnt);
      cell.volume += toNumber(r.volume);
    }
  }

  // Marginals: hour-of-day across all dow + day-of-week across all hours.
  const hourly: HourOfDayBucket[] = Array.from({ length: 24 }, (_, h) => ({
    label: h.toString().padStart(2, "0"),
    count: 0,
    volume: 0,
  }));
  const dayOfWeek: DayOfWeekBucket[] = Array.from({ length: 7 }, (_, d) => ({
    label: DOW_LABELS[d],
    index: d,
    count: 0,
    volume: 0,
  }));
  for (const cell of heatmap) {
    hourly[cell.hour].count += cell.count;
    hourly[cell.hour].volume += cell.volume;
    dayOfWeek[cell.dow].count += cell.count;
    dayOfWeek[cell.dow].volume += cell.volume;
  }

  return { hourly, dayOfWeek, heatmap };
}

const cachedShort = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeHourOfDay(period, blacklistIds),
  ["insights-rewards-signup-hour-of-day-v1"],
  { revalidate: 60, tags: [SIGNUP_CACHE_TAG] },
);

const cachedLong = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeHourOfDay(period, blacklistIds),
  ["insights-rewards-signup-hour-of-day-lifetime-v1"],
  { revalidate: 300, tags: [SIGNUP_CACHE_TAG] },
);

export async function getSignupHourOfDay(
  period: InsightsRewardsPeriod,
): Promise<HourOfDay> {
  const blacklist = await getExcludedUserIds();
  const sorted = [...blacklist].sort();
  const data = await (cacheTtlForInsightsPeriod(period) >= 300
    ? cachedLong(period, sorted)
    : cachedShort(period, sorted));
  return data;
}
