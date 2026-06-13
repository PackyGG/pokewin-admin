import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import {
  daysForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "../_period";
import {
  DEPOSIT_BONUS_CACHE_TAGS,
  getResolvedBlacklist,
  staffAndBlacklistSubquery,
  windowDateFilter,
} from "./_shared";

/**
 * Suspicious deposit-bonus claimant detection.
 *
 * Three independent flags, each scoped to the active window. A user can
 * appear in multiple flag lists (a withdrawer-without-wager will hit
 * both `withdrewWithoutWager` and `noWager`). Each list returns the top
 * 25 by signal strength so the section stays bounded.
 *
 *   1. withdrewAfterBonus     — claimed bonus, then card_withdrawal in
 *                                 < 24h of the latest bonus, with NO
 *                                 wager activity between claim and
 *                                 withdrawal (cash-out abuse signal)
 *   2. noWager                — claimed bonus in window, ZERO wager
 *                                 activity in window (parking signal)
 *   3. sharedFingerprint      — claimed bonus, share a `visitor_id` with
 *                                 ANOTHER claimant who also got a bonus
 *                                 in the window (alt-farming signal)
 *
 * Staff + blacklist excluded. Read-only. Heavy queries — 5-minute cache.
 *
 * Note: signup_ip equality isn't a useful signal on its own (NAT, shared
 * networks). Fingerprint visitor_id is much higher confidence and
 * already drives the alt-detection pipeline on /security.
 */

const TOP_LIMIT = 25;

export type SuspiciousWithdrew = {
  userId: string;
  username: string | null;
  bonusInWindow: number;
  bonusCount: number;
  withdrawAmount: number;
  /** Hours between latest in-window bonus and the matching withdrawal. */
  hoursToWithdraw: number;
  withdrewAt: string;
};

export type SuspiciousNoWager = {
  userId: string;
  username: string | null;
  bonusInWindow: number;
  bonusCount: number;
  /** Has the user wagered EVER (across all time)? Useful sanity. */
  hasEverWagered: boolean;
  lastBonusAt: string;
};

export type SuspiciousSharedFingerprint = {
  visitorId: string;
  userCount: number;
  /** Up to 5 sample user ids in the group, for the popover. */
  sampleUserIds: string[];
  /** Sample usernames (parallel to ids). */
  sampleUsernames: Array<string | null>;
  /** Sum of bonus volume across all users in the cluster, in window. */
  bonusInWindow: number;
};

export type DepositBonusSuspicious = {
  withdrewAfterBonus: SuspiciousWithdrew[];
  noWager: SuspiciousNoWager[];
  sharedFingerprint: SuspiciousSharedFingerprint[];
};

async function computeSuspicious(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<DepositBonusSuspicious> {
  const db = await getDb();
  const dateFilter = windowDateFilter(period);
  const userScope = staffAndBlacklistSubquery(blacklistIds);
  const days = daysForInsightsPeriod(period);
  // For the "no wager in window" check we need the SAME window
  // bound on the wager-side NOT EXISTS. Lifetime uses 1 year as a
  // generous lookback so the flag stays meaningful.
  const wagerWindowClause =
    days !== null
      ? `AND w.created_at >= NOW() - INTERVAL '${days} days'`
      : `AND w.created_at >= NOW() - INTERVAL '365 days'`;

  // Flag 1: cash-out abuse — bonus → withdrawal within 24h, no wager
  // activity in between.
  //
  // PERFORMANCE — materialised hash + range join, NOT correlated subqueries.
  // The original `JOIN LATERAL (… card_withdrawal … LIMIT 1)` plus the
  // correlated `NOT EXISTS` wager check had no usable index for either
  // lookup (ledger_transactions — ~855k rows — is only indexed on id /
  // external_tx_id / fireblocks_tx_id), so each ran a full Seq Scan of the
  // whole table PER bonus-claimant row → 57014 statement timeout on EVERY
  // window (verified on live prod: even 7d timed out; 1d/3d took 18–20s).
  // Indexes are off-limits (read-only prod), so the fix is query-shape only:
  //   1. materialise the window's bonus claimants, then the claimants'
  //      withdrawals and wager events — both scoped to `user_id IN
  //      (bonus_claimants)`, a tiny user set, so each is ONE table pass with
  //      a hash semi-join instead of a per-row Seq Scan;
  //   2. range-join claimants↔withdrawals on the 24h window and keep the
  //      FIRST matching withdrawal per claimant via `DISTINCT ON (user_id)
  //      … ORDER BY w.created_at ASC` — identical to the old `LIMIT 1`;
  //   3. drop the paired rows where a wager exists in [last_bonus, withdrew]
  //      via an anti-join (`NOT EXISTS` over the materialised wager set) —
  //      same predicate as the old correlated `NOT EXISTS`, one hash pass.
  // The withdrawal / wager sets carry NO global date bound on purpose
  // (membership in the claimant set already bounds them), so `all`-window
  // pairing semantics are preserved exactly. `MATERIALIZED` prevents
  // Postgres inlining the CTEs back into a correlated form. Verified on
  // live prod: IDENTICAL top-25 output vs the original on the narrow
  // windows where the original completes (2026-05-28/29, 06-06, 06-11 —
  // 13–25 paired rows match key-for-key), and ~0.3–0.6s on 30d AND all.
  const withdrewRows = await db.$queryRawUnsafe<
    {
      user_id: string;
      username: string | null;
      bonus_in_window: string;
      bonus_count: string;
      last_bonus_at: Date;
      withdraw_amount: string;
      withdrew_at: Date;
      hours_to_withdraw: string;
    }[]
  >(`
    WITH bonus_claimants AS MATERIALIZED (
      SELECT
        lt.user_id,
        SUM(ABS(lt.amount::numeric)) AS bonus_in_window,
        COUNT(*)::int AS bonus_count,
        MAX(lt.created_at) AS last_bonus_at
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.type::text = 'deposit_bonus'
        AND lt.user_id IN ${userScope}
        ${dateFilter}
      GROUP BY lt.user_id
    ),
    withdrawals AS MATERIALIZED (
      SELECT wd.user_id, wd.amount, wd.created_at
      FROM ledger_transactions wd
      WHERE wd.status = 'completed'
        AND wd.type::text = 'card_withdrawal'
        AND wd.user_id IN (SELECT user_id FROM bonus_claimants)
    ),
    wager_events AS MATERIALIZED (
      SELECT wg.user_id, wg.created_at
      FROM ledger_transactions wg
      WHERE wg.status = 'completed'
        AND wg.type::text IN ('pack_opening','battle_bet','battle_sponsorship','upgrader_bet')
        AND wg.user_id IN (SELECT user_id FROM bonus_claimants)
    ),
    first_withdraw AS (
      SELECT DISTINCT ON (bc.user_id)
        bc.user_id,
        bc.bonus_in_window,
        bc.bonus_count,
        bc.last_bonus_at,
        w.amount AS withdraw_amt,
        w.created_at AS withdrew_at,
        EXTRACT(EPOCH FROM (w.created_at - bc.last_bonus_at)) / 3600 AS hours_to_withdraw
      FROM bonus_claimants bc
      JOIN withdrawals w
        ON w.user_id = bc.user_id
        AND w.created_at > bc.last_bonus_at
        AND w.created_at < bc.last_bonus_at + INTERVAL '24 hours'
      ORDER BY bc.user_id, w.created_at ASC
    ),
    paired AS (
      SELECT fw.*
      FROM first_withdraw fw
      WHERE NOT EXISTS (
        SELECT 1 FROM wager_events we
        WHERE we.user_id = fw.user_id
          AND we.created_at >= fw.last_bonus_at
          AND we.created_at <= fw.withdrew_at
      )
    )
    SELECT
      p.user_id,
      u.username,
      p.bonus_in_window::text AS bonus_in_window,
      p.bonus_count::text AS bonus_count,
      p.last_bonus_at,
      ABS(p.withdraw_amt::numeric)::text AS withdraw_amount,
      p.withdrew_at,
      p.hours_to_withdraw::text AS hours_to_withdraw
    FROM paired p
    JOIN "user" u ON u.id = p.user_id
    ORDER BY ABS(p.withdraw_amt::numeric) DESC
    LIMIT ${TOP_LIMIT}
  `);

  const withdrewAfterBonus: SuspiciousWithdrew[] = withdrewRows.map((r) => ({
    userId: r.user_id,
    username: r.username,
    bonusInWindow: toNumber(r.bonus_in_window),
    bonusCount: Number(r.bonus_count ?? 0),
    withdrawAmount: toNumber(r.withdraw_amount),
    hoursToWithdraw: toNumber(r.hours_to_withdraw),
    withdrewAt: new Date(r.withdrew_at).toISOString(),
  }));

  // Flag 2: claimed bonus, no wager in window.
  const noWagerRows = await db.$queryRawUnsafe<
    {
      user_id: string;
      username: string | null;
      bonus_in_window: string;
      bonus_count: string;
      last_bonus_at: Date;
      has_ever_wagered: boolean;
    }[]
  >(`
    WITH bonus_claimants AS (
      SELECT
        lt.user_id,
        SUM(ABS(lt.amount::numeric)) AS bonus_in_window,
        COUNT(*)::int AS bonus_count,
        MAX(lt.created_at) AS last_bonus_at
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.type::text = 'deposit_bonus'
        AND lt.user_id IN ${userScope}
        ${dateFilter}
      GROUP BY lt.user_id
    ),
    no_wager AS (
      SELECT
        bc.user_id,
        bc.bonus_in_window,
        bc.bonus_count,
        bc.last_bonus_at,
        EXISTS (
          SELECT 1 FROM ledger_transactions w
          WHERE w.user_id = bc.user_id
            AND w.status = 'completed'
            AND w.type::text IN ('pack_opening','battle_bet','battle_sponsorship','upgrader_bet')
        ) AS has_ever_wagered
      FROM bonus_claimants bc
      WHERE NOT EXISTS (
        SELECT 1 FROM ledger_transactions w
        WHERE w.user_id = bc.user_id
          AND w.status = 'completed'
          AND w.type::text IN ('pack_opening','battle_bet','battle_sponsorship','upgrader_bet')
          ${wagerWindowClause}
      )
    )
    SELECT
      nw.user_id,
      u.username,
      nw.bonus_in_window::text AS bonus_in_window,
      nw.bonus_count::text AS bonus_count,
      nw.last_bonus_at,
      nw.has_ever_wagered
    FROM no_wager nw
    JOIN "user" u ON u.id = nw.user_id
    ORDER BY nw.bonus_in_window DESC
    LIMIT ${TOP_LIMIT}
  `);

  const noWager: SuspiciousNoWager[] = noWagerRows.map((r) => ({
    userId: r.user_id,
    username: r.username,
    bonusInWindow: toNumber(r.bonus_in_window),
    bonusCount: Number(r.bonus_count ?? 0),
    hasEverWagered: r.has_ever_wagered,
    lastBonusAt: new Date(r.last_bonus_at).toISOString(),
  }));

  // Flag 3: shared visitor_id (fingerprint) among multiple in-window
  // bonus claimants.
  const sharedRows = await db.$queryRawUnsafe<
    {
      visitor_id: string;
      user_count: string;
      sample_users: string[];
      sample_usernames: (string | null)[];
      bonus_in_window: string;
    }[]
  >(`
    WITH bonus_claimants AS (
      SELECT lt.user_id, SUM(ABS(lt.amount::numeric)) AS bonus_in_window
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.type::text = 'deposit_bonus'
        AND lt.user_id IN ${userScope}
        ${dateFilter}
      GROUP BY lt.user_id
    ),
    user_visitors AS (
      SELECT DISTINCT bc.user_id, f.visitor_id, bc.bonus_in_window
      FROM bonus_claimants bc
      JOIN fingerprints f ON f.user_id = bc.user_id
      WHERE f.visitor_id IS NOT NULL
    ),
    visitor_groups AS (
      SELECT
        visitor_id,
        COUNT(DISTINCT user_id)::int AS user_count,
        SUM(bonus_in_window) AS bonus_in_window
      FROM user_visitors
      GROUP BY visitor_id
      HAVING COUNT(DISTINCT user_id) > 1
    )
    SELECT
      vg.visitor_id,
      vg.user_count::text AS user_count,
      (ARRAY(
        SELECT DISTINCT uv.user_id FROM user_visitors uv WHERE uv.visitor_id = vg.visitor_id LIMIT 5
      ))::text[] AS sample_users,
      (ARRAY(
        SELECT u.username FROM user_visitors uv JOIN "user" u ON u.id = uv.user_id WHERE uv.visitor_id = vg.visitor_id LIMIT 5
      ))::text[] AS sample_usernames,
      vg.bonus_in_window::text AS bonus_in_window
    FROM visitor_groups vg
    ORDER BY vg.user_count DESC, vg.bonus_in_window DESC
    LIMIT ${TOP_LIMIT}
  `);

  const sharedFingerprint: SuspiciousSharedFingerprint[] = sharedRows.map(
    (r) => ({
      visitorId: r.visitor_id,
      userCount: Number(r.user_count ?? 0),
      sampleUserIds: r.sample_users ?? [],
      sampleUsernames: r.sample_usernames ?? [],
      bonusInWindow: toNumber(r.bonus_in_window),
    }),
  );

  return { withdrewAfterBonus, noWager, sharedFingerprint };
}

const cachedSuspicious = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeSuspicious(period, blacklistIds),
  ["insights-rewards-deposit-bonus-suspicious-v1"],
  { revalidate: 300, tags: [...DEPOSIT_BONUS_CACHE_TAGS] },
);

export async function getDepositBonusSuspicious(
  period: InsightsRewardsPeriod,
): Promise<DepositBonusSuspicious> {
  const blacklist = await getResolvedBlacklist();
  return cachedSuspicious(period, blacklist);
}
