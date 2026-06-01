import "server-only";

import { getDb } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { toNumber } from "@/lib/utils/decimal";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "@/lib/queries/_blacklist";
import { getCreatorSessionWindowsCte } from "@/lib/queries/creator-session-windows";
import {
  WAGER_TYPES_SQL,
  PAYOUT_TYPES_SQL,
} from "@/lib/queries/_wager-payout-types";

/**
 * Top-N "whales" lenses. The user requested multiple top-10 lists by
 * lifetime P&L, lifetime wager, 7d wager, biggest single deposit,
 * biggest single withdrawal. This helper exposes one async function
 * per lens so the tab can fetch only the active lens.
 *
 * Each query is read-only against the Main DB. Staff (admin/support)
 * and the manual blacklist are excluded.
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
 * Single dispatcher — picks the lens query so the tab UI doesn't have
 * to know how each lens is computed.
 */
export async function getInsightsWhales(lens: WhalesLens): Promise<WhaleRow[]> {
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
 * shared session_windows CTE.
 */
async function getLifetimePnlWhales(): Promise<WhaleRow[]> {
  const db = await getDb();
  const excluded = await getExcludedUserIds();
  const blacklistIdNotIn = blacklistNotInClause("u.id", excluded);
  const sessionWindowsCte = await getCreatorSessionWindowsCte();
  const ggrWagerIn = Prisma.raw(WAGER_TYPES_SQL);
  const ggrPayoutIn = Prisma.raw(PAYOUT_TYPES_SQL);

  const rows = await db.$queryRaw<
    {
      id: string;
      username: string | null;
      image: string | null;
      pnl: string;
      wager: string;
    }[]
  >`
    WITH real_users AS (
      SELECT u.id, u.username, u.image, u.role FROM "user" u
      WHERE u.role NOT IN ('admin', 'support') ${Prisma.raw(blacklistIdNotIn)}
    ),
    ${Prisma.raw(sessionWindowsCte)},
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
      WHERE lt.status = 'completed'
    )
    SELECT
      ru.id, ru.username, ru.image,
      (
        COALESCE(SUM(CASE WHEN b.type IN ${ggrWagerIn} AND NOT b.in_session THEN ABS(b.amount) ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN b.type IN ${ggrPayoutIn} AND NOT b.in_session THEN ABS(b.amount) ELSE 0 END), 0)
      )::text AS pnl,
      COALESCE(SUM(CASE WHEN b.type IN ${ggrWagerIn} AND NOT b.in_session THEN ABS(b.amount) ELSE 0 END), 0)::text AS wager
    FROM real_users ru
    LEFT JOIN base b ON b.user_id = ru.id
    GROUP BY ru.id, ru.username, ru.image
    HAVING (
      COALESCE(SUM(CASE WHEN b.type IN ${ggrWagerIn} AND NOT b.in_session THEN ABS(b.amount) ELSE 0 END), 0)
      - COALESCE(SUM(CASE WHEN b.type IN ${ggrPayoutIn} AND NOT b.in_session THEN ABS(b.amount) ELSE 0 END), 0)
    ) > 0
    ORDER BY pnl::numeric DESC
    LIMIT ${LIMIT}
  `;
  return rows.map((r) => ({
    userId: r.id,
    username: r.username,
    image: r.image,
    amount: toNumber(r.pnl),
    detail: `${formatUsd(toNumber(r.wager))} lifetime wager`,
  }));
}

async function getLifetimeWagerWhales(): Promise<WhaleRow[]> {
  const db = await getDb();
  const excluded = await getExcludedUserIds();
  const blacklistIdNotIn = blacklistNotInClause("u.id", excluded);
  const ggrWagerIn = Prisma.raw(WAGER_TYPES_SQL);
  const rows = await db.$queryRaw<
    { id: string; username: string | null; image: string | null; amount: string }[]
  >`
    SELECT u.id, u.username, u.image,
           SUM(ABS(lt.amount::numeric))::text AS amount
    FROM ledger_transactions lt
    JOIN "user" u ON u.id = lt.user_id
    WHERE lt.status = 'completed' AND lt.type IN ${ggrWagerIn}
      AND u.role NOT IN ('admin', 'support') ${Prisma.raw(blacklistIdNotIn)}
    GROUP BY u.id, u.username, u.image
    ORDER BY SUM(ABS(lt.amount::numeric)) DESC
    LIMIT ${LIMIT}
  `;
  return rows.map((r) => ({
    userId: r.id,
    username: r.username,
    image: r.image,
    amount: toNumber(r.amount),
    detail: "Lifetime wager",
  }));
}

async function getWindowedWagerWhales(days: number): Promise<WhaleRow[]> {
  const db = await getDb();
  const excluded = await getExcludedUserIds();
  const blacklistIdNotIn = blacklistNotInClause("u.id", excluded);
  const rows = await db.$queryRawUnsafe<
    { id: string; username: string | null; image: string | null; amount: string }[]
  >(`
    SELECT u.id, u.username, u.image,
           SUM(ABS(lt.amount::numeric))::text AS amount
    FROM ledger_transactions lt
    JOIN "user" u ON u.id = lt.user_id
    WHERE lt.status = 'completed' AND lt.type IN ${WAGER_TYPES_SQL}
      AND u.role NOT IN ('admin', 'support') ${blacklistIdNotIn}
      AND lt.created_at >= NOW() - INTERVAL '${days} days'
    GROUP BY u.id, u.username, u.image
    ORDER BY SUM(ABS(lt.amount::numeric)) DESC
    LIMIT ${LIMIT}
  `);
  return rows.map((r) => ({
    userId: r.id,
    username: r.username,
    image: r.image,
    amount: toNumber(r.amount),
    detail: `Wager · last ${days}d`,
  }));
}

async function getBiggestSingleDeposit(): Promise<WhaleRow[]> {
  const db = await getDb();
  const excluded = await getExcludedUserIds();
  const blacklistIdNotIn = blacklistNotInClause("u.id", excluded);
  const rows = await db.$queryRaw<
    {
      id: string;
      username: string | null;
      image: string | null;
      amount: string;
      created_at: Date;
    }[]
  >`
    SELECT u.id, u.username, u.image,
           ABS(lt.amount::numeric)::text AS amount,
           lt.created_at
    FROM ledger_transactions lt
    JOIN "user" u ON u.id = lt.user_id
    WHERE lt.status = 'completed' AND lt.type = 'deposit'
      AND u.role NOT IN ('admin', 'support') ${Prisma.raw(blacklistIdNotIn)}
    ORDER BY ABS(lt.amount::numeric) DESC
    LIMIT ${LIMIT}
  `;
  return rows.map((r) => ({
    userId: r.id,
    username: r.username,
    image: r.image,
    amount: toNumber(r.amount),
    detail: r.created_at.toISOString().slice(0, 10),
  }));
}

async function getBiggestSingleWithdrawal(): Promise<WhaleRow[]> {
  const db = await getDb();
  const excluded = await getExcludedUserIds();
  const blacklistIdNotIn = blacklistNotInClause("u.id", excluded);
  const rows = await db.$queryRaw<
    {
      id: string;
      username: string | null;
      image: string | null;
      amount: string;
      created_at: Date;
    }[]
  >`
    SELECT u.id, u.username, u.image,
           cwr.total_value_usd::text AS amount,
           COALESCE(cwr.completed_at, cwr.shipped_at, cwr.created_at) AS created_at
    FROM card_withdrawal_requests cwr
    JOIN "user" u ON u.id = cwr.user_id
    WHERE cwr.status IN ('completed', 'shipped')
      AND u.role NOT IN ('admin', 'support') ${Prisma.raw(blacklistIdNotIn)}
    ORDER BY cwr.total_value_usd DESC
    LIMIT ${LIMIT}
  `;
  return rows.map((r) => ({
    userId: r.id,
    username: r.username,
    image: r.image,
    amount: toNumber(r.amount),
    detail: r.created_at.toISOString().slice(0, 10),
  }));
}

/**
 * Biggest single house gain (user loss) — single wager row by ABS amount
 * where the type is a wager.
 */
async function getBiggestSingleLoss(): Promise<WhaleRow[]> {
  const db = await getDb();
  const excluded = await getExcludedUserIds();
  const blacklistIdNotIn = blacklistNotInClause("u.id", excluded);
  const ggrWagerIn = Prisma.raw(WAGER_TYPES_SQL);
  const rows = await db.$queryRaw<
    {
      id: string;
      username: string | null;
      image: string | null;
      amount: string;
      type: string;
      created_at: Date;
    }[]
  >`
    SELECT u.id, u.username, u.image,
           ABS(lt.amount::numeric)::text AS amount,
           lt.type::text AS type,
           lt.created_at
    FROM ledger_transactions lt
    JOIN "user" u ON u.id = lt.user_id
    WHERE lt.status = 'completed' AND lt.type IN ${ggrWagerIn}
      AND u.role NOT IN ('admin', 'support') ${Prisma.raw(blacklistIdNotIn)}
    ORDER BY ABS(lt.amount::numeric) DESC
    LIMIT ${LIMIT}
  `;
  return rows.map((r) => ({
    userId: r.id,
    username: r.username,
    image: r.image,
    amount: toNumber(r.amount),
    detail: `${r.type} · ${r.created_at.toISOString().slice(0, 10)}`,
  }));
}

/**
 * Biggest single house loss (user win) — single payout row by ABS amount.
 */
async function getBiggestSingleWin(): Promise<WhaleRow[]> {
  const db = await getDb();
  const excluded = await getExcludedUserIds();
  const blacklistIdNotIn = blacklistNotInClause("u.id", excluded);
  const ggrPayoutIn = Prisma.raw(PAYOUT_TYPES_SQL);
  const rows = await db.$queryRaw<
    {
      id: string;
      username: string | null;
      image: string | null;
      amount: string;
      type: string;
      created_at: Date;
    }[]
  >`
    SELECT u.id, u.username, u.image,
           ABS(lt.amount::numeric)::text AS amount,
           lt.type::text AS type,
           lt.created_at
    FROM ledger_transactions lt
    JOIN "user" u ON u.id = lt.user_id
    WHERE lt.status = 'completed' AND lt.type IN ${ggrPayoutIn}
      AND u.role NOT IN ('admin', 'support') ${Prisma.raw(blacklistIdNotIn)}
    ORDER BY ABS(lt.amount::numeric) DESC
    LIMIT ${LIMIT}
  `;
  return rows.map((r) => ({
    userId: r.id,
    username: r.username,
    image: r.image,
    amount: toNumber(r.amount),
    detail: `${r.type} · ${r.created_at.toISOString().slice(0, 10)}`,
  }));
}

function formatUsd(n: number): string {
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}
