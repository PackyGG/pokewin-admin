import { queryMainRows } from "@/lib/drizzle-query";
import "server-only";

import { unstable_cache } from "next/cache";
import { toNumber } from "@/lib/utils/decimal";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "@/lib/queries/_blacklist";
import { getCreatorSessionWindowsCte } from "@/lib/queries/creator-session-windows";
import {
  WAGER_TYPES_SQL,
  PAYOUT_TYPES_SQL,
} from "@/lib/queries/_wager-payout-types";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";

/**
 * Top-N "whales" lenses. The user requested multiple top-10 lists by
 * lifetime P&L, lifetime wager, 7d wager, biggest single deposit,
 * biggest single withdrawal. This helper exposes one async function
 * per lens so the tab can fetch only the active lens.
 *
 * Each query is read-only against the Main DB. Staff (admin/support)
 * and the manual blacklist are excluded.
 *
 * RESILIENCE + PERFORMANCE (mirrors `overview.ts` / `ltv.ts` in this
 * directory): each lens query is a heavy `ledger_transactions` /
 * `card_withdrawal_requests` scan. Two changes harden them so one slow or
 * failed lens degrades to an empty list instead of pinning a MAIN
 * `max:5` pool slot and crashing the tab:
 *   1. The raw query body of each lens is wrapped in a param-keyed
 *      `unstable_cache` (300s, scope inputs in the key so a changed
 *      blacklist / creator-session set can't serve a stale value, tagged
 *      `insights-analytics` / `dashboard-lifetime` so a wipe/restore busts
 *      it) — the SAME contract `ltv.ts cachedPerUserLtv` uses.
 *   2. The public dispatcher runs the cached read inside `safeQuery` with
 *      the canonical heavy-read timeout (`REWARD_QUERY_TIMEOUT_MS`) and an
 *      empty-list fallback, so a pathological lens degrades to `[]`.
 *
 * The "lifetime" / "biggest single" lenses previously scanned the ENTIRE
 * `ledger_transactions` history with NO lower bound, which on prod-sized
 * data is the exact unbounded-lifetime scan CLAUDE.md forbids. They are
 * now bounded to a 365-day lookback (`WHALES_LIFETIME_LOOKBACK_DAYS`),
 * consistent with `INSIGHTS_LIFETIME_LOOKBACK_DAYS` (insights-rewards) and
 * `OVERVIEW_LIFETIME_LOOKBACK_DAYS` (overview.ts) — both 365. This is a
 * PERFORMANCE bound: a "lifetime whale" is, in practice, a top spender in
 * the last year; the 30d/7d lenses are unaffected (they already bound).
 */

export type WhalesLens =
  | "lifetime-pnl"
  | "lifetime-wager"
  | "wager-7d"
  | "wager-30d"
  | "biggest-deposit"
  | "biggest-withdrawal"
  | "biggest-single-loss"
  | "biggest-single-win";

export function parseWhalesLens(value: string | undefined): WhalesLens {
  switch (value) {
    case "lifetime-pnl":
    case "lifetime-wager":
    case "wager-7d":
    case "wager-30d":
    case "biggest-deposit":
    case "biggest-withdrawal":
    case "biggest-single-loss":
    case "biggest-single-win":
      return value;
    default:
      return "lifetime-pnl";
  }
}

export type WhaleRow = {
  userId: string;
  username: string | null;
  image: string | null;
  amount: number;
  // Tooltip / sub-text. Empty string allowed.
  detail: string;
};

const LIMIT = 25;

/**
 * Capped lookback (days) for the "lifetime" / "biggest single" whale
 * lenses. A TRUE unbounded scan of `ledger_transactions` /
 * `card_withdrawal_requests` (no `created_at` lower bound) is the
 * unbounded-lifetime pattern CLAUDE.md ("Performance & Daten-Laden")
 * forbids — on prod-sized history it blows the per-lens `safeQuery`
 * timeout and the lens degrades to an empty list. Bounded to 365d to
 * match `INSIGHTS_LIFETIME_LOOKBACK_DAYS` (insights-rewards `_period.ts`)
 * and `overview.ts`'s `OVERVIEW_LIFETIME_LOOKBACK_DAYS`. The value is
 * duplicated as a local constant the SAME way those modules inline 365
 * with a reference comment, to keep this module decoupled.
 */
