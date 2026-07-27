import "server-only";

import { unstable_cache } from "next/cache";

import { readDrizzleForEnv } from "@/lib/db";
import { queryRowsInTimeboxedTx } from "@/lib/drizzle-query";
import { readDbEnv, type DbEnv } from "@/lib/db-env";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { escapeBlacklistIds } from "@/lib/queries/_blacklist";
import {
  COVERING_CREATOR_SQL,
  CREATOR_PNL_STATEMENT_TIMEOUT_MS,
  WITHDRAWN_UNITS_SQL,
} from "@/lib/queries/creators-pnl";
import { toNumber } from "@/lib/utils/decimal";
import type { FrameWindow } from "./frame-wager-by-user";

/**
 * "Affiliates made us" per creator, summed strictly INSIDE each creator's
 * own deal frame `[start, end]` — the SAME coverage-attributed cohort
 * methodology the creator-detail "Creator Net (P&L)" box uses
 * (`getCreatorPnl` in creators-pnl.ts), only windowed to the deal frame
 * instead of the fixed 24h/…/365d windows.
 *
 *   affiliatesMadeUs = depositsInFrame − cardWithdrawalsInFrame
 *                      − affiliateClaimsInFrame
 *
 * where, for a creator C:
 *   • depositsInFrame  — ledger deposits whose covering creator at deposit
 *     time (most-recent acu row within the backend's 7-day coverage window)
 *     is C, with `created_at` inside C's frame. Staff/creator-role +
 *     blacklist excluded; C's own deposits excluded. Mirrors `attr_dep`.
 *   • cardWithdrawalsInFrame — withdrawn value-units (cards + session-linked
 *     vouchers, house-liability statuses) with `withdrawn_at` inside C's
 *     frame, belonging to one of C's coverage-depositors AND traced to one
 *     of C's wager sessions. Mirrors `attr_wd` (lifetime semantics).
 *   • affiliateClaimsInFrame — C's OWN `affiliate_claim` ledger credits
 *     (completed) claimed inside C's frame: the code earnings we pay the
 *     creator, a direct house cost of the deal.
 *
 * COHORT MEMBERSHIP (who counts as C's affiliate) is the 365-day
 * coverage-depositor + wager-session set — exactly the lifetime block of
 * `getCreatorPnl` (so a frame spanning a full year reconciles with the
 * "Creator Net" lifetime figure). Only the deposit/withdrawal EVENT times
 * are narrowed to the frame; membership stays on the lifetime sets so a
 * card withdrawn during the deal still attributes even when the producing
 * wager / first deposit predates the frame.
 *
 * One batched scan covers the whole roster: per-creator `[start, end]`
 * bounds arrive via a VALUES list (same shape as `getFrameWagerByUser`).
 * It is the heaviest read on the Profitability page (the correlated
 * coverage subquery runs once per deposit row across the widest window), so
 * it runs inside a transaction with a raised per-statement timeout — the
 * same cold-scan-completion guard `getCreatorPnl` uses — and is cached.
 *
 * MAIN/prod game DB is READ-ONLY; this only SELECTs.
 */

const LIFETIME_LOOKBACK_DAYS = 365;

type FrameAffiliatePnl = {
  /**
   * depositsInFrame − cardWithdrawalsInFrame − affiliateClaimsInFrame
   * (house POV: + = we kept value). The affiliate-claim leg is the creator's
   * OWN `affiliate_claim` code earnings claimed inside the frame — a direct
   * house cost of running their code.
   */
  affiliatesMadeUs: number;
  deposits: number;
  cardWithdrawals: number;
  /** Creator's own affiliate_claim code earnings claimed inside the frame. */
  affiliateClaims: number;
};

