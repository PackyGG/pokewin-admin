import "server-only";
import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "../_blacklist";
import { getCreatorSessionWindowsCte } from "../creator-session-windows";
import { WAGER_PAYOUT_WAGER_TYPES } from "../_wager-payout-types";
import {
  getStreamerSchemaProbe,
  safeLedgerTypeInList,
} from "./_schema-probe";
import {
  periodSqlInterval,
  type StreamerPeriod,
} from "@/app/(admin)/insights/streamers/types";

/**
 * Signal 5 — Creator self-play during own stream.
 *
 * Detects creators who wager their OWN balance heavily during the
 * window that they were live on a deal/stream. This is the "wager
 * abuse" pattern the user cares most about: a creator opening packs
 * or running upgrader bets on-stream to inflate apparent volume or to
 * use deal-funded liability as a piggy bank.
 *
 * Methodology:
 *   1. Pull the session_windows CTE (every creator's live windows).
 *      Already cached 5 min by `getCreatorSessionWindowsCte()`.
 *   2. For each creator, sum:
 *        a. selfWager   — ABS(amount) on wager-side ledger rows where
 *                         the creator is BOTH the user AND inside one
 *                         of their own session windows.
 *        b. cohortWager — the creator's referred cohort's wager
 *                         inside the same windows (i.e. real-customer
 *                         play that ran while the creator was live).
 *   3. Score = selfWager / (selfWager + cohortWager) — the creator's
 *      share of total wager flowing during their own stream. A clean
 *      creator should be near 0; > 30% is the user-defined threshold.
 *
 * Score buckets (per task spec):
 *   share < 30%  → 0 (no flag)
 *   30–50%       → amber band — 25–40 points
 *   ≥ 50%        → rose band  — 40–60 points
 *
 * Cap at 60 since this is one signal of seven; the combined risk score
 * already takes the per-signal max so one critical signal still
 * surfaces a creator regardless of the cap.
 *
 * Time scope:
 *   • The session windows are LIFETIME (the CTE doesn't filter by
 *     period — sessions span the whole creator history). When a period
 *     is selected, we intersect each window with `[NOW() - INTERVAL,
 *     NOW()]` via a WHERE on the ledger row's created_at. A creator
 *     who streamed heavily 6 months ago but is clean inside the
 *     selected window thus scores 0 for that window — which matches
 *     "what's happening in this period" semantics admins expect.
 *
 * Wager types match the existing GGR definition
 *   (`WAGER_PAYOUT_WAGER_TYPES`): pack_opening / battle_bet /
 *   battle_sponsorship / upgrader_bet / withdrawal_shipping_fee. Wager
 *   amounts are stored negative on the user side, so ABS() is required.
 *
 * SCHEMA-ADAPTIVE: the wager-type list is intersected against the live
 *   `ledger_transaction_type` enum via the schema probe before it's
 *   interpolated. On a DB that predates the upgrader launch (enum lacks
 *   `upgrader_bet`) the literal is silently dropped instead of throwing
 *   `22P02 invalid input value for enum` — the exact failure that blanked
 *   this signal on the stale snapshot. On prod the full set is used.
 *   When the enum carries NONE of the wager types (impossible in
 *   practice, but defended), the query is skipped and every creator
 *   scores 0.
 *
 * Read-only against Main DB. 10-minute cache, tag `insights-streamers`.
 */

const TTL_SECONDS = 600;

export type CreatorSelfPlayRow = {
  userId: string;
  /** USD the creator wagered FROM THEIR OWN BALANCE while live. */
  selfWagerUsd: number;
  /** USD their referred cohort wagered while the creator was live. */
  cohortWagerOnStreamUsd: number;
  /** Share of stream-time wager that came from the creator themself,
   *  0..1. null when there was no stream-time activity at all (no
   *  signal either way). */
  selfShare: number | null;
  /** 0..60 — see scoring table above. */
  score: number;
};

