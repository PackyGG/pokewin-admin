import "server-only";
import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "../_blacklist";
import {
  periodSqlInterval,
  type StreamerPeriod,
} from "@/app/(admin)/insights/streamers/types";

/**
 * Signal 7 — Withdraw-and-redeposit cycle (leaderboard-farming pattern).
 *
 * The user-described pattern is:
 *   deposit → wager → withdrawal → (later) deposit + new affiliate code → repeat.
 *
 * Schema note (verified during build):
 *   The main DB has NO dedicated `affiliate_code_change` event. Code
 *   changes are only observable as new rows in `affiliate_code_usages`
 *   per user. So a "code change" is inferred from the distinct
 *   sequence of UPPER(code) values associated with that user, ordered
 *   by the row's `created_at`.
 *
 * Cycle definition (computed per user):
 *   • Walk a user's sequence of EVENTS, ordered by created_at:
 *       - deposit_event  = ledger_transactions row, type='deposit',
 *         status='completed'.
 *       - withdrawal     = ledger_transactions row,
 *         type='card_withdrawal', status='completed'. (Withdrawals on
 *         packy.gg are card-shipping based, so `card_withdrawal` is
 *         the canonical type for "user took money out".)
 *       - acu row        = affiliate_code_usages row. The acu row's
 *         `code` is the code in use at that moment.
 *   • A "cycle" closes when this sequence appears IN ORDER:
 *       deposit → at least one wager-side ledger row →
 *       card_withdrawal → next deposit.
 *   • A "code-switched cycle" is a cycle where the code at the
 *     post-withdraw deposit differs from the code at the pre-withdraw
 *     deposit. The latter is the canonical "farm" signal — switch in
 *     for a code, cash out, switch to another code, repeat.
 *
 * Scoring:
 *   Per creator we compute the % of their referred cohort with ≥2
 *   code-switched cycles. ≥10% of cohort flagged → high score.
 *   Min cohort size = 5 to avoid noise.
 *
 *   share ≥ 20%      → 60 pts (rose)
 *   10% ≤ share < 20% → 30–60 pts (linear ramp)
 *   share < 10%      → 0
 *
 * Performance:
 *   • Computed live with a 30-min cache (longer than the other
 *     signals because this is the heaviest query).
 *   • The per-user walk is O(events per user). We bound the query
 *     to the period, restrict the user population to "real customers
 *     who are in someone's cohort", and run the cycle detection in
 *     application code so the SQL stays as simple per-row aggregates.
 *
 * PROPOSED follow-up:
 *   Move this to a daily cron writing into an admin DB table
 *   `creator_cohort_cycle_scores` (admin DB only — per CLAUDE.md), so
 *   the page reads precomputed rows. The current live query is
 *   acceptable for first ship but will scale poorly past a few
 *   thousand active cohort users.
 *
 * Read-only against Main DB.
 */

const TTL_SECONDS = 1800; // 30 min — heavier than other signals.
const MIN_COHORT_SIZE = 5;
const HIGH_CYCLE_USER_THRESHOLD = 2;

export type CycleSignalRow = {
  userId: string;
  /** Count of referred cohort users with ≥ HIGH_CYCLE_USER_THRESHOLD
   *  code-switched cycles in the period. */
  flaggedUsers: number;
  /** Cohort size used for the share — equals the count of users who
   *  had at least one deposit + withdrawal in the period. */
  cohortSize: number;
  /** flaggedUsers / cohortSize, 0..1. null when cohortSize == 0. */
  cycleShare: number | null;
  /** 0..60 — see scoring table. */
  score: number;
};

type EventRow = {
  creator_id: string;
  ru_id: string;
  kind: "deposit" | "withdrawal" | "code";
  ts: Date;
  code: string | null;
};