const cachedFramePnl = (
  env: DbEnv,
  frames: FrameWindow[],
  blacklistIds: string[],
) =>
  unstable_cache(
    async (): Promise<[string, FrameAffiliatePnl][]> => {
      const db = readDrizzleForEnv(env);

      const tuples: string[] = [];
      const params: unknown[] = [];
      frames.forEach((f, i) => {
        const b = i * 3;
        tuples.push(
          `($${b + 1}::text, $${b + 2}::timestamptz, $${b + 3}::timestamptz)`,
        );
        params.push(f.userId, f.startIso, f.endIso);
      });

      // Blacklist is inlined (resolved ids, already in the cache key). The
      // deposit cohort excludes blacklisted users; the depositor-membership
      // set deliberately does NOT (mirrors `cov_depositors_raw`).
      const blacklistDepAnd =
        blacklistIds.length > 0
          ? ` AND dr.user_id NOT IN (${escapeBlacklistIds(blacklistIds)})`
          : "";
      const blacklistSessAnd =
        blacklistIds.length > 0
          ? ` AND u.id NOT IN (${escapeBlacklistIds(blacklistIds)})`
          : "";

      const sql = `WITH frames(cid, start_ts, end_ts) AS (
          VALUES ${tuples.join(", ")}
        ),
        bounds AS (
          SELECT MIN(start_ts) AS min_start, MAX(end_ts) AS max_end FROM frames
        ),
        -- Coverage-attributed deposits over the widest window we need
        -- (frame span ∪ the 365d membership lookback). The correlated
        -- coverage subquery is evaluated once per deposit row here.
        dep_raw AS (
          SELECT lt.user_id,
                 lt.created_at,
                 lt.amount::numeric AS amount,
                 u.role::text AS role,
                 ${COVERING_CREATOR_SQL} AS creator_id
            FROM ledger_transactions lt
            JOIN "user" u ON u.id = lt.user_id
           WHERE lt.type::text = 'deposit'
             AND lt.status = 'completed'
             AND lt.created_at >= LEAST(
                   (SELECT min_start FROM bounds),
                   NOW() - INTERVAL '${LIFETIME_LOOKBACK_DAYS} days'
                 )
             AND lt.created_at <= (SELECT max_end FROM bounds)
        ),
        -- Deposits INSIDE the frame, staff/creator + blacklist excluded,
        -- creator's own deposits excluded (mirrors attr_dep).
        dep AS (
          SELECT f.cid AS creator_id,
                 COALESCE(SUM(dr.amount), 0) AS deposits
            FROM dep_raw dr
            JOIN frames f
              ON f.cid = dr.creator_id
             AND dr.created_at >= f.start_ts
             AND dr.created_at <= f.end_ts
           WHERE dr.creator_id IS NOT NULL
             AND dr.user_id <> dr.creator_id
             AND dr.role NOT IN ('admin', 'support', 'creator')${blacklistDepAnd}
           GROUP BY f.cid
        ),
        -- Coverage-depositor membership over 365d (mirrors cov_depositors_raw:
        -- no staff/blacklist filter).
        deptors AS (
          SELECT DISTINCT dr.creator_id, dr.user_id
            FROM dep_raw dr
            JOIN frames f ON f.cid = dr.creator_id
           WHERE dr.creator_id IS NOT NULL
             AND dr.created_at >= NOW() - INTERVAL '${LIFETIME_LOOKBACK_DAYS} days'
        ),
        -- Creator's wager-session membership over 365d (mirrors creator_sessions).
        sess AS (
          SELECT DISTINCT acu.affiliate_user_id AS creator_id,
                 acu.game_session_id
            FROM affiliate_code_usages acu
            JOIN "user" u ON u.id = acu.referred_user_id
            JOIN frames f ON f.cid = acu.affiliate_user_id
           WHERE acu.usage_type::text = 'wager'
             AND acu.game_session_id IS NOT NULL
             AND acu.created_at >= NOW() - INTERVAL '${LIFETIME_LOOKBACK_DAYS} days'
             AND u.role NOT IN ('admin', 'support', 'creator')
             AND u.id <> acu.affiliate_user_id${blacklistSessAnd}
        ),
        -- Withdrawn units INSIDE the frame for cohort members via cohort
        -- sessions (mirrors attr_wd, lifetime semantics: no outer-user filter).
        wd AS (
          SELECT f.cid AS creator_id,
                 COALESCE(SUM(wu.value), 0) AS card_withdrawals
            FROM ${WITHDRAWN_UNITS_SQL} wu
            JOIN frames f
              ON wu.withdrawn_at >= f.start_ts
             AND wu.withdrawn_at <= f.end_ts
            JOIN deptors dp ON dp.creator_id = f.cid AND dp.user_id = wu.user_id
            JOIN sess s ON s.creator_id = f.cid AND s.game_session_id = wu.source_id
           GROUP BY f.cid
        ),
        -- Creator's OWN affiliate_claim code earnings claimed INSIDE the
        -- frame. affiliate_claim credits the creator (amount > 0, same column
        -- convention as deposits) and is a direct house cost of the deal.
        claims AS (
          SELECT f.cid AS creator_id,
                 COALESCE(SUM(lt.amount::numeric), 0) AS affiliate_claims
            FROM ledger_transactions lt
            JOIN frames f
              ON f.cid = lt.user_id
             AND lt.created_at >= f.start_ts
             AND lt.created_at <= f.end_ts
           WHERE lt.type::text = 'affiliate_claim'
             AND lt.status = 'completed'
           GROUP BY f.cid
        )
        SELECT f.cid AS creator_id,
               COALESCE(d.deposits, 0)::text AS deposits,
               COALESCE(w.card_withdrawals, 0)::text AS card_withdrawals,
               COALESCE(cl.affiliate_claims, 0)::text AS affiliate_claims
          FROM frames f
          LEFT JOIN dep d ON d.creator_id = f.cid
          LEFT JOIN wd w ON w.creator_id = f.cid
          LEFT JOIN claims cl ON cl.creator_id = f.cid`;

      const rows = await queryRowsInTimeboxedTx(
        db,
        CREATOR_PNL_STATEMENT_TIMEOUT_MS,
        (query) =>
          query<
            {
              creator_id: string;
              deposits: string;
              card_withdrawals: string;
              affiliate_claims: string;
            }[]
          >(sql, ...params),
      );

      return rows.map((r) => {
        const deposits = toNumber(r.deposits);
        const cardWithdrawals = toNumber(r.card_withdrawals);
        const affiliateClaims = toNumber(r.affiliate_claims);
        return [
          r.creator_id,
          {
            deposits,
            cardWithdrawals,
            affiliateClaims,
            affiliatesMadeUs: deposits - cardWithdrawals - affiliateClaims,
          },
        ] satisfies [string, FrameAffiliatePnl];
      });
    },
    [
      "profitability-frame-affiliate-pnl-v2",
      env,
      ...frames.map((f) => `${f.userId}:${f.startIso}:${f.endIso}`),
      ...blacklistIds,
    ],
    { revalidate: 180, tags: ["profitability-frame-affiliate-pnl"] },
  );

export async function getFrameAffiliatePnlByUser(
  frames: FrameWindow[],
): Promise<Map<string, FrameAffiliatePnl>> {
  if (frames.length === 0) return new Map();
  const env = await readDbEnv();
  const blacklistIds = await getExcludedUserIds();
  const entries = await cachedFramePnl(env, frames, blacklistIds)();
  return new Map(entries);
}