async function fetchInner(
  period: StreamerPeriod,
): Promise<Map<string, CreatorSelfPlayRow>> {
  const db = await getDb();
  const probe = await getStreamerSchemaProbe();

  // Schema gate: without the cohort source table there are no cohorts
  // to compare, and the wager-type list must contain at least one member
  // present on the connected enum. Either missing → no signal (empty
  // map), never a throw.
  const wagerIn = safeLedgerTypeInList(probe, WAGER_PAYOUT_WAGER_TYPES);
  if (!probe.hasAffiliateCodeUsages || wagerIn === null) {
    return new Map<string, CreatorSelfPlayRow>();
  }

  const excluded = await getExcludedUserIds();
  const blacklistU = blacklistNotInClause("u.id", excluded);
  const blacklistRu = blacklistNotInClause("ru.id", excluded);
  const interval = periodSqlInterval(period);
  const ltCutoff = interval ? `AND lt.created_at >= NOW() - ${interval}` : "";

  const sessionWindowsCte = await getCreatorSessionWindowsCte();

  type Row = {
    user_id: string;
    self_wager: string;
    cohort_wager_on_stream: string;
  };

  // ONE query: for every creator, two aggregates.
  //   • self_wager: ledger wager rows where lt.user_id = creator
  //                 AND the row's timestamp is inside one of THEIR
  //                 OWN session_windows (sw.uid = creator).
  //   • cohort_wager_on_stream: ledger wager rows from a referred
  //                 user (cohort_users join via affiliate_code_usages)
  //                 where the row falls inside the creator's stream
  //                 window. Real-customer scope only (staff + blacklist
  //                 excluded on the referred side; the creator side is
  //                 implicit since we filter to role='creator').
  //
  // LEFT JOIN so creators with no streams / no cohort play still
  // surface with zeros. The page already hides zero-signal rows, so
  // we don't need to drop them in SQL.
  const rows = await db.$queryRawUnsafe<Row[]>(`
    WITH ${sessionWindowsCte},
    creators AS (
      SELECT u.id
        FROM "user" u
       WHERE u.role = 'creator'
         ${blacklistU}
    ),
    -- Self-play: the creator's own wager rows that fall inside one
    -- of their own session windows.
    self_play AS (
      SELECT lt.user_id,
             COALESCE(SUM(ABS(lt.amount::numeric)), 0) AS self_wager
        FROM ledger_transactions lt
        JOIN creators c ON c.id = lt.user_id
        JOIN session_windows sw
          ON sw.uid = lt.user_id
         AND lt.created_at >= sw.win_start
         AND lt.created_at <  sw.win_end
       WHERE lt.status = 'completed'
         AND lt.type IN ${wagerIn}
         ${ltCutoff}
       GROUP BY lt.user_id
    ),
    -- Cohort users for each creator (deduped to avoid double-counting
    -- a user who shows up under multiple acu rows for the same code).
    cohort_users AS (
      SELECT DISTINCT acu.affiliate_user_id AS creator_id,
                      acu.referred_user_id AS ru_id
        FROM affiliate_code_usages acu
        JOIN "user" ru ON ru.id = acu.referred_user_id
       WHERE ru.role NOT IN ('admin', 'support', 'creator')
         ${blacklistRu}
    ),
    -- Cohort wager that ran while the creator was on stream. We join
    -- the wager row's timestamp against the creator's session window,
    -- not the referred user's — the abuse pattern is "creator is live,
    -- look how much my cohort is wagering" vs the creator's own play.
    cohort_on_stream AS (
      SELECT cu.creator_id AS user_id,
             COALESCE(SUM(ABS(lt.amount::numeric)), 0) AS cohort_wager
        FROM cohort_users cu
        JOIN ledger_transactions lt ON lt.user_id = cu.ru_id
        JOIN session_windows sw
          ON sw.uid = cu.creator_id
         AND lt.created_at >= sw.win_start
         AND lt.created_at <  sw.win_end
       WHERE lt.status = 'completed'
         AND lt.type IN ${wagerIn}
         ${ltCutoff}
       GROUP BY cu.creator_id
    )
    SELECT c.id AS user_id,
           COALESCE(sp.self_wager, 0)::text AS self_wager,
           COALESCE(cos.cohort_wager, 0)::text AS cohort_wager_on_stream
      FROM creators c
      LEFT JOIN self_play sp        ON sp.user_id = c.id
      LEFT JOIN cohort_on_stream cos ON cos.user_id = c.id
  `);

  const out = new Map<string, CreatorSelfPlayRow>();
  for (const r of rows) {
    const selfWagerUsd = toNumber(r.self_wager);
    const cohortWagerOnStreamUsd = toNumber(r.cohort_wager_on_stream);
    const total = selfWagerUsd + cohortWagerOnStreamUsd;

    // selfShare is the creator's slice of total stream-time wager.
    // null when there's literally nothing happening on stream — that
    // means "no signal", not "0% self play" (we don't want to flag a
    // streamer who hasn't streamed in the window).
    const selfShare = total > 0 ? selfWagerUsd / total : null;

    // Minimum activity gate — we don't flag tiny streams. $200 of
    // self-wager across the period is the floor; below that the
    // sample is too small to be meaningful.
    let score = 0;
    if (selfShare !== null && selfWagerUsd >= 200) {
      if (selfShare >= 0.5) {
        // 50% → 40 pts, scales to 60 by 80%.
        const r = Math.min(1, (selfShare - 0.5) / 0.3);
        score = Math.round(40 + r * 20);
      } else if (selfShare >= 0.3) {
        // 30% → 25 pts, scales to 40 by 50%.
        const r = (selfShare - 0.3) / 0.2;
        score = Math.round(25 + r * 15);
      }
    }

    out.set(r.user_id, {
      userId: r.user_id,
      selfWagerUsd,
      cohortWagerOnStreamUsd,
      selfShare,
      score,
    });
  }

  return out;
}

const cached = unstable_cache(
  fetchInner,
  ["insights-streamers-self-play-v1"],
  { revalidate: TTL_SECONDS, tags: ["insights-streamers"] },
);

/**
 * Map keyed by creator userId for O(1) merge in the parent abuse
 * query. Use directly when you only need a single creator's row.
 */
export function getCreatorSelfPlayMap(period: StreamerPeriod) {
  return cached(period);
}
