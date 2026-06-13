import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { MS_PER_DAY } from "@/lib/utils/time";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { STAFF_ROLES } from "./_exclude-staff";
import { excludeStaffCreatorsAndBlacklisted } from "./_blacklist";
import { officialStreamAdjustmentPrismaWhere } from "@/lib/balance-adjustment-categories";
import { user_role } from "@/generated/prisma/enums";

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
  const db = await getDb();
  const limit = Math.max(1, Math.min(50, Math.floor(params.limit)));
  const since = params.sinceCreatedAt ? new Date(params.sinceCreatedAt) : null;
  const staffRelation = await excludeStaffCreatorsAndBlacklisted();

  const dayAgo = new Date(Date.now() - MS_PER_DAY);

  const [rows, total24hAgg] = await Promise.all([
    db.ledger_transactions.findMany({
      where: {
        type: "deposit",
        status: "completed",
        ...(since ? { created_at: { gt: since } } : {}),
        user: staffRelation,
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
        user: staffRelation,
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

// ─── Live Money Movements (Deposits + Withdrawals) ─────────────────

export type LiveMoneyMovementKind = "deposit" | "withdrawal";

export type LiveMoneyMovementItem = {
  /** Prefixed id ("d:<uuid>" / "w:<uuid>") so deposit and withdrawal
   *  rows never collide in the merged feed even on the rare chance
   *  they share a uuid value. */
  id: string;
  kind: LiveMoneyMovementKind;
  userId: string;
  username: string;
  image: string | null;
  /** Always positive USD value. The UI signs it based on `kind`. */
  amount: number;
  cryptoAsset: string | null;
  createdAt: string;
  /** Deposit-only: deposit bonus paired to this deposit (USD), if any. */
  bonusAmount?: number | null;
  /** Withdrawal-only: card_withdrawal_method ("physical" | "crypto"). */
  method?: string | null;
};

export type LiveMoneyMovementsResult = {
  items: LiveMoneyMovementItem[];
  total24hDeposits: number;
  total24hWithdrawals: number;
  /**
   * True when the docked widget polled with a watermark and nothing has
   * advanced since — the server skipped the heavy 4-query batch + bonus
   * pairing query and only ran the cheap watermark + cached totals. The
   * client should leave `items` alone (the empty array carries no new
   * rows) but is still free to refresh the 24h hero numbers.
   */
  unchanged?: boolean;
};

/**
 * Cheap "has anything advanced?" pre-check for the docked LiveMoneyChat
 * poll. Returns the newest deposit/withdrawal timestamp (ISO) strictly
 * AFTER `sinceCreatedAt`, or `null` when nothing is newer.
 *
 * Mirrors `getLiveActivityWatermark` exactly: two indexed `findFirst`
 * lookups with `take: 1` and a single-column select, filters identical
 * to the heavy `getLiveDepositsAndWithdrawals` row queries so the
 * watermark is broad-or-equal to the heavy query and can never report
 * "no change" when a real row would actually be returned.
 *
 * The withdrawal heavy query has NO status filter on the row fetch
 * (admins want to see every request as it lands, even pending or
 * later-cancelled), so the watermark mirrors that — any status counts.
 */
export async function getMoneyMovementsWatermark(
  sinceCreatedAt: string | null,
): Promise<string | null> {
  const db = await getDb();
  const since = sinceCreatedAt ? new Date(sinceCreatedAt) : null;
  const staffRelation = await excludeStaffCreatorsAndBlacklisted();

  const [depositTop, withdrawalTop] = await Promise.all([
    db.ledger_transactions.findFirst({
      where: {
        type: "deposit",
        status: "completed",
        ...(since ? { created_at: { gt: since } } : {}),
        user: staffRelation,
      },
      orderBy: { created_at: "desc" },
      select: { created_at: true },
    }),
    db.card_withdrawal_requests.findFirst({
      where: {
        ...(since ? { requested_at: { gt: since } } : {}),
        user_card_withdrawal_requests_user_idTouser: staffRelation,
      },
      orderBy: { requested_at: "desc" },
      select: { requested_at: true },
    }),
  ]);

  let max: Date | null = null;
  for (const ts of [
    depositTop?.created_at ?? null,
    withdrawalTop?.requested_at ?? null,
  ]) {
    if (ts && (max === null || ts.getTime() > max.getTime())) max = ts;
  }

  return max ? max.toISOString() : null;
}

/**
 * 24h deposits + withdrawals sums, cached for 60s.
 *
 * The docked LiveMoneyChat panel polls every 6s, so the hero numbers
 * used to re-run two aggregates per tick × every open tab. Wrapping
 * them in `unstable_cache` means each tick is a near-free cache hit
 * for the ~minute the values are valid. The 60s TTL is well under the
 * panel's poll cadence × the time it takes a single tab to notice a
 * material drift in the hero values (60s lag on a 24h running total
 * is invisible to the eye), and matches the precedent in
 * `cached24hPackOpens` / `cached24hBattles` for the docked Recent
 * Activity widget.
 *
 * Cache key includes the blacklist signature (same pattern as the
 * existing dashboard caches) so adding/removing an excluded user
 * invalidates the totals on the next tick.
 */
const cachedMoneyMovementTotals24h = unstable_cache(
  async (blacklistIds: string[]) => {
    const db = await getDb();
    const dayAgo = new Date(Date.now() - MS_PER_DAY);
    // Customer-analytics scope: drop staff (admin/support) AND creators
    // AND the blacklist, matching the request-scope
    // `excludeStaffCreatorsAndBlacklisted()` used by the live-feed row
    // queries above. Built inline because this runs inside
    // `unstable_cache` (no `cookies()` / `getExcludedUserIds()` here) —
    // the blacklist ids arrive as the cache-keyed argument.
    const staffRelation = {
      role: { notIn: [...STAFF_ROLES, user_role.creator] },
      ...(blacklistIds.length > 0 ? { id: { notIn: blacklistIds } } : {}),
    };

    const [depositTotalAgg, withdrawalTotalAgg] = await Promise.all([
      db.ledger_transactions.aggregate({
        where: {
          type: "deposit",
          status: "completed",
          created_at: { gte: dayAgo },
          user: staffRelation,
        },
        _sum: { amount: true },
      }),
      db.card_withdrawal_requests.aggregate({
        where: {
          requested_at: { gte: dayAgo },
          status: { notIn: ["cancelled", "failed"] },
          user_card_withdrawal_requests_user_idTouser: staffRelation,
        },
        _sum: { total_value_usd: true },
      }),
    ]);

    return {
      total24hDeposits: toNumber(depositTotalAgg._sum?.amount),
      total24hWithdrawals: toNumber(withdrawalTotalAgg._sum?.total_value_usd),
    };
  },
  ["dashboard-live-money-totals-24h-v2"],
  { revalidate: 60, tags: ["dashboard-activity"] },
);

/**
 * Public accessor for the cached 24h deposit + withdrawal sums. Pulls
 * the current blacklist (per-request cached) and threads it into the
 * cache key so blacklist edits invalidate on the next tick.
 */
export async function getMoneyMovementTotals24h(): Promise<{
  total24hDeposits: number;
  total24hWithdrawals: number;
}> {
  const blacklist = await getExcludedUserIds();
  // Sort for a stable cache key — `getExcludedUserIds()` already
  // returns the same order from a single admin DB row order, but
  // sorting defensively keeps the key insensitive to a future change
  // in that ordering.
  const sorted = [...blacklist].sort();
  return cachedMoneyMovementTotals24h(sorted);
}

/**
 * Combined live feed of newest deposits AND newest withdrawal requests.
 * Mirrors `getLiveDeposits` semantics for deposits (completed ledger rows,
 * staff/blacklist excluded, bonus paired via balance_after = bonus's
 * balance_before within a 2-minute window) and pulls withdrawals from
 * `card_withdrawal_requests` keyed on `requested_at` — same source the
 * mixed `getLiveActivity` feed uses, so a withdrawal appears the moment
 * the user hits submit, not after admin processing.
 *
 * Two cursors in one call: `sinceCreatedAt` filters BOTH sources (deposits
 * by `created_at > since`, withdrawals by `requested_at > since`). The
 * merged list is sorted newest-first and trimmed to `limit`. The two 24h
 * sums run in parallel with the row fetches and never block each other.
 *
 * 24h totals: deposits = sum of completed deposit ledger rows in the last
 * 24h (matches the existing LiveDeposits hero); withdrawals = sum of
 * withdrawal-request `total_value_usd` in the last 24h excluding the
 * cancelled/failed terminal states (those didn't move money, current or
 * pending). The live feed list itself does NOT filter by status — admins
 * want to see every request as it comes in, even ones that may later
 * fail or be cancelled.
 */
export async function getLiveDepositsAndWithdrawals(params: {
  sinceCreatedAt: string | null;
  limit: number;
}): Promise<LiveMoneyMovementsResult> {
  const db = await getDb();
  const limit = Math.max(1, Math.min(50, Math.floor(params.limit)));
  const since = params.sinceCreatedAt ? new Date(params.sinceCreatedAt) : null;
  const staffRelation = await excludeStaffCreatorsAndBlacklisted();

  // Totals are cached (60s revalidate) so the 4-query parallel batch
  // is now 2 row queries + a near-free cached lookup. The cache is
  // shared across every open admin tab — the docked LiveMoneyChat
  // panel polls every 6s and used to re-run both aggregates on each
  // tick × every tab, which was the single biggest perf drag on the
  // poll path.
  const [depositRows, withdrawalRows, totals] = await Promise.all([
    db.ledger_transactions.findMany({
      where: {
        type: "deposit",
        status: "completed",
        ...(since ? { created_at: { gt: since } } : {}),
        user: staffRelation,
      },
      orderBy: { created_at: "desc" },
      take: limit,
      include: {
        user: { select: { username: true, email: true, image: true } },
      },
    }),
    db.card_withdrawal_requests.findMany({
      where: {
        ...(since ? { requested_at: { gt: since } } : {}),
        user_card_withdrawal_requests_user_idTouser: staffRelation,
      },
      orderBy: { requested_at: "desc" },
      take: limit,
      include: {
        user_card_withdrawal_requests_user_idTouser: {
          select: { username: true, email: true, image: true },
        },
      },
    }),
    getMoneyMovementTotals24h(),
  ]);

  // Pair deposit_bonus rows to their parent deposit using the same rule as
  // getLiveDeposits / getDepositTransactions (bonus.balance_before ==
  // deposit.balance_after, fires within 2 minutes of the parent). Skipped
  // entirely when no deposits in this page.
  const userIds = Array.from(new Set(depositRows.map((r) => r.user_id)));
  const bonusRows =
    depositRows.length > 0
      ? await db.ledger_transactions.findMany({
          where: {
            type: "deposit_bonus",
            status: "completed",
            user_id: { in: userIds },
            created_at: {
              gte: new Date(depositRows[depositRows.length - 1].created_at.getTime()),
              lt: new Date(depositRows[0].created_at.getTime() + 2 * 60 * 1000),
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

  const bonusByKey = new Map<string, number>();
  for (const b of bonusRows) {
    const key = `${b.user_id}|${toNumber(b.balance_before).toFixed(2)}`;
    if (!bonusByKey.has(key)) {
      bonusByKey.set(key, toNumber(b.amount));
    }
  }

  const depositItems: LiveMoneyMovementItem[] = depositRows.map((r) => {
    const key = `${r.user_id}|${toNumber(r.balance_after).toFixed(2)}`;
    const bonus = bonusByKey.get(key) ?? null;
    return {
      id: `d:${r.id}`,
      kind: "deposit" as const,
      userId: r.user_id,
      username: r.user?.username ?? r.user?.email ?? "Unknown",
      image: r.user?.image ?? null,
      amount: toNumber(r.amount),
      bonusAmount: bonus,
      cryptoAsset: r.crypto_asset,
      createdAt: r.created_at.toISOString(),
    };
  });

  const withdrawalItems: LiveMoneyMovementItem[] = withdrawalRows.map((r) => {
    const u = r.user_card_withdrawal_requests_user_idTouser;
    return {
      id: `w:${r.id}`,
      kind: "withdrawal" as const,
      userId: r.user_id,
      username: u?.username ?? u?.email ?? "Unknown",
      image: u?.image ?? null,
      amount: toNumber(r.total_value_usd),
      cryptoAsset: r.crypto_asset,
      createdAt: r.requested_at.toISOString(),
      method: r.method,
    };
  });

  const merged = [...depositItems, ...withdrawalItems]
    .sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    )
    .slice(0, limit);

  return {
    items: merged,
    total24hDeposits: totals.total24hDeposits,
    total24hWithdrawals: totals.total24hWithdrawals,
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
  /**
   * % of the bet that the house fronted on this event. null = not a
   * borrow-capable event. Drives the BorrowBadge that appears next
   * to pack-opening / battle-bet rows in the Recent Activity feed.
   */
  borrowPercentage: number | null;
  /** USD the house fronted (bet × borrow%). null when borrow doesn't apply. */
  borrowedAmountUsd: number | null;
};

// Ledger types surfaced by the live activity feed. Kept as a module
// constant so the cheap watermark pre-check (getLiveActivityWatermark)
// filters on the EXACT same set as the heavy include query below — a
// narrower watermark would risk skipping real rows.
const LIVE_ACTIVITY_LEDGER_TYPES = [
  "deposit",
  "creator_tip",
  "rain_win",
  "race_prize",
  "pack_opening",
  "battle_bet",
  "battle_sponsorship",
  "battle_refund",
  "rakeback_claim",
  "affiliate_claim",
  "deposit_bonus",
  "admin_balance_adjustment",
  "balance_reward_claim",
  "waitlist_prize",
  "gift_card_redeemed",
  "promo_code_redeemed",
  "voucher_redeemed",
] as const;

/**
 * Cheap "has anything advanced?" pre-check for the live-activity SSE
 * stream. Returns the newest event timestamp (ISO) strictly AFTER
 * `sinceCreatedAt` across all three sources, or `null` when nothing is
 * newer.
 *
 * Why this exists: the SSE produce loop used to re-run the full
 * `getLiveActivity` include query every tick (~6s) per connection
 * against the live prod DB even when nothing changed. This pre-check
 * touches the same three tables but with NO includes, NO joins beyond
 * the staff filter, `take: 1`, and selects only the timestamp column —
 * so it rides the existing created_at / requested_at indexes. The route
 * only runs the heavy query when this advances past the last value it
 * already sent on that stream.
 *
 * Filters mirror `getLiveActivity` 1:1 (same staff/blacklist exclusion,
 * same ledger-type set, same withdrawal + signup sources). It is
 * therefore broad-or-equal to the heavy query: it can never report
 * "advanced" later than a real row the heavy query would return, so no
 * row is ever skipped.
 */
export async function getLiveActivityWatermark(
  sinceCreatedAt: string | null,
): Promise<string | null> {
  const db = await getDb();
  const since = sinceCreatedAt ? new Date(sinceCreatedAt) : null;
  const staffRelation = await excludeStaffCreatorsAndBlacklisted();

  const [ledgerTop, withdrawalTop, signupTop] = await Promise.all([
    db.ledger_transactions.findFirst({
      where: {
        status: "completed",
        ...(since ? { created_at: { gt: since } } : {}),
        user: staffRelation,
        type: { in: [...LIVE_ACTIVITY_LEDGER_TYPES] },
        // FAKE-BALANCE: hide official_stream adjustments from the live feed
        // (and keep the watermark in lock-step with the heavy query below).
        NOT: officialStreamAdjustmentPrismaWhere(),
      },
      orderBy: { created_at: "desc" },
      select: { created_at: true },
    }),
    db.card_withdrawal_requests.findFirst({
      where: {
        ...(since ? { requested_at: { gt: since } } : {}),
        user_card_withdrawal_requests_user_idTouser: staffRelation,
      },
      orderBy: { requested_at: "desc" },
      select: { requested_at: true },
    }),
    db.user.findFirst({
      where: {
        role: { not: "admin" },
        ...(since ? { created_at: { gt: since } } : {}),
      },
      orderBy: { created_at: "desc" },
      select: { created_at: true },
    }),
  ]);

  let max: Date | null = null;
  for (const ts of [
    ledgerTop?.created_at ?? null,
    withdrawalTop?.requested_at ?? null,
    signupTop?.created_at ?? null,
  ]) {
    if (ts && (max === null || ts.getTime() > max.getTime())) max = ts;
  }

  return max ? max.toISOString() : null;
}

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
  const db = await getDb();
  const limit = Math.max(1, Math.min(60, Math.floor(params.limit)));
  const since = params.sinceCreatedAt ? new Date(params.sinceCreatedAt) : null;
  const staffRelation = await excludeStaffCreatorsAndBlacklisted();

  const [ledgerRows, withdrawalRequests, signupRows] = await Promise.all([
    db.ledger_transactions.findMany({
      where: {
        status: "completed",
        ...(since ? { created_at: { gt: since } } : {}),
        user: staffRelation,
        // Note: `card_withdrawal` is intentionally NOT in this list.
        // That ledger row is only created AFTER admin processing, so
        // polling it means pending withdrawal requests are invisible.
        // Instead we pull from card_withdrawal_requests below, which
        // captures the moment the user hits submit.
        //
        // `card_sale` / `reward_card_sale` are intentionally excluded —
        // the user already "paid" for the card via a pack or battle, so
        // selling it back is a balance-neutral round-trip in the feed
        // (the pack/battle rows already capture the gambling P&L;
        // surfacing the sale adds noise without new info).
        //
        // The set lives in LIVE_ACTIVITY_LEDGER_TYPES so the cheap
        // watermark pre-check filters on the exact same types.
        type: { in: [...LIVE_ACTIVITY_LEDGER_TYPES] },
        // FAKE-BALANCE: hide official_stream adjustments from the feed —
        // owner-designated fake balance is never surfaced.
        NOT: officialStreamAdjustmentPrismaWhere(),
      },
      orderBy: { created_at: "desc" },
      take: limit,
      include: {
        user: { select: { username: true, email: true, image: true } },
      },
    }),
    db.card_withdrawal_requests.findMany({
      where: {
        ...(since ? { requested_at: { gt: since } } : {}),
        user_card_withdrawal_requests_user_idTouser: staffRelation,
      },
      orderBy: { requested_at: "desc" },
      take: limit,
      include: {
        user_card_withdrawal_requests_user_idTouser: {
          select: { username: true, email: true, image: true },
        },
      },
    }),
    db.user.findMany({
      where: {
        role: { not: "admin" },
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

  // Batch-fetch borrow_percentage for any battle_bet / battle_sponsorship
  // rows in the page. The ledger row's `metadata` doesn't include the
  // battle_id (verified against live data — metadata is null on these
  // rows), so we go through the unique game_session_id → battle_participants
  // → battles chain.
  const battleSessionIds = ledgerRows
    .filter(
      (r) =>
        (r.type === "battle_bet" || r.type === "battle_sponsorship") &&
        r.game_session_id,
    )
    .map((r) => r.game_session_id as string);
  const borrowByGameSessionId = new Map<string, number>();
  if (battleSessionIds.length > 0) {
    const participants = await db.battle_participants.findMany({
      where: { game_session_id: { in: battleSessionIds } },
      select: {
        game_session_id: true,
        battles: { select: { borrow_percentage: true } },
      },
    });
    for (const p of participants) {
      const pct = p.battles?.borrow_percentage ?? 0;
      if (pct > 0) borrowByGameSessionId.set(p.game_session_id, pct);
    }
  }

  // Solo pack_opening: backend writes a deterministic description
  // ("Opened N pack(s) (X% borrowed)"). Cheaper than a per-row PF
  // result lookup for the live feed; verified format against
  // production data.
  const SOLO_BORROW_REGEX = /(\d{1,3})% borrowed/i;

  const ledgerItems: LiveActivityItem[] = ledgerRows.map((r) => {
    let borrowPercentage: number | null = null;
    let borrowedAmountUsd: number | null = null;
    if (r.type === "battle_bet" || r.type === "battle_sponsorship") {
      const pct = r.game_session_id
        ? borrowByGameSessionId.get(r.game_session_id) ?? null
        : null;
      if (pct != null && pct > 0) {
        borrowPercentage = pct;
        borrowedAmountUsd = Math.abs(toNumber(r.amount)) * (pct / 100);
      }
    } else if (r.type === "pack_opening") {
      const m = r.description?.match(SOLO_BORROW_REGEX);
      const pct = m ? parseInt(m[1], 10) : null;
      if (pct != null && pct > 0 && Number.isFinite(pct)) {
        borrowPercentage = pct;
        borrowedAmountUsd = Math.abs(toNumber(r.amount)) * (pct / 100);
      }
    }
    return {
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
      borrowPercentage,
      borrowedAmountUsd,
    };
  });

  const withdrawalItems: LiveActivityItem[] = withdrawalRequests.map((r) => {
    const u = r.user_card_withdrawal_requests_user_idTouser;
    return {
      id: `wd:${r.id}`,
      kind: "withdrawal" as const,
      type: "card_withdrawal",
      userId: r.user_id,
      username: u?.username ?? u?.email ?? "Unknown",
      image: u?.image ?? null,
      amount: toNumber(r.total_value_usd),
      detail: r.method ? `${r.method}${r.crypto_asset ? ` · ${r.crypto_asset}` : ""}` : null,
      createdAt: r.requested_at.toISOString(),
      borrowPercentage: null,
      borrowedAmountUsd: null,
    };
  });

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
    borrowPercentage: null,
    borrowedAmountUsd: null,
  }));

  return [...ledgerItems, ...withdrawalItems, ...signupItems]
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

// ─── Live Users ────────────────────────────────────────────────────
//
// There is currently NO live active-user-count consumer in the admin
// UI: the old ledger-proxy `getLiveUserCount` was removed and no
// component renders the packy.gg `active.users.count` feed (the
// `active.users.count` WS event is not subscribed by any .tsx). Re-add
// a query here only if a server-side code path (e.g. an analytics
// export) actually needs the count.