const WHALES_LIFETIME_LOOKBACK_DAYS = 365;

/**
 * Single dispatcher — picks the lens query so the tab UI doesn't have
 * to know how each lens is computed.
 *
 * Each lens runs inside `safeQuery` (canonical heavy-read timeout, empty
 * fallback) so a slow/failed lens degrades to `[]` and never hangs the
 * tab segment — the same per-leg resilience `getInsightsOverview` applies.
 */
export async function getInsightsWhales(lens: WhalesLens): Promise<WhaleRow[]> {
  const { data } = await safeQuery(
    () => fetchWhalesLens(lens),
    [] as WhaleRow[],
    `insights-analytics.whales.${lens}`,
    REWARD_QUERY_TIMEOUT_MS,
  );
  return data;
}

/** Inner dispatch — resolves the scope + runs the active lens query. */
async function fetchWhalesLens(lens: WhalesLens): Promise<WhaleRow[]> {
  switch (lens) {
    case "lifetime-pnl":
      return getLifetimePnlWhales();
    case "lifetime-wager":
      return getLifetimeWagerWhales();
    case "wager-7d":
      return getWindowedWagerWhales(7);
    case "wager-30d":
      return getWindowedWagerWhales(30);
    case "biggest-deposit":
      return getBiggestSingleDeposit();
    case "biggest-withdrawal":
      return getBiggestSingleWithdrawal();
    case "biggest-single-loss":
      return getBiggestSingleLoss();
    case "biggest-single-win":
      return getBiggestSingleWin();
  }
}

/**
 * Lifetime P&L = wager − payouts per user (house POV; positive = house
 * up = bad luck for the user). Excludes creator on-stream play via the
 * shared session_windows CTE. Bounded to the last 365 days so the scan
 * stays tractable (see `WHALES_LIFETIME_LOOKBACK_DAYS`).
 */
async function getLifetimePnlWhales(): Promise<WhaleRow[]> {
  const excluded = await getExcludedUserIds();
  const blacklistIdNotIn = blacklistNotInClause("u.id", excluded);
  const sessionWindowsCte = await getCreatorSessionWindowsCte();
  const rows = await cachedLifetimePnlWhales(blacklistIdNotIn, sessionWindowsCte);
  return rows.map((r) => ({
    userId: r.id,
    username: r.username,
    image: r.image,
    amount: toNumber(r.pnl),
    detail: `${formatUsd(toNumber(r.wager))} lifetime wager`,
  }));
}

const cachedLifetimePnlWhales = unstable_cache(
  async (
    blacklistIdNotIn: string,
    sessionWindowsCte: string,
  ): Promise<
    { id: string; username: string | null; image: string | null; pnl: string; wager: string }[]
  > => {
    const since = new Date(
      Date.now() - WHALES_LIFETIME_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
    );
    return queryMainRows<
      {
        id: string;
        username: string | null;
        image: string | null;
        pnl: string;
        wager: string;
      }[]
    >(
      `
      WITH real_users AS (
        SELECT u.id, u.username, u.image, u.role FROM "user" u
        WHERE u.role NOT IN ('admin', 'support') ${blacklistIdNotIn}
      ),
      ${sessionWindowsCte},
      base AS (
        SELECT lt.user_id, lt.type, lt.amount::numeric AS amount,
               CASE WHEN ru.role = 'creator'
                    THEN EXISTS (
                      SELECT 1 FROM session_windows sw
                      WHERE sw.uid = lt.user_id
                        AND lt.created_at >= sw.win_start
                        AND lt.created_at <  sw.win_end
                    )
                    ELSE false END AS in_session
        FROM ledger_transactions lt
        JOIN real_users ru ON ru.id = lt.user_id
        WHERE lt.status = 'completed' AND lt.created_at >= $1
      )
      SELECT
        ru.id, ru.username, ru.image,
        (
          COALESCE(SUM(CASE WHEN b.type::text IN ${WAGER_TYPES_SQL} AND NOT b.in_session THEN ABS(b.amount) ELSE 0 END), 0)
          - COALESCE(SUM(CASE WHEN b.type::text IN ${PAYOUT_TYPES_SQL} AND NOT b.in_session THEN ABS(b.amount) ELSE 0 END), 0)
        )::text AS pnl,
        COALESCE(SUM(CASE WHEN b.type::text IN ${WAGER_TYPES_SQL} AND NOT b.in_session THEN ABS(b.amount) ELSE 0 END), 0)::text AS wager
      FROM real_users ru
      LEFT JOIN base b ON b.user_id = ru.id
      GROUP BY ru.id, ru.username, ru.image
      HAVING (
        COALESCE(SUM(CASE WHEN b.type::text IN ${WAGER_TYPES_SQL} AND NOT b.in_session THEN ABS(b.amount) ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN b.type::text IN ${PAYOUT_TYPES_SQL} AND NOT b.in_session THEN ABS(b.amount) ELSE 0 END), 0)
      ) > 0
      ORDER BY (
        COALESCE(SUM(CASE WHEN b.type::text IN ${WAGER_TYPES_SQL} AND NOT b.in_session THEN ABS(b.amount) ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN b.type::text IN ${PAYOUT_TYPES_SQL} AND NOT b.in_session THEN ABS(b.amount) ELSE 0 END), 0)
      ) DESC
      LIMIT $2
      `,
      since,
      LIMIT,
    );
  },
  ["insights-analytics-whales-lifetime-pnl-v1"],
  { revalidate: 300, tags: ["insights-analytics", "dashboard-lifetime"] },
);

