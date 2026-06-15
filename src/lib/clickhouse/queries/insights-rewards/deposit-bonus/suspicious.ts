import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";
import type {
  DepositBonusSuspicious,
  SuspiciousNoWager,
  SuspiciousSharedFingerprint,
  SuspiciousWithdrew,
} from "@/lib/queries/insights-rewards/deposit-bonus/suspicious";

import { CH_DB, toNumber } from "../../_shared";
import {
  cutoffClause,
  depositBonusCappedCutoff,
  depositBonusCutoff,
  depositBonusScopeCte,
} from "./_shared";

/**
 * ClickHouse twin of the deposit-bonus suspicious-claimant detector
 * (`getDepositBonusSuspicious` → `computeSuspicious` in
 * `src/lib/queries/insights-rewards/deposit-bonus/suspicious.ts`).
 *
 * Three independent top-25 lists, each gated/parity-verified separately:
 *   1. withdrewAfterBonus — claimed bonus → withdrawal < 24h after the LAST
 *      in-window bonus, with NO wager between claim and withdrawal. Earliest
 *      qualifying withdrawal via `argMin`; the "no wager between" anti-join is
 *      reproduced with `arrayExists` over the user's wager timestamps.
 *   2. noWager — claimed bonus in window, ZERO wager in the (capped) window;
 *      `hasEverWagered` = any wager all-time.
 *   3. sharedFingerprint — claimants sharing a `visitor_id` with another
 *      claimant. NOTE: the `fingerprints` mirror is currently EMPTY on BOTH PG
 *      and ClickHouse, so this list is trivially [] on both engines (no signal
 *      to differentiate — disclosed honestly).
 *
 * Money Σ + counts are cent/count-exact. `hoursToWithdraw` is a derived float
 * (ungated). 2-role customer scope + blacklist. Tie-breaks (§5c): lists 1/2 add
 * `user_id ASC` as a deterministic secondary (pinned on PG in the parity
 * script); list 3 adds `visitor_id ASC`.
 */

const WAGER_TYPES = "('pack_opening','battle_bet','battle_sponsorship','upgrader_bet')";
const TOP_LIMIT = 25;