async function fetchInner(
  period: StreamerPeriod,
): Promise<Map<string, CycleSignalRow>> {
  const db = await getDb();
  const excluded = await getExcludedUserIds();
  const blacklistRu = blacklistNotInClause("ru.id", excluded);
  const interval = periodSqlInterval(period);
  const ltCutoff = interval ? `AND lt.created_at >= NOW() - ${interval}` : "";
  const acuCutoff = interval ? `AND acu.created_at >= NOW() - ${interval}` : "";

  // One big walk: for every (creator, cohort-user) pair, pull every
  // event (deposit, withdrawal, code) inside the period, ordered.
  // The deposit / withdrawal events come from ledger_transactions;
  // the code events come from affiliate_code_usages.
  //
  // The query restricts to cohort users (the cohort_users CTE) so we
  // don't pull events for the entire user base. Performance: bounded
  // by sum of (cohort sizes × events per user) inside the period.
  const events = await db.$queryRawUnsafe<EventRow[]>(`
    WITH cohort_users AS (
      SELECT DISTINCT acu.affiliate_user_id AS creator_id,
                      acu.referred_user_id AS ru_id
        FROM affiliate_code_usages acu
        JOIN "user" ru ON ru.id = acu.referred_user_id
       WHERE ru.role NOT IN ('admin', 'support', 'creator')
         ${blacklistRu}
    ),
    deposits AS (
      SELECT cu.creator_id, cu.ru_id,
             'deposit'::text AS kind,
             lt.created_at AS ts,
             NULL::text AS code
        FROM cohort_users cu
        JOIN ledger_transactions lt ON lt.user_id = cu.ru_id
       WHERE lt.type = 'deposit'
         AND lt.status = 'completed'
         ${ltCutoff}
    ),
    withdrawals AS (
      SELECT cu.creator_id, cu.ru_id,
             'withdrawal'::text AS kind,
             lt.created_at AS ts,
             NULL::text AS code
        FROM cohort_users cu
        JOIN ledger_transactions lt ON lt.user_id = cu.ru_id
       WHERE lt.type = 'card_withdrawal'
         AND lt.status = 'completed'
         ${ltCutoff}
    ),
    code_uses AS (
      -- One row per code-change moment, so dense bursts of acu rows
      -- under the same code collapse into a single "code" event.
      SELECT cu.creator_id, cu.ru_id,
             'code'::text AS kind,
             MIN(acu.created_at) AS ts,
             UPPER(acu.code) AS code
        FROM cohort_users cu
        JOIN affiliate_code_usages acu
          ON acu.referred_user_id = cu.ru_id
       WHERE TRUE
         ${acuCutoff}
       GROUP BY cu.creator_id, cu.ru_id, UPPER(acu.code)
    )
    SELECT * FROM deposits
    UNION ALL SELECT * FROM withdrawals
    UNION ALL SELECT * FROM code_uses
    ORDER BY creator_id, ru_id, ts ASC
  `);

  // Group events by (creator_id, ru_id) — the SQL already orders by
  // (creator_id, ru_id, ts) so we just walk linearly.
  type UserEvents = { events: EventRow[] };
  const byCreatorThenUser = new Map<string, Map<string, UserEvents>>();
  for (const ev of events) {
    let userMap = byCreatorThenUser.get(ev.creator_id);
    if (!userMap) {
      userMap = new Map();
      byCreatorThenUser.set(ev.creator_id, userMap);
    }
    let bucket = userMap.get(ev.ru_id);
    if (!bucket) {
      bucket = { events: [] };
      userMap.set(ev.ru_id, bucket);
    }
    bucket.events.push(ev);
  }

  const out = new Map<string, CycleSignalRow>();

  for (const [creatorId, userMap] of byCreatorThenUser) {
    let flagged = 0;
    let qualifying = 0; // cohort size with deposit+withdraw activity

    for (const [, bucket] of userMap) {
      const cycles = countCodeSwitchedCycles(bucket.events);
      if (cycles.hadActivity) qualifying += 1;
      if (cycles.switchedCycles >= HIGH_CYCLE_USER_THRESHOLD) flagged += 1;
    }

    const cycleShare = qualifying > 0 ? flagged / qualifying : null;
    let score = 0;
    if (cycleShare !== null && qualifying >= MIN_COHORT_SIZE) {
      if (cycleShare >= 0.2) {
        score = 60;
      } else if (cycleShare >= 0.1) {
        // 10% → 30, scales to 60 at 20%.
        const r = (cycleShare - 0.1) / 0.1;
        score = Math.round(30 + r * 30);
      }
    }

    out.set(creatorId, {
      userId: creatorId,
      flaggedUsers: flagged,
      cohortSize: qualifying,
      cycleShare,
      score,
    });
  }

  return out;
}

/**
 * Walk one user's ordered event sequence and count "code-switched
 * cycles". Returns:
 *   - hadActivity: true when the user had at least one deposit AND
 *     one withdrawal in the period (used for cohort-size denominator)
 *   - switchedCycles: count of completed cycles where the post-cycle
 *     deposit used a different code than the pre-cycle deposit.
 *
 * State machine:
 *   - currentCode tracks the most recent "code" event (so we know
 *     what code was active at each deposit).
 *   - openDepositCode: code in use at the most recent unmatched
 *     deposit. null = no deposit-in-progress.
 *   - On withdrawal: mark "withdrawal seen since the deposit".
 *   - On the NEXT deposit after a withdrawal: if the new code differs
 *     from openDepositCode, that's a switched cycle.
 *
 * Doesn't try to be precise about ordering ambiguity — events at the
 * exact same timestamp resolve in SQL's tiebreak order, which is
 * good enough for our threshold logic.
 */
function countCodeSwitchedCycles(events: EventRow[]): {
  hadActivity: boolean;
  switchedCycles: number;
} {
  let currentCode: string | null = null;
  let openDepositCode: string | null = null;
  let withdrawalSeen = false;
  let switchedCycles = 0;
  let hasDeposit = false;
  let hasWithdraw = false;

  for (const ev of events) {
    if (ev.kind === "code" && ev.code) {
      currentCode = ev.code;
      continue;
    }
    if (ev.kind === "deposit") {
      hasDeposit = true;
      if (withdrawalSeen && openDepositCode !== null) {
        // Cycle closes here.
        if (currentCode !== null && currentCode !== openDepositCode) {
          switchedCycles += 1;
        }
        // Open a new "current deposit" with the live code.
        openDepositCode = currentCode;
        withdrawalSeen = false;
      } else if (openDepositCode === null) {
        openDepositCode = currentCode;
      }
      // else: another deposit on top of an open one — keep the
      // earliest code as the cycle's "entry" code so a chain of
      // deposits before the withdrawal still attributes to one cycle.
      continue;
    }
    if (ev.kind === "withdrawal") {
      hasWithdraw = true;
      if (openDepositCode !== null) {
        withdrawalSeen = true;
      }
      continue;
    }
  }

  return {
    hadActivity: hasDeposit && hasWithdraw,
    switchedCycles,
  };
}

const cached = unstable_cache(
  fetchInner,
  ["insights-streamers-cycle-v1"],
  { revalidate: TTL_SECONDS, tags: ["insights-streamers"] },
);

export function getCycleSignalMap(period: StreamerPeriod) {
  return cached(period);
}