async function getLifetimeWagerWhales(): Promise<WhaleRow[]> {
  const excluded = await getExcludedUserIds();
  const blacklistIdNotIn = blacklistNotInClause("u.id", excluded);
  const rows = await cachedLifetimeWagerWhales(blacklistIdNotIn);
  return rows.map((r) => ({
    userId: r.id,
    username: r.username,
    image: r.image,
    amount: toNumber(r.amount),
    detail: "Lifetime wager",
  }));
}

const cachedLifetimeWagerWhales = unstable_cache(
  async (
    blacklistIdNotIn: string,
  ): Promise<
    { id: string; username: string | null; image: string | null; amount: string }[]
  > => {
    const since = new Date(
      Date.now() - WHALES_LIFETIME_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
    );
    return queryMainRows<
      { id: string; username: string | null; image: string | null; amount: string }[]
    >(
      `
      SELECT u.id, u.username, u.image,
             SUM(ABS(lt.amount::numeric))::text AS amount
      FROM ledger_transactions lt
      JOIN "user" u ON u.id = lt.user_id
      WHERE lt.status = 'completed' AND lt.type::text IN ${WAGER_TYPES_SQL}
        AND lt.created_at >= $1
        AND u.role NOT IN ('admin', 'support') ${blacklistIdNotIn}
      GROUP BY u.id, u.username, u.image
      ORDER BY SUM(ABS(lt.amount::numeric)) DESC
      LIMIT $2
      `,
      since,
      LIMIT,
    );
  },
  ["insights-analytics-whales-lifetime-wager-v1"],
  { revalidate: 300, tags: ["insights-analytics", "dashboard-lifetime"] },
);

async function getWindowedWagerWhales(days: number): Promise<WhaleRow[]> {
  const excluded = await getExcludedUserIds();
  const blacklistIdNotIn = blacklistNotInClause("u.id", excluded);
  const rows = await cachedWindowedWagerWhales(days, blacklistIdNotIn);
  return rows.map((r) => ({
    userId: r.id,
    username: r.username,
    image: r.image,
    amount: toNumber(r.amount),
    detail: `Wager · last ${days}d`,
  }));
}

const cachedWindowedWagerWhales = unstable_cache(
  async (
    days: number,
    blacklistIdNotIn: string,
  ): Promise<
    { id: string; username: string | null; image: string | null; amount: string }[]
  > => {
    return queryMainRows<
      { id: string; username: string | null; image: string | null; amount: string }[]
    >(`
      SELECT u.id, u.username, u.image,
             SUM(ABS(lt.amount::numeric))::text AS amount
      FROM ledger_transactions lt
      JOIN "user" u ON u.id = lt.user_id
      WHERE lt.status = 'completed' AND lt.type::text IN ${WAGER_TYPES_SQL}
        AND u.role NOT IN ('admin', 'support') ${blacklistIdNotIn}
        AND lt.created_at >= NOW() - make_interval(days => $1::int)
      GROUP BY u.id, u.username, u.image
      ORDER BY SUM(ABS(lt.amount::numeric)) DESC
      LIMIT $2
    `, days, LIMIT);
  },
  ["insights-analytics-whales-windowed-wager-v1"],
  { revalidate: 300, tags: ["insights-analytics", "dashboard-lifetime"] },
);