export async function getDepositBonusSuspiciousFromClickHouse(
  period: InsightsRewardsPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<DepositBonusSuspicious> {
  const hasBlacklist = blacklist.length > 0;
  const scope = depositBonusScopeCte(hasBlacklist);
  const cutoff = depositBonusCutoff(period, now);
  const wagerWindowCutoff = depositBonusCappedCutoff(period, now);
  const params: Record<string, unknown> = { blacklist, cutoff, wagerWindowCutoff };

  const claimantsCte = `
    bonus_claimants AS (
      SELECT
        lt.user_id AS user_id,
        sum(abs(lt.amount)) AS bonus_in_window,
        count() AS bonus_count,
        max(lt.created_at) AS last_bonus_at
      FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
      WHERE lt._peerdb_is_deleted = 0
        AND lt.status = 'completed'
        AND lt.type = 'deposit_bonus'
        AND lt.user_id IN (SELECT id FROM real_users)
        ${cutoffClause(cutoff, "lt")}
      GROUP BY lt.user_id
    )`;

  const [withdrewRows, noWagerRows, sharedRows] = await Promise.all([
    clickhouseRead.query<{
      user_id: string;
      username: string | null;
      bonus_in_window: string;
      bonus_count: string;
      withdraw_amount: string;
      withdrew_at: string;
      hours_to_withdraw: string;
    }>({
      queryName: "insights.deposit_bonus.suspicious.withdrew",
      sql: `
        WITH ${scope},
        ${claimantsCte},
        withdrawals AS (
          SELECT wd.user_id AS user_id, wd.amount AS amount, wd.created_at AS created_at
          FROM ${CH_DB}.public_ledger_transactions AS wd FINAL
          WHERE wd._peerdb_is_deleted = 0
            AND wd.status = 'completed'
            AND wd.type = 'card_withdrawal'
            AND wd.user_id IN (SELECT user_id FROM bonus_claimants)
        ),
        wager_by_user AS (
          SELECT wg.user_id AS user_id, groupArray(wg.created_at) AS ts
          FROM ${CH_DB}.public_ledger_transactions AS wg FINAL
          WHERE wg._peerdb_is_deleted = 0
            AND wg.status = 'completed'
            AND wg.type IN ${WAGER_TYPES}
            AND wg.user_id IN (SELECT user_id FROM bonus_claimants)
          GROUP BY wg.user_id
        ),
        first_withdraw AS (
          SELECT
            bc.user_id AS user_id,
            any(bc.bonus_in_window) AS bonus_in_window,
            any(bc.bonus_count) AS bonus_count,
            any(bc.last_bonus_at) AS last_bonus_at,
            argMin(w.amount, w.created_at) AS withdraw_amt,
            min(w.created_at) AS withdrew_at
          FROM bonus_claimants AS bc
          INNER JOIN withdrawals AS w ON w.user_id = bc.user_id
          WHERE w.created_at > bc.last_bonus_at
            AND w.created_at < bc.last_bonus_at + INTERVAL 24 HOUR
          GROUP BY bc.user_id
        ),
        paired AS (
          SELECT
            fw.user_id AS user_id,
            fw.bonus_in_window AS bonus_in_window,
            fw.bonus_count AS bonus_count,
            fw.last_bonus_at AS last_bonus_at,
            fw.withdraw_amt AS withdraw_amt,
            fw.withdrew_at AS withdrew_at
          FROM first_withdraw AS fw
          LEFT JOIN wager_by_user AS wbu ON wbu.user_id = fw.user_id
          WHERE NOT arrayExists(
            t -> t >= fw.last_bonus_at AND t <= fw.withdrew_at,
            coalesce(wbu.ts, [])
          )
        )
        SELECT
          p.user_id                                                                          AS user_id,
          u.username                                                                         AS username,
          toString(p.bonus_in_window)                                                        AS bonus_in_window,
          toString(p.bonus_count)                                                            AS bonus_count,
          toString(abs(p.withdraw_amt))                                                      AS withdraw_amount,
          toString(p.withdrew_at)                                                            AS withdrew_at,
          toString((toUnixTimestamp64Micro(p.withdrew_at) - toUnixTimestamp64Micro(p.last_bonus_at)) / 3600000000.0) AS hours_to_withdraw
        FROM paired AS p
        INNER JOIN ${CH_DB}.public_user AS u FINAL ON u.id = p.user_id
        WHERE u._peerdb_is_deleted = 0
        ORDER BY abs(p.withdraw_amt) DESC, p.user_id ASC
        LIMIT ${TOP_LIMIT}`,
      params,
      timeoutMs: 30_000,
    }),
    clickhouseRead.query<{
      user_id: string;
      username: string | null;
      bonus_in_window: string;
      bonus_count: string;
      last_bonus_at: string;
      has_ever_wagered: string;
    }>({
      queryName: "insights.deposit_bonus.suspicious.no_wager",
      sql: `
        WITH ${scope},
        ${claimantsCte},
        wager_window_users AS (
          SELECT DISTINCT w.user_id AS user_id
          FROM ${CH_DB}.public_ledger_transactions AS w FINAL
          WHERE w._peerdb_is_deleted = 0
            AND w.status = 'completed'
            AND w.type IN ${WAGER_TYPES}
            AND w.user_id IN (SELECT user_id FROM bonus_claimants)
            AND w.created_at >= {wagerWindowCutoff:DateTime64(6)}
        ),
        wager_ever_users AS (
          SELECT DISTINCT w.user_id AS user_id
          FROM ${CH_DB}.public_ledger_transactions AS w FINAL
          WHERE w._peerdb_is_deleted = 0
            AND w.status = 'completed'
            AND w.type IN ${WAGER_TYPES}
            AND w.user_id IN (SELECT user_id FROM bonus_claimants)
        )
        SELECT
          bc.user_id                                                          AS user_id,
          u.username                                                          AS username,
          toString(bc.bonus_in_window)                                        AS bonus_in_window,
          toString(bc.bonus_count)                                            AS bonus_count,
          toString(bc.last_bonus_at)                                          AS last_bonus_at,
          toString(toUInt8(bc.user_id IN (SELECT user_id FROM wager_ever_users))) AS has_ever_wagered
        FROM bonus_claimants AS bc
        INNER JOIN ${CH_DB}.public_user AS u FINAL ON u.id = bc.user_id
        WHERE u._peerdb_is_deleted = 0
          AND bc.user_id NOT IN (SELECT user_id FROM wager_window_users)
        ORDER BY bc.bonus_in_window DESC, bc.user_id ASC
        LIMIT ${TOP_LIMIT}`,
      params,
      timeoutMs: 30_000,
    }),
    clickhouseRead.query<{
      visitor_id: string;
      user_count: string;
      sample_users: string[];
      sample_usernames: (string | null)[];
      bonus_in_window: string;
    }>({
      queryName: "insights.deposit_bonus.suspicious.shared_fingerprint",
      sql: `
        WITH ${scope},
        ${claimantsCte},
        user_visitors AS (
          SELECT DISTINCT
            bc.user_id AS user_id,
            f.visitor_id AS visitor_id,
            bc.bonus_in_window AS bonus_amt,
            u.username AS username
          FROM bonus_claimants AS bc
          INNER JOIN ${CH_DB}.public_fingerprints AS f FINAL ON f.user_id = bc.user_id
          LEFT JOIN ${CH_DB}.public_user AS u FINAL ON u.id = bc.user_id
          WHERE f._peerdb_is_deleted = 0
            AND f.visitor_id IS NOT NULL
        )
        SELECT
          visitor_id                                              AS visitor_id,
          toString(uniqExact(user_id))                            AS user_count,
          arraySlice(arrayDistinct(groupArray(user_id)), 1, 5)    AS sample_users,
          arraySlice(arrayDistinct(groupArray(username)), 1, 5)   AS sample_usernames,
          toString(sum(bonus_amt))                                AS bonus_in_window
        FROM user_visitors
        GROUP BY visitor_id
        HAVING uniqExact(user_id) > 1
        ORDER BY uniqExact(user_id) DESC, sum(bonus_amt) DESC, visitor_id ASC
        LIMIT ${TOP_LIMIT}`,
      params,
      timeoutMs: 30_000,
    }),
  ]);

  const withdrewAfterBonus: SuspiciousWithdrew[] = withdrewRows.map((r) => ({
    userId: r.user_id,
    username: r.username,
    bonusInWindow: toNumber(r.bonus_in_window),
    bonusCount: Number(r.bonus_count ?? 0),
    withdrawAmount: toNumber(r.withdraw_amount),
    hoursToWithdraw: toNumber(r.hours_to_withdraw),
    withdrewAt: new Date(r.withdrew_at.replace(" ", "T") + "Z").toISOString(),
  }));

  const noWager: SuspiciousNoWager[] = noWagerRows.map((r) => ({
    userId: r.user_id,
    username: r.username,
    bonusInWindow: toNumber(r.bonus_in_window),
    bonusCount: Number(r.bonus_count ?? 0),
    hasEverWagered: r.has_ever_wagered === "1",
    lastBonusAt: new Date(r.last_bonus_at.replace(" ", "T") + "Z").toISOString(),
  }));

  const sharedFingerprint: SuspiciousSharedFingerprint[] = sharedRows.map((r) => ({
    visitorId: r.visitor_id,
    userCount: Number(r.user_count ?? 0),
    sampleUserIds: r.sample_users ?? [],
    sampleUsernames: r.sample_usernames ?? [],
    bonusInWindow: toNumber(r.bonus_in_window),
  }));

  return { withdrewAfterBonus, noWager, sharedFingerprint };
}
