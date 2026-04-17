import { db } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { EXCLUDE_STAFF_USER_RELATION } from "./_exclude-staff";

/**
 * Live-feed queries for the dashboard. Kept separate from the general
 * dashboard queries because these are polled on a short interval (~3s)
 * and must stay small and cheap.
 *
 * Cursor contract: `sinceCreatedAt` is the last-seen item's created_at as
 * an ISO string. `null` means "first fetch, give me the latest N". Strict
 * `gt` comparison on the server so the client never sees the same row
 * twice even when multiple rows share a millisecond tick.
 */

export type LiveDepositItem = {
  id: string;
  userId: string;
  username: string;
  image: string | null;
  amount: number;
  bonusAmount: number | null;
  cryptoAsset: string | null;
  createdAt: string;
};

export type LiveDepositsResult = {
  items: LiveDepositItem[];
  total24h: number;
};

/**
 * Newest completed deposits since the cursor. Staff excluded so the feed
 * matches the rest of the dashboard. Orphan `deposit_bonus` rows (i.e.
 * admin-granted bonuses with no parent deposit inside the same 2-minute
 * window) are not surfaced — the live feed is about real money coming in.
 */
export async function getLiveDeposits(params: {
  sinceCreatedAt: string | null;
  limit: number;
}): Promise<LiveDepositsResult> {
  const limit = Math.max(1, Math.min(50, Math.floor(params.limit)));
  const since = params.sinceCreatedAt ? new Date(params.sinceCreatedAt) : null;

  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [rows, total24hAgg] = await Promise.all([
    db.ledger_transactions.findMany({
      where: {
        type: "deposit",
        status: "completed",
        ...(since ? { created_at: { gt: since } } : {}),
        user: EXCLUDE_STAFF_USER_RELATION,
      },
      orderBy: { created_at: "desc" },
      take: limit,
      include: {
        user: { select: { username: true, email: true, image: true } },
      },
    }),
    db.ledger_transactions.aggregate({
      where: {
        type: "deposit",
        status: "completed",
        created_at: { gte: dayAgo },
        user: EXCLUDE_STAFF_USER_RELATION,
      },
      _sum: { amount: true },
    }),
  ]);

  // Fetch matching deposit_bonus rows for this slice in a single query so we
  // can show the bonus next to the deposit amount. Same pairing rule used in
  // getDepositTransactions: same user, bonus.balance_before = deposit.balance_after,
  // bonus fires within 2 minutes after its parent deposit.
  const userIds = Array.from(new Set(rows.map((r) => r.user_id)));
  const bonusRows =
    rows.length > 0
      ? await db.ledger_transactions.findMany({
          where: {
            type: "deposit_bonus",
            status: "completed",
            user_id: { in: userIds },
            created_at: {
              gte: new Date(rows[rows.length - 1].created_at.getTime()),
              lt: new Date(rows[0].created_at.getTime() + 2 * 60 * 1000),
            },
          },
          select: {
            user_id: true,
            balance_before: true,
            amount: true,
            created_at: true,
          },
        })
      : [];

  // Key: user_id + balance_before as a string (Decimal is object-y, so we
  // normalise via toFixed(2) to match how amounts are stored).
  const bonusByKey = new Map<string, number>();
  for (const b of bonusRows) {
    const key = `${b.user_id}|${toNumber(b.balance_before).toFixed(2)}`;
    // If two bonus rows could match (shouldn't happen but defensively), keep
    // the earliest so we don't show an unrelated later top-up.
    if (!bonusByKey.has(key)) {
      bonusByKey.set(key, toNumber(b.amount));
    }
  }

  const items: LiveDepositItem[] = rows.map((r) => {
    const key = `${r.user_id}|${toNumber(r.balance_after).toFixed(2)}`;
    const bonus = bonusByKey.get(key) ?? null;
    return {
      id: r.id,
      userId: r.user_id,
      username: r.user?.username ?? r.user?.email ?? "Unknown",
      image: r.user?.image ?? null,
      amount: toNumber(r.amount),
      bonusAmount: bonus,
      cryptoAsset: r.crypto_asset,
      createdAt: r.created_at.toISOString(),
    };
  });

  return {
    items,
    total24h: toNumber(total24hAgg._sum?.amount),
  };
}

// ─── Live Activity ────────────────────────────────────────────────