async function getBiggestSingleDeposit(): Promise<WhaleRow[]> {
  const excluded = await getExcludedUserIds();
  const blacklistIdNotIn = blacklistNotInClause("u.id", excluded);
  const rows = await cachedBiggestSingleDeposit(blacklistIdNotIn);
  return rows.map((r) => ({
    userId: r.id,
    username: r.username,
    image: r.image,
    amount: toNumber(r.amount),
    detail: isoDate(r.created_at),
  }));
}

const cachedBiggestSingleDeposit = unstable_cache(
  async (
    blacklistIdNotIn: string,
  ): Promise<
    {
      id: string;
      username: string | null;
      image: string | null;
      amount: string;
      // `Date` on a cache miss; the ISO string `unstable_cache` serialized
      // it to on a hit — `isoDate()` in the mapper normalizes both.
      created_at: Date | string;
    }[]
  > => {
    const since = new Date(
      Date.now() - WHALES_LIFETIME_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
    );
    return queryMainRows<
      {
        id: string;
        username: string | null;
        image: string | null;
        amount: string;
        created_at: Date;
      }[]
    >(
      `
      SELECT u.id, u.username, u.image,
             ABS(lt.amount::numeric)::text AS amount,
             lt.created_at
      FROM ledger_transactions lt
      JOIN "user" u ON u.id = lt.user_id
      WHERE lt.status = 'completed' AND lt.type::text = 'deposit'
        AND lt.created_at >= $1
        AND u.role NOT IN ('admin', 'support') ${blacklistIdNotIn}
      ORDER BY ABS(lt.amount::numeric) DESC
      LIMIT $2
      `,
      since,
      LIMIT,
    );
  },
  ["insights-analytics-whales-biggest-deposit-v1"],
  { revalidate: 300, tags: ["insights-analytics", "dashboard-lifetime"] },
);

async function getBiggestSingleWithdrawal(): Promise<WhaleRow[]> {
  const excluded = await getExcludedUserIds();
  const blacklistIdNotIn = blacklistNotInClause("u.id", excluded);
  const rows = await cachedBiggestSingleWithdrawal(blacklistIdNotIn);
  return rows.map((r) => ({
    userId: r.id,
    username: r.username,
    image: r.image,
    amount: toNumber(r.amount),
    detail: isoDate(r.created_at),
  }));
}

const cachedBiggestSingleWithdrawal = unstable_cache(
  async (
    blacklistIdNotIn: string,
  ): Promise<
    {
      id: string;
      username: string | null;
      image: string | null;
      amount: string;
      // `Date` on a cache miss; the ISO string `unstable_cache` serialized
      // it to on a hit — `isoDate()` in the mapper normalizes both.
      created_at: Date | string;
    }[]
  > => {
    const since = new Date(
      Date.now() - WHALES_LIFETIME_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
    );
    return queryMainRows<
      {
        id: string;
        username: string | null;
        image: string | null;
        amount: string;
        created_at: Date;
      }[]
    >(
      `
      SELECT u.id, u.username, u.image,
             cwr.total_value_usd::text AS amount,
             COALESCE(cwr.completed_at, cwr.shipped_at, cwr.created_at) AS created_at
      FROM card_withdrawal_requests cwr
      JOIN "user" u ON u.id = cwr.user_id
      WHERE cwr.status IN ('completed', 'shipped')
        AND COALESCE(cwr.completed_at, cwr.shipped_at, cwr.created_at) >= $1
        AND u.role NOT IN ('admin', 'support') ${blacklistIdNotIn}
      ORDER BY cwr.total_value_usd DESC
      LIMIT $2
      `,
      since,
      LIMIT,
    );
  },
  ["insights-analytics-whales-biggest-withdrawal-v1"],
  { revalidate: 300, tags: ["insights-analytics", "dashboard-lifetime"] },
);

/**
 * Biggest single house gain (user loss) — single wager row by ABS amount
 * where the type is a wager.
 */
