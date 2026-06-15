import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import {
  daysForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import type { MothaGiveawayOverview } from "@/lib/queries/insights-rewards/motha/overview";

import { CH_DB, chDateTime, toNumber } from "../../_shared";

/**
 * ClickHouse twin of `getMothaGiveawayOverview`
 * (`src/lib/queries/insights-rewards/motha/overview.ts`).
 *
 * PARITY: the founder giveaway account's OUTFLOW across its three funding
 * channels over the active window — `creator_tip` + `battle_sponsorship`
 * (completed `public_ledger_transactions` debited TO motha) and motha-funded
 * `public_rain_tips`. Money is summed via `abs(...)` in every channel; the
 * volume anchor is the count of DISTINCT ACTIVE DAYS motha gave away on across
 * all three channels. Returns the SAME `MothaGiveawayOverview` shape; the avg
 * (`totalCost / count`) and the cross-channel `max` are derived in TS with the
 * IDENTICAL arithmetic the PG twin uses.
 *
 * SCOPE (mirrors PG EXACTLY): scoped to `user_id = motha`, resolved by
 * `lower(username) = 'motha'`. This is the OUTFLOW of one specific account, so
 * it deliberately does NOT apply the staff/creator/blacklist exclusion (motha
 * IS the subject being measured, not a customer). No role scope, no blacklist.
 *
 * CH correctness: FINAL + `_peerdb_is_deleted = 0` on every table, money kept
 * Decimal (`toString(sum(...))` → `toNumber`, never Float), scale-matched zero
 * branch (`toDecimal128(0, 2)`). The window cutoff derives from a single
 * caller-supplied `now` via `daysForInsightsPeriod` — matching the PG
 * `NOW() - INTERVAL 'N days'` arithmetic (prod runs UTC). Lifetime (`all`)
 * drops the lower bound exactly as PG does (a single tiny account slice — no
 * lookback cap, mirroring the PG twin which also leaves it unbounded).
 */

const MOTHA_USERNAME = "motha";
const DAY_MS = 24 * 60 * 60 * 1000;

const EMPTY: MothaGiveawayOverview = {
  totalCost: 0,
  count: 0,
  uniqueClaimants: 0,
  avg: 0,
  max: 0,
  byChannel: { tips: 0, rain: 0, sponsorship: 0 },
  countByChannel: { tips: 0, rain: 0, sponsorship: 0 },
};

type LedgerRow = {
  tips_total: string;
  tips_cnt: string;
  sponsorship_total: string;
  sponsorship_cnt: string;
  max_amount: string;
};

type RainRow = {
  rain_total: string;
  rain_cnt: string;
  max_amount: string;
};

type DaysRow = { active_days: string };

export async function getMothaGiveawayOverviewFromClickHouse(
  period: InsightsRewardsPeriod,
  now: Date = new Date(),
): Promise<MothaGiveawayOverview> {
  // Resolve motha's user id once (case-insensitive). No account → empty
  // baseline, matching the PG twin's clean empty state.
  const idRows = await clickhouseRead.query<{ id: string }>({
    queryName: "insights.rewards.motha.overview.id",
    sql: `
      SELECT id
      FROM ${CH_DB}.public_user FINAL
      WHERE _peerdb_is_deleted = 0
        AND lower(username) = {username:String}
      LIMIT 1`,
    params: { username: MOTHA_USERNAME },
  });
  const mothaId = idRows[0]?.id;
  if (!mothaId) return EMPTY;

  const days = daysForInsightsPeriod(period);
  const params: Record<string, unknown> = { mothaId };
  let ledgerDateClause = "";
  let rainDateClause = "";
  if (days !== null) {
    params.cutoff = chDateTime(new Date(now.getTime() - days * DAY_MS));
    ledgerDateClause = "AND lt.created_at >= {cutoff:DateTime64(6)}";
    rainDateClause = "AND rt.created_at >= {cutoff:DateTime64(6)}";
  }

  const [ledgerRows, rainRows, dayRows] = await Promise.all([
    clickhouseRead.query<LedgerRow>({
      queryName: "insights.rewards.motha.overview.ledger",
      sql: `
        SELECT
          toString(sum(if(lt.type = 'creator_tip', abs(lt.amount), toDecimal128(0, 2))))        AS tips_total,
          toString(countIf(lt.type = 'creator_tip'))                                            AS tips_cnt,
          toString(sum(if(lt.type = 'battle_sponsorship', abs(lt.amount), toDecimal128(0, 2)))) AS sponsorship_total,
          toString(countIf(lt.type = 'battle_sponsorship'))                                     AS sponsorship_cnt,
          toString(max(abs(lt.amount)))                                                         AS max_amount
        FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
        WHERE lt._peerdb_is_deleted = 0
          AND lt.status = 'completed'
          AND lt.user_id = {mothaId:String}
          AND lt.type IN ('creator_tip', 'battle_sponsorship')
          ${ledgerDateClause}`,
      params,
    }),
    clickhouseRead.query<RainRow>({
      queryName: "insights.rewards.motha.overview.rain",
      sql: `
        SELECT
          toString(sum(abs(rt.amount_usd))) AS rain_total,
          toString(count())                 AS rain_cnt,
          toString(max(abs(rt.amount_usd))) AS max_amount
        FROM ${CH_DB}.public_rain_tips AS rt FINAL
        WHERE rt._peerdb_is_deleted = 0
          AND rt.user_id = {mothaId:String}
          ${rainDateClause}`,
      params,
    }),
    clickhouseRead.query<DaysRow>({
      queryName: "insights.rewards.motha.overview.days",
      sql: `
        SELECT toString(uniqExact(d)) AS active_days
        FROM (
          SELECT toDate(lt.created_at) AS d
          FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
          WHERE lt._peerdb_is_deleted = 0
            AND lt.status = 'completed'
            AND lt.user_id = {mothaId:String}
            AND lt.type IN ('creator_tip', 'battle_sponsorship')
            ${ledgerDateClause}
          UNION ALL
          SELECT toDate(rt.created_at) AS d
          FROM ${CH_DB}.public_rain_tips AS rt FINAL
          WHERE rt._peerdb_is_deleted = 0
            AND rt.user_id = {mothaId:String}
            ${rainDateClause}
        )`,
      params,
    }),
  ]);

  const lr = ledgerRows[0];
  const rr = rainRows[0];

  const tips = toNumber(lr?.tips_total);
  const sponsorship = toNumber(lr?.sponsorship_total);
  const rain = toNumber(rr?.rain_total);
  const tipsCnt = Number(lr?.tips_cnt ?? 0);
  const sponsorshipCnt = Number(lr?.sponsorship_cnt ?? 0);
  const rainCnt = Number(rr?.rain_cnt ?? 0);

  const totalCost = tips + rain + sponsorship;
  const count = tipsCnt + rainCnt + sponsorshipCnt;
  const avg = count > 0 ? totalCost / count : 0;
  const max = Math.max(
    lr?.max_amount != null ? toNumber(lr.max_amount) : 0,
    rr?.max_amount != null ? toNumber(rr.max_amount) : 0,
  );
  const uniqueClaimants = Number(dayRows[0]?.active_days ?? 0);

  return {
    totalCost,
    count,
    uniqueClaimants,
    avg,
    max,
    byChannel: { tips, rain, sponsorship },
    countByChannel: { tips: tipsCnt, rain: rainCnt, sponsorship: sponsorshipCnt },
  };
}
