import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { RewardsForecasting } from "@/lib/queries/insights-rewards/forecasting";

import {
  FORECAST_HISTORY_DAYS,
  getRewardsForecastingAggregatesFromClickHouse,
  type ForecastAggregateRow,
} from "../queries/insights-rewards/forecasting";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the /insights/forecast (rewards forecast tab)
 * surface (Phase 2B). No-op unless the `insights_forecast` surface is in
 * `comparison` mode (forced off whenever ClickHouse is dormant).
 *
 * Per the Phase 2B split, ONLY the DB-read aggregate moved to ClickHouse; the
 * pure-TS projection layer stays shared on the Postgres side. So this comparison
 * applies the SAME deterministic transform — zero-fill onto the UTC date axis,
 * net-rain fold into the rainRace series, trailing 7-day average — to BOTH the
 * Postgres result (re-derived from `RewardsForecasting.rows[].dailyHistory`,
 * which the projection already produced) and the ClickHouse raw aggregate, then
 * diffs the per-category window total + trailing-7d average (money, half-cent
 * tolerance) plus the active-category count (exact). Logged drift therefore
 * reflects engine / CDC-lag only, never a math change.
 *
 * The newest (today) bucket is inherently CDC-lag sensitive — a reward booked in
 * Postgres seconds ago may not be in the mirror yet, so a few cents of transient
 * drift on the freshest day is replication lag, not a definition bug. Swallows
 * every error via `logError` so the served Postgres payload is never affected.
 */

const CATEGORY_KEYS = [
  "bonuses",
  "rakeback",
  "affiliate",
  "rainRace",
  "signupPack",
  "waitlist",
] as const;
type CategoryKey = (typeof CATEGORY_KEYS)[number];

// Mirrors `TRAILING_AVG_DAYS` in the PG twin.
const TRAILING_AVG_DAYS = 7;

const MONEY_FIELDS = CATEGORY_KEYS.flatMap((k) => [`${k}Total`, `${k}Avg7`]);

/**
 * Build the trailing UTC date axis [today-(N-1) … today] exactly as the PG
 * projection layer does (`computeForecasting`): N entries, today inclusive, UTC
 * midnight stepping. Days outside this axis are dropped from the comparison just
 * as the PG zero-fill drops them from `dailyHistory`.
 */
function buildAxis(now: Date): string[] {
  const today = new Date(now);
  today.setUTCHours(0, 0, 0, 0);
  const axis: string[] = [];
  for (let i = FORECAST_HISTORY_DAYS - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    axis.push(d.toISOString().split("T")[0]);
  }
  return axis;
}

/**
 * Fold the ClickHouse raw aggregate into per-category per-day series, mirroring
 * the PG projection: the `__rain_win` / `__rain_tip` pseudo-buckets are netted
 * per day to the house slice `max(0, rain_win − rain_tip)` and folded into the
 * rainRace series (alongside any race_prize), identical to
 * `resolveRainHouseCost({ kind: "net" })`.
 */
function chSeries(
  rows: ForecastAggregateRow[],
  axisSet: Set<string>,
): Map<CategoryKey, Map<string, number>> {
  const series = new Map<CategoryKey, Map<string, number>>();
  const rainByDay = new Map<string, { win: number; tip: number }>();
  for (const r of rows) {
    if (!axisSet.has(r.date)) continue;
    if (r.category === "__rain_win") {
      const e = rainByDay.get(r.date) ?? { win: 0, tip: 0 };
      e.win += r.total;
      rainByDay.set(r.date, e);
      continue;
    }
    if (r.category === "__rain_tip") {
      const e = rainByDay.get(r.date) ?? { win: 0, tip: 0 };
      e.tip += r.total;
      rainByDay.set(r.date, e);
      continue;
    }
    if (!(CATEGORY_KEYS as readonly string[]).includes(r.category)) continue;
    const key = r.category as CategoryKey;
    const m = series.get(key) ?? new Map<string, number>();
    m.set(r.date, (m.get(r.date) ?? 0) + r.total);
    series.set(key, m);
  }
  if (rainByDay.size > 0) {
    const rainRace = series.get("rainRace") ?? new Map<string, number>();
    for (const [day, legs] of rainByDay) {
      const net = Math.max(0, legs.win - legs.tip);
      if (net > 0) rainRace.set(day, (rainRace.get(day) ?? 0) + net);
    }
    series.set("rainRace", rainRace);
  }
  return series;
}

function chComparable(
  rows: ForecastAggregateRow[],
  axis: string[],
): Record<string, number> {
  const series = chSeries(rows, new Set(axis));
  const rec: Record<string, number> = {};
  let active = 0;
  for (const key of CATEGORY_KEYS) {
    const m = series.get(key) ?? new Map<string, number>();
    const daily = axis.map((d) => m.get(d) ?? 0);
    const total = daily.reduce((a, b) => a + b, 0);
    const trailing = daily.slice(-TRAILING_AVG_DAYS);
    const avg7 =
      trailing.length > 0
        ? trailing.reduce((a, b) => a + b, 0) / trailing.length
        : 0;
    rec[`${key}Total`] = total;
    rec[`${key}Avg7`] = avg7;
    if (total > 0) active++;
  }
  rec.activeCategories = active;
  return rec;
}

function pgComparable(pg: RewardsForecasting): Record<string, number> {
  const rec: Record<string, number> = {};
  let active = 0;
  for (const key of CATEGORY_KEYS) {
    const row = pg.rows.find((r) => r.key === key);
    const total = row
      ? row.dailyHistory.reduce((a, p) => a + p.total, 0)
      : 0;
    const avg7 = row ? row.trailingSevenAvg : 0;
    rec[`${key}Total`] = total;
    rec[`${key}Avg7`] = avg7;
    if (total > 0) active++;
  }
  rec.activeCategories = active;
  return rec;
}

export async function compareForecast(
  pgValues: RewardsForecasting,
): Promise<void> {
  try {
    const mode = await getAdminReadMode("insights_forecast");
    if (mode !== "comparison") return;

    const now = new Date();
    const axis = buildAxis(now);

    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getRewardsForecastingAggregatesFromClickHouse(blacklist, now);
    });

    const drift = computeDrift(
      pgComparable(pgValues),
      chComparable(ch, axis),
      MONEY_FIELDS,
    );
    logComparison("insights_forecast", drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.insights_forecast",
      "comparison failed (ignored)",
      err,
    );
  }
}