async function getBiggestSingleLoss(): Promise<WhaleRow[]> {
  const excluded = await getExcludedUserIds();
  const blacklistIdNotIn = blacklistNotInClause("u.id", excluded);
  const rows = await cachedBiggestSingleLoss(blacklistIdNotIn);
  return rows.map((r) => ({
    userId: r.id,
    username: r.username,
    image: r.image,
    amount: toNumber(r.amount),
    detail: `${r.type} · ${isoDate(r.created_at)}`,
  }));
}

const cachedBiggestSingleLoss = unstable_cache(
  async (
    blacklistIdNotIn: string,
  ): Promise<
    {
      id: string;
      username: string | null;
      image: string | null;
      amount: string;
      type: string;
      // `Date` on a cache miss; the ISO string `unstable_cache` serialized
      // it to on a hit — `isoDate()` in the mapper normalizes both.
      created_at: Date | string;
    }[]
  > => {
    const since = new Date(
      Date.now() - WHALES_LIFETIME_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
    );
    return queryMainRows<
      {
        id: string;
        username: string | null;
        image: string | null;
        amount: string;
        type: string;
        created_at: Date;
      }[]
    >(
      `
      SELECT u.id, u.username, u.image,
             ABS(lt.amount::numeric)::text AS amount,
             lt.type::text AS type,
             lt.created_at
      FROM ledger_transactions lt
      JOIN "user" u ON u.id = lt.user_id
      WHERE lt.status = 'completed' AND lt.type::text IN ${WAGER_TYPES_SQL}
        AND lt.created_at >= $1
        AND u.role NOT IN ('admin', 'support') ${blacklistIdNotIn}
      ORDER BY ABS(lt.amount::numeric) DESC
      LIMIT $2
      `,
      since,
      LIMIT,
    );
  },
  ["insights-analytics-whales-biggest-loss-v1"],
  { revalidate: 300, tags: ["insights-analytics", "dashboard-lifetime"] },
);

/**
 * Biggest single house loss (user win) — single payout row by ABS amount.
 */
async function getBiggestSingleWin(): Promise<WhaleRow[]> {
  const excluded = await getExcludedUserIds();
  const blacklistIdNotIn = blacklistNotInClause("u.id", excluded);
  const rows = await cachedBiggestSingleWin(blacklistIdNotIn);
  return rows.map((r) => ({
    userId: r.id,
    username: r.username,
    image: r.image,
    amount: toNumber(r.amount),
    detail: `${r.type} · ${isoDate(r.created_at)}`,
  }));
}

const cachedBiggestSingleWin = unstable_cache(
  async (
    blacklistIdNotIn: string,
  ): Promise<
    {
      id: string;
      username: string | null;
      image: string | null;
      amount: string;
      type: string;
      // `Date` on a cache miss; the ISO string `unstable_cache` serialized
      // it to on a hit — `isoDate()` in the mapper normalizes both.
      created_at: Date | string;
    }[]
  > => {
    const since = new Date(
      Date.now() - WHALES_LIFETIME_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
    );
    return queryMainRows<
      {
        id: string;
        username: string | null;
        image: string | null;
        amount: string;
        type: string;
        created_at: Date;
      }[]
    >(
      `
      SELECT u.id, u.username, u.image,
             ABS(lt.amount::numeric)::text AS amount,
             lt.type::text AS type,
             lt.created_at
      FROM ledger_transactions lt
      JOIN "user" u ON u.id = lt.user_id
      WHERE lt.status = 'completed' AND lt.type::text IN ${PAYOUT_TYPES_SQL}
        AND lt.created_at >= $1
        AND u.role NOT IN ('admin', 'support') ${blacklistIdNotIn}
      ORDER BY ABS(lt.amount::numeric) DESC
      LIMIT $2
      `,
      since,
      LIMIT,
    );
  },
  ["insights-analytics-whales-biggest-win-v1"],
  { revalidate: 300, tags: ["insights-analytics", "dashboard-lifetime"] },
);

function formatUsd(n: number): string {
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

/**
 * `YYYY-MM-DD` from a `created_at` that may be a `Date` (cache miss) or the
 * ISO string `unstable_cache`'s JSON serialization produced (cache hit). A
 * bare string has no `.toISOString()` — calling it directly threw the same
 * `TypeError` the cohorts tab hit, the moment a `biggest-*` lens is opened
 * after its 300s cache fills. Coerce, then slice.
 */
function isoDate(v: Date | string): string {
  return (v instanceof Date ? v : new Date(v)).toISOString().slice(0, 10);
}
