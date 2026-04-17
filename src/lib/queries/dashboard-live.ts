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

/**
 * A live feed of every platform event the admin cares about: signups +
 * deposits + withdrawals + pack/battle wagers + card sales + rain wins +
 * race prizes + creator tips. No amount thresholds — admins wanted to
 * see the full heartbeat, including the small $1 pack openings.
 *
 * Implementation note: we pull each source independently (ledger +
 * signups) and merge client-side because the two sources live in
 * different tables with different date semantics. Limit is applied
 * after the merge so we return the globally-newest N across all
 * sources.
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
        type: {
          in: [
            "deposit",
            "card_withdrawal",
            "creator_tip",
            "rain_win",
            "race_prize",
            "pack_opening",
            "battle_bet",
            "battle_sponsorship",
            // Battle wins — the house paying a user back because they
            // won. Classified as a payout (red) so the feed actually
            // shows every win, not just the bet that started it.
            "battle_refund",
            // Bonus credits the house granted — rakeback / affiliate
            // claims / admin balance adjustments / deposit bonuses.
            "rakeback_claim",
            "affiliate_claim",
            "deposit_bonus",
            "admin_balance_adjustment",
            "balance_reward_claim",
            "waitlist_prize",
            "gift_card_redeemed",
            "promo_code_redeemed",
            "voucher_redeemed",
            // card_sale / reward_card_sale intentionally excluded — the
            // user already "paid" for the card via a pack or battle, so
            // selling it back is a balance-neutral round-trip in the
            // feed (the pack/battle rows already capture the gambling
            // P&L; surfacing the sale adds noise without new info).
          ],
        },
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

// House-perspective classifier. `wager` = money flowing INTO the house
// (bet placed, green). Everything else that gives the user money is a
// `payout` (red). `deposit` / `withdrawal` / `card_sale` kept as
// specific kinds so the icon + label read naturally.
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
    // Anything that credits the user's balance — battle wins, rakeback,
    // affiliate claims, admin top-ups, reward claims, bonuses, etc.
    case "battle_refund":
    case "rakeback_claim":
    case "affiliate_claim":
    case "deposit_bonus":
    case "admin_balance_adjustment":
    case "balance_reward_claim":
    case "waitlist_prize":
    case "gift_card_redeemed":
    case "promo_code_redeemed":
    case "voucher_redeemed":
    case "rain_win":
    case "race_prize":
    case "creator_tip":
      return "payout";
    default:
      return "payout";
  }
}