export type LiveActivityEventKind =
  | "deposit"
  | "withdrawal"
  | "wager"
  | "card_sale"
  | "payout"
  | "signup";

export type LiveActivityItem = {
  id: string;
  kind: LiveActivityEventKind;
  /** Raw ledger type (e.g. "pack_opening") for the signup path this is "signup". */
  type: string;
  userId: string;
  username: string;
  image: string | null;
  amount: number | null;
  detail: string | null;
  createdAt: string;
};

// Wager / payout types filtered only for "interesting" events (big-ish or
// payout-ish). Exact amount threshold tuned so the feed doesn't become a
// waterfall of $1 pack openings. Kept here (not in the dashboard page) so
// the query stays stable regardless of where it's called from.
const INTERESTING_WAGER_MIN = 25; // $25+ wager counts as "interesting"
const INTERESTING_PAYOUT_MIN = 10; // $10+ card_sale / big win

/**
 * A mixed "interesting events" stream: signups + payouts + card sales +
 * significant wagers + deposits + withdrawals. Not a strict superset of the
 * deposits feed — we also show small deposits here so admins get a single
 * unified heartbeat of the platform.
 *
 * Implementation note: we pull each source independently (ledger + signups)
 * and merge client-side because the two sources live in different tables
 * with different date semantics. Limit is applied after the merge so we
 * return the globally-newest N across all sources.
 */
export async function getLiveActivity(params: {
  sinceCreatedAt: string | null;
  limit: number;
}): Promise<LiveActivityItem[]> {
  const limit = Math.max(1, Math.min(60, Math.floor(params.limit)));
  const since = params.sinceCreatedAt ? new Date(params.sinceCreatedAt) : null;

  const [ledgerRows, signupRows] = await Promise.all([
    db.ledger_transactions.findMany({
      where: {
        status: "completed",
        ...(since ? { created_at: { gt: since } } : {}),
        user: EXCLUDE_STAFF_USER_RELATION,
        OR: [
          { type: "deposit" },
          { type: "card_withdrawal" },
          { type: "creator_tip" },
          { type: "rain_win" },
          { type: "race_prize" },
          {
            type: { in: ["card_sale", "reward_card_sale"] },
            amount: { gte: INTERESTING_PAYOUT_MIN },
          },
          {
            type: { in: ["pack_opening", "battle_bet", "battle_sponsorship"] },
            amount: { lte: -INTERESTING_WAGER_MIN },
          },
        ],
      },
      orderBy: { created_at: "desc" },
      take: limit,
      include: {
        user: { select: { username: true, email: true, image: true } },
      },
    }),
    db.user.findMany({
      where: {
        role: { notIn: ["admin", "creator"] },
        ...(since ? { created_at: { gt: since } } : {}),
      },
      orderBy: { created_at: "desc" },
      take: limit,
      select: {
        id: true,
        username: true,
        email: true,
        image: true,
        created_at: true,
      },
    }),
  ]);

  const ledgerItems: LiveActivityItem[] = ledgerRows.map((r) => ({
    id: `tx:${r.id}`,
    kind: classifyLedgerKind(r.type),
    type: r.type,
    userId: r.user_id,
    username: r.user?.username ?? r.user?.email ?? "Unknown",
    image: r.user?.image ?? null,
    // Store the absolute amount so the UI can sign it via `kind`.
    amount: Math.abs(toNumber(r.amount)),
    detail: r.description || null,
    createdAt: r.created_at.toISOString(),
  }));

  const signupItems: LiveActivityItem[] = signupRows.map((u) => ({
    id: `user:${u.id}`,
    kind: "signup",
    type: "signup",
    userId: u.id,
    username: u.username ?? u.email ?? "Unknown",
    image: u.image,
    amount: null,
    detail: null,
    createdAt: u.created_at.toISOString(),
  }));

  return [...ledgerItems, ...signupItems]
    .sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    )
    .slice(0, limit);
}

function classifyLedgerKind(type: string): LiveActivityEventKind {
  switch (type) {
    case "deposit":
      return "deposit";
    case "card_withdrawal":
      return "withdrawal";
    case "pack_opening":
    case "battle_bet":
    case "battle_sponsorship":
      return "wager";
    case "card_sale":
    case "reward_card_sale":
      return "card_sale";
    case "rain_win":
    case "race_prize":
    case "creator_tip":
      return "payout";
    default:
      return "payout";
  }
}
