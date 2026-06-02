import { getDb } from "@/lib/db";
import { affiliate_usage_type } from "@/generated/prisma/enums";
import { toNumber } from "@/lib/utils/decimal";
import { filterLedgerTxTypes } from "./_ledger-tx-types";
import { calculateUserPnl } from "./pnl";
import { affiliateLeaderboardsApi } from "@/lib/backend-api/affiliate-leaderboards";

const USER_WAGER_BREAKDOWN_TYPES = filterLedgerTxTypes([
  "pack_opening",
  "battle_bet",
  "battle_sponsorship",
  "upgrader_bet",
]);

type Db = Awaited<ReturnType<typeof getDb>>;

const TIP_RECENT_LIMIT = 10;

/**
 * Creator tips for a user, split into received vs sent.
 *
 * Both sides of a tip are `creator_tip` ledger rows (one on each user):
 *   - on the recipient: metadata.direction = "received", balance ↑,
 *     metadata.sender_user_id = who tipped them,
 *   - on the sender:    metadata.direction = "sent",     balance ↓,
 *     metadata.recipient_user_id = who they tipped.
 * `amount` is the magnitude on both rows; for older rows that predate the
 * metadata flag we fall back to the balance delta to infer direction.
 */
async function getUserTips(db: Db, userId: string) {
  const [rows, rainAgg, rainRecent, leaderboardAgg, leaderboardRecent] =
    await Promise.all([
      db.ledger_transactions.findMany({
        where: { user_id: userId, type: "creator_tip" },
        orderBy: { created_at: "desc" },
        select: {
          id: true,
          amount: true,
          balance_before: true,
          balance_after: true,
          metadata: true,
          created_at: true,
        },
      }),
      // Rain prizes the user won (rain_win) — count + total in one pass…
      db.ledger_transactions.aggregate({
        where: { user_id: userId, type: "rain_win" },
        _count: { _all: true },
        _sum: { amount: true },
      }),
      // …plus the most recent few for the list.
      db.ledger_transactions.findMany({
        where: { user_id: userId, type: "rain_win" },
        orderBy: { created_at: "desc" },
        take: TIP_RECENT_LIMIT,
        select: { id: true, amount: true, created_at: true },
      }),
      // Affiliate-leaderboard prize payouts — credits to users who placed
      // on a creator-leaderboard ranking. Same pattern as rain_win: no
      // counterparty (the pool pays out). House cost ⇒ rose color downstream.
      db.ledger_transactions.aggregate({
        where: { user_id: userId, type: "affiliate_leaderboard_prize" },
        _count: { _all: true },
        _sum: { amount: true },
      }),
      // Same recent-N pull as rain, with metadata so we can extract
      // the source leaderboard id + position. Backend writes both
      // fields onto the prize ledger row when the rank settles.
      db.ledger_transactions.findMany({
        where: { user_id: userId, type: "affiliate_leaderboard_prize" },
        orderBy: { created_at: "desc" },
        take: TIP_RECENT_LIMIT,
        select: {
          id: true,
          amount: true,
          created_at: true,
          metadata: true,
        },
      }),
    ]);

  type Entry = {
    id: string;
    amountUsd: number;
    counterpartyId: string | null;
    counterpartyName: string | null;
    createdAt: string;
    sent: boolean;
  };

  const entries: Entry[] = rows.map((r) => {
    const meta =
      r.metadata && typeof r.metadata === "object" && !Array.isArray(r.metadata)
        ? (r.metadata as Record<string, unknown>)
        : {};
    const dir = typeof meta.direction === "string" ? meta.direction : null;
    const sent =
      dir === "sent" ||
      (dir == null && toNumber(r.balance_after) < toNumber(r.balance_before));
    const counterpartyId =
      typeof meta.sender_user_id === "string"
        ? meta.sender_user_id
        : typeof meta.recipient_user_id === "string"
          ? meta.recipient_user_id
          : null;
    return {
      id: r.id,
      amountUsd: toNumber(r.amount),
      counterpartyId,
      counterpartyName: null,
      createdAt: r.created_at.toISOString(),
      sent,
    };
  });

  const received = entries.filter((e) => !e.sent);
  const sent = entries.filter((e) => e.sent);

  // Resolve counterparty usernames only for the rows we'll render.
  const shown = [
    ...received.slice(0, TIP_RECENT_LIMIT),
    ...sent.slice(0, TIP_RECENT_LIMIT),
  ];
  const ids = [
    ...new Set(
      shown.map((e) => e.counterpartyId).filter((x): x is string => !!x),
    ),
  ];
  if (ids.length > 0) {
    const users = await db.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, username: true, email: true },
    });
    const nameById = new Map(
      users.map((u) => [u.id, u.username ?? u.email ?? u.id]),
    );
    for (const e of shown) {
      if (e.counterpartyId)
        e.counterpartyName = nameById.get(e.counterpartyId) ?? null;
    }
  }

  const sum = (arr: Entry[]) => arr.reduce((s, e) => s + e.amountUsd, 0);
  const strip = (e: Entry) => ({
    id: e.id,
    amountUsd: e.amountUsd,
    counterpartyId: e.counterpartyId,
    counterpartyName: e.counterpartyName,
    createdAt: e.createdAt,
  });

  return {
    received: {
      count: received.length,
      totalUsd: sum(received),
      recent: received.slice(0, TIP_RECENT_LIMIT).map(strip),
    },
    sent: {
      count: sent.length,
      totalUsd: sum(sent),
      recent: sent.slice(0, TIP_RECENT_LIMIT).map(strip),
    },
    // Rain prizes have no counterparty — they come from the rain pool.
    rainPrizes: {
      count: rainAgg._count._all,
      totalUsd: toNumber(rainAgg._sum.amount ?? 0),
      recent: rainRecent.map((r) => ({
        id: r.id,
        amountUsd: toNumber(r.amount),
        counterpartyId: null,
        counterpartyName: null,
        createdAt: r.created_at.toISOString(),
      })),
    },
    // Affiliate-leaderboard wins (affiliate_leaderboard_prize) — credits
    // paid out by creator-leaderboard rankings. Same shape as rain
    // prizes (no counterparty), with two extra fields per row pulled
    // off the prize ledger row's metadata so the UI can label which
    // leaderboard the win came from and deep-link to it.
    leaderboardWins: {
      count: leaderboardAgg._count._all,
      totalUsd: toNumber(leaderboardAgg._sum.amount ?? 0),
      recent: await enrichLeaderboardWins(leaderboardRecent),
    },
  };
}

/**
 * Resolve each `affiliate_leaderboard_prize` ledger row to the
 * leaderboard it came from. The backend writes the prize event with
 * `metadata.leaderboard_id` (UUID) and `metadata.position` (1-based
 * rank). Titles aren't on the row — we fetch them in one bulk call to
 * the backend admin API and join client-side, so each unique
 * leaderboard is fetched at most once per page render.
 *
 * Graceful degradation: rows whose metadata is missing or malformed
 * still render — the UI just shows "Leaderboard win" with no link or
 * sub-line. Backend fetches that 404 (deleted leaderboards) also fall
 * through to a metadata-only display so a hard-deleted source can't
 * blank out the section.
 */
async function enrichLeaderboardWins(
  rows: {
    id: string;
    amount: { toString(): string } | number | string;
    created_at: Date;
    metadata: unknown;
  }[],
): Promise<
  {
    id: string;
    amountUsd: number;
    counterpartyId: null;
    counterpartyName: null;
    createdAt: string;
    leaderboardId: string | null;
    leaderboardTitle: string | null;
    position: number | null;
  }[]
> {
  // First pass: pull (id, position, optional title) off each row's
  // metadata. Treat the metadata as `unknown` and narrow defensively —
  // older rows (or rows from a backend rev that didn't populate the
  // fields) still have to render cleanly.
  type Parsed = {
    leaderboardId: string | null;
    position: number | null;
    title: string | null;
  };
  const parsed: Parsed[] = rows.map((r) => {
    const m =
      r.metadata && typeof r.metadata === "object" && !Array.isArray(r.metadata)
        ? (r.metadata as Record<string, unknown>)
        : null;
    const leaderboardId =
      m && typeof m.leaderboard_id === "string" ? m.leaderboard_id : null;
    const position =
      m && typeof m.position === "number" && Number.isFinite(m.position)
        ? m.position
        : null;
    const title = m && typeof m.title === "string" ? m.title : null;
    return { leaderboardId, position, title };
  });

  // Collect the unique leaderboard IDs that still need a title — skip
  // any row that already carried `title` in its metadata so we don't
  // pay a network hop for rows that don't need one.
  const needTitle = new Set<string>();
  for (const p of parsed) {
    if (p.leaderboardId && !p.title) needTitle.add(p.leaderboardId);
  }

  // Resolve titles in parallel. Per-leaderboard `.catch` means a 404
  // (hard-deleted leaderboard) only blanks that one row's title; the
  // other entries still resolve. We never throw from this enricher —
  // a failed backend round-trip must not 500 the user detail page.
  const titleById = new Map<string, string>();
  if (needTitle.size > 0) {
    const results = await Promise.allSettled(
      Array.from(needTitle).map((id) =>
        affiliateLeaderboardsApi.get(id).then((r) => ({ id, title: r.title })),
      ),
    );
    for (const r of results) {
      if (r.status === "fulfilled") {
        titleById.set(r.value.id, r.value.title);
      }
    }
  }

  return rows.map((r, i) => {
    const p = parsed[i];
    const resolvedTitle =
      p.title ?? (p.leaderboardId ? titleById.get(p.leaderboardId) ?? null : null);
    return {
      id: r.id,
      amountUsd: toNumber(r.amount),
      counterpartyId: null,
      counterpartyName: null,
      createdAt: r.created_at.toISOString(),
      leaderboardId: p.leaderboardId,
      leaderboardTitle: resolvedTitle,
      position: p.position,
    };
  });
}

/**
 * Slim header-only query for /users/[id]. Returns just the identity
 * fields the page's critical-path header renders (username / email)
 * without pulling in the whole detail-page aggregate.
 *
 * The full `getUserDetail()` fans out to ~19 Main-DB round-trips plus the
 * canonical `calculateUserPnl` helper. Blocking first paint on all of
 * that means a SINGLE slow/failing query (P&L scan, risk-score aggregate,
 * a join hiccup) takes down the WHOLE page via the segment error boundary.
 * The page now awaits only THIS cheap lookup on the critical path so the
 * back-link header + tag panel paint immediately, then streams the heavy
 * `UserViewModern` body in its own Suspense boundary (each heavy fetch
 * timeout-wrapped via safeQuery). Mirrors `getCreatorHeader`, which does
 * the same for /creators/[userId].
 *
 * Returns null for a genuinely unknown user id → the page 404s. A null
 * here is the ONLY 404 path; once this resolves, a downstream failure in
 * the streamed body degrades that band rather than crashing the page.
 */
export async function getUserHeader(id: string): Promise<{
  id: string;
  username: string | null;
  email: string | null;
} | null> {
  const db = await getDb();
  const user = await db.user.findUnique({
    where: { id },
    select: { id: true, username: true, email: true },
  });
  if (!user) return null;
  return { id: user.id, username: user.username, email: user.email };
}

export async function getUserDetail(id: string) {
  const db = await getDb();
  // Everything is independent — one Promise.all instead of two serialized ones
  // cuts the worst-case latency roughly in half on hot user-detail loads.
  let wagerBreakdown: { type: string; _sum: { amount: unknown } }[] = [];

  const wagerBreakdownPromise = db.ledger_transactions
    .groupBy({
      by: ["type"],
      where: {
        user_id: id,
        type: { in: USER_WAGER_BREAKDOWN_TYPES },
        status: "completed",
      },
      _sum: { amount: true },
    })
    .catch((e) => {
      console.error("[getUserDetail] wager breakdown query failed:", e);
      return [] as { type: string; _sum: { amount: unknown } }[];
    });

  // Canonical P&L components (deposits, withdrawals, on-site balance,
  // inventory value, unclaimed vouchers) live in the shared helper so the
  // formula stays identical to dashboard / users-list. We only use the
  // components here — the page composes the displayed pnl client-side
  // from the same fields surfaced on `balances`. Errors are not caught:
  // matches the pre-refactor behaviour where the card_withdrawal
  // aggregate ran in the same Promise.all without a .catch and would
  // surface to the page error boundary.
  const userPnlPromise = calculateUserPnl(id);

  const [
    user,
    balances,
    statistics,
    featureLocks,
    battleLimits,
    inventoryCount,
    affiliateAccount,
    shippingAddress,
    vault,
    mutes,
    cardWithdrawals,
    activeSeed,
    depositAddresses,
    depositAgg,
    withdrawalCount,
    userPnl,
    wagerBreakdownResolved,
    ownedCodeRows,
    tips,
  ] = await Promise.all([
    db.user.findUnique({
      where: { id },
      include: {
        account: {
          select: { providerId: true, accountId: true, created_at: true },
        },
      },
    }),
    db.balances.findUnique({ where: { user_id: id } }),
    db.user_statistics.findUnique({ where: { user_id: id } }),
    db.user_feature_locks.findUnique({ where: { user_id: id } }),
    db.user_battle_limits.findUnique({ where: { user_id: id } }),
    db.user_inventory.count({ where: { user_id: id, sold_at: null, exchanged_at: null } }),
    db.affiliate_accounts.findUnique({
      where: { user_id: id },
      select: {
        total_referred: true,
        total_wager_volume_usd: true,
        total_earned_usd: true,
        available_usd: true,
        total_paid_out_usd: true,
        total_bonus_distributed_usd: true,
        last_payout_at: true,
      },
    }),
    db.shipping_addresses.findUnique({ where: { user_id: id } }),
    db.vaults.findUnique({ where: { user_id: id } }),
    db.user_mutes.findMany({
      where: { user_id: id },
      orderBy: { created_at: "desc" },
      take: 10,
    }),
    db.card_withdrawal_requests.findMany({
      where: { user_id: id },
      orderBy: { requested_at: "desc" },
      take: 10,
    }),
    db.active_seeds.findUnique({ where: { user_id: id } }),
    db.deposit_addresses.findMany({
      where: { user_id: id },
      orderBy: { created_at: "desc" },
    }),
    // Event counts surfaced at the top of the detail page header. Counts
    // are defined to mirror the existing "total withdrawn" aggregate in
    // balances so the header and the Balances card agree on what counts
    // as a completed deposit / withdrawal. Combined count + sum into one
    // aggregate call so we hit the deposit ledger filter exactly once
    // instead of twice — same plan, half the round-trips.
    db.ledger_transactions.aggregate({
      where: {
        user_id: id,
        type: "deposit",
        status: "completed",
      },
      _count: { _all: true },
      _sum: { amount: true },
    }),
    db.card_withdrawal_requests.count({
      where: {
        user_id: id,
        status: { in: ["completed", "shipped"] },
      },
    }),
    userPnlPromise,
    wagerBreakdownPromise,
    // Every code this user owns (rows in affiliate_codes). No dependency
    // on any other query result — keyed on the id param — so it runs in
    // the main batch instead of a serial tail. orderBy created_at ASC:
    // the LAST row is the newest, used as the affiliate-code fallback
    // below (replaces the dropped findFirst ... orderBy desc limit 1).
    db.affiliate_codes.findMany({
      where: { user_id: id },
      orderBy: { created_at: "asc" },
      select: { code: true, created_at: true },
    }),
    // Creator tips received + sent (both are creator_tip rows, split by
    // metadata.direction). Runs in parallel; resolves counterparty names
    // for the shown rows internally.
    getUserTips(db, id),
  ]);

  const depositCount = depositAgg._count._all;
  const depositTotalAgg = depositAgg;

  wagerBreakdown = wagerBreakdownResolved as typeof wagerBreakdown;

  if (!user) return null;

  // Resolve referred_by username + the EXACT code that was used at
  // signup time (from affiliate_code_usages). The code string is what
  // admins ask for ("which code did this user use?") — having it on
  // the page next to the referrer link removes the ambiguity between
  // the user's OWN code (user.affiliate_code) and the code they
  // joined under. The signup-time row is the source of truth: even
  // if the owner has since rotated their code, that row preserves
  // the original string.
  let referredByUsername: string | null = null;
  let referredByCode: string | null = null;
  if (user.referred_by) {
    const [referrer, signupUsage, latestUsage] = await Promise.all([
      db.user.findUnique({
        where: { id: user.referred_by },
        select: { username: true, email: true, affiliate_code: true },
      }),
      // Historical signup-time code — preferred, since it preserves the
      // exact string even if the owner later rotated their code.
      db.affiliate_code_usages.findFirst({
        where: {
          referred_user_id: user.id,
          usage_type: affiliate_usage_type.signup,
        },
        orderBy: { created_at: "desc" },
        select: { code: true },
      }),
      // Most recent usage row of ANY type. The admin "set referrer"
      // path writes a non-signup usage row, so this surfaces the code
      // when there's no signup row — without it the code shows as
      // "unknown" after a manual attribution.
      db.affiliate_code_usages.findFirst({
        where: { referred_user_id: user.id },
        orderBy: { created_at: "desc" },
        select: { code: true },
      }),
    ]);
    referredByUsername =
      referrer?.username ?? referrer?.email ?? user.referred_by;
    // Resolution order:
    //   1. historical signup row (exact code at signup),
    //   2. the active code the user is on now (user.affiliate_code —
    //      set by the admin override), which is what wager income
    //      follows,
    //   3. any recorded usage row (catches manual/deposit attributions),
    //   4. the referrer's own code as a last resort.
    // NOTE: referrer.affiliate_code is the code the OWNER is carrying,
    // not necessarily a code they own, so it's the weakest fallback.
    referredByCode =
      signupUsage?.code ??
      user.affiliate_code ??
      latestUsage?.code ??
      referrer?.affiliate_code ??
      null;
  }

  // Every code this user owns (rows in affiliate_codes). A user can
  // legitimately own more than one (creators with multiple campaign
  // codes; users who got codes transferred to them). The "primary"
  // is whichever string equals user.affiliate_code; the rest are
  // historical / extras. Surfacing the full list on /users/[id]
  // lets admins see drift between user.affiliate_code and what's
  // actually in the affiliate_codes table — and switch the primary
  // without touching the DB. (Rows fetched in the main Promise.all.)
  const ownedCodes = ownedCodeRows.map((c) => ({
    code: c.code,
    createdAt: c.created_at.toISOString(),
    isPrimary: c.code === user.affiliate_code,
  }));
  // Newest owned code — preserves the dropped findFirst(orderBy desc)
  // fallback: ownedCodeRows is sorted ASC, so the last element is the
  // most-recently-created code.
  const newestOwnedCode = ownedCodeRows.at(-1)?.code ?? null;

  return {
    tips,
    user: {
      id: user.id,
      username: user.username,
      displayUsername: user.display_username,
      name: user.name,
      email: user.email,
      emailVerified: user.email_verified,
      role: user.role,
      image: user.image,
      twoFactorEnabled: user.two_factor_enabled ?? false,
      isBanned: user.is_banned,
      bannedReason: user.banned_reason,
      bannedAt: user.banned_at?.toISOString() ?? null,
      bannedBy: user.banned_by,
      isLocked: user.is_locked,
      lockedReason: user.locked_reason,
      lockedAt: user.locked_at?.toISOString() ?? null,
      lockedBy: user.locked_by,
      lockedUntil: user.locked_until?.toISOString() ?? null,
      country: user.country,
      countryCode: user.country_code,
      city: user.city,
      state: user.state,
      continentCode: user.continent_code,
      signupIp: user.signup_ip,
      referredBy: user.referred_by,
      referredByUsername,
      referredByCode,
      ownedCodes,
      affiliateCode: user.affiliate_code,
      affiliateCodeActive: user.affiliate_code_active ?? false,
      affiliateCodeExpiresAt: user.affiliate_code_expires_at?.toISOString() ?? null,
      affiliateBonusOptedIn: user.affiliate_bonus_opted_in ?? false,
      hasApiKey: !!user.api_key,
      createdAt: user.created_at.toISOString(),
      updatedAt: user.updated_at.toISOString(),
      providers: user.account.map((a) => a.providerId),
      // The provider this user signed up with — i.e. the FIRST linked
      // account. We sort by account.created_at ASC and take the oldest;
      // if that timestamp is missing we fall back to the first entry
      // in the array (BetterAuth orders by creation by default). Maps
      // to discord / google / steam / credential (= email) etc. Null
      // when the user has no linked account at all.
      signupProvider: (() => {
        if (user.account.length === 0) return null;
        const sorted = [...user.account].sort((a, b) => {
          const ta = a.created_at?.getTime() ?? Infinity;
          const tb = b.created_at?.getTime() ?? Infinity;
          return ta - tb;
        });
        return sorted[0]?.providerId ?? null;
      })(),
      discord: (() => {
        const dc = user.account.find((a) => a.providerId === "discord");
        if (!dc) return null;
        return {
          id: dc.accountId,
          linkedAt: dc.created_at?.toISOString() ?? null,
        };
      })(),
    },
    balances: balances
      ? {
          availableBalance: toNumber(balances.available_balance),
          lockedBalance: toNumber(balances.locked_balance),
          // P&L components come from the shared helper so this view can
          // never drift from users-list / dashboard.
          totalDeposited: userPnl.deposits,
          totalWithdrawn: userPnl.withdrawals,
          totalWagered: toNumber(balances.total_wagered),
          totalWon: toNumber(balances.total_won),
          bonusPoints: balances.bonus_points,
          unlockAt: balances.unlock_at?.toISOString() ?? null,
          inventoryValue: userPnl.inventoryValue,
          vouchersValue: userPnl.unclaimedVouchers,
          packsWagered: Math.abs(toNumber(
            wagerBreakdown.find((w) => w.type === "pack_opening")?._sum.amount ?? 0,
          )),
          battlesWagered: Math.abs(
            toNumber(wagerBreakdown.find((w) => w.type === "battle_bet")?._sum.amount ?? 0) +
              toNumber(wagerBreakdown.find((w) => w.type === "battle_sponsorship")?._sum.amount ?? 0),
          ),
        }
      : null,
    statistics: statistics
      ? {
          openedPacks: statistics.opened_packs_count,
          battlesPlayed: statistics.battles_played,
          xp: statistics.xp,
          level: statistics.level,
          weeklyWagerCount: statistics.weekly_wager_count,
          lastWageredAt: statistics.last_wagered_at?.toISOString() ?? null,
          currentDayWageredUsd: toNumber(statistics.current_day_wagered_usd),
          currentWeekWageredUsd: toNumber(statistics.current_week_wagered_usd),
          currentMonthWageredUsd: toNumber(statistics.current_month_wagered_usd),
          isProfilePrivate: statistics.is_profile_private,
        }
      : null,
    featureLocks: featureLocks
      ? {
          lockedWithdrawalsCrypto: featureLocks.locked_withdrawals_crypto.length > 0,
          lockedWithdrawalsItems: featureLocks.locked_withdrawals_items,
          lockedInventorySales: featureLocks.locked_inventory_sales,
          lockedExchanges: featureLocks.locked_exchanges,
          lockedOpenings: featureLocks.locked_openings,
          lockedVault: featureLocks.locked_vault,
        }
      : null,
    battleLimits: battleLimits
      ? {
          maxValueUsd:
            battleLimits.max_value_usd != null
              ? toNumber(battleLimits.max_value_usd)
              : null,
          baseBetLimitUsd:
            battleLimits.base_bet_limit_usd != null
              ? toNumber(battleLimits.base_bet_limit_usd)
              : null,
        }
      : null,
    inventoryCount,
    affiliate: affiliateAccount
      ? {
          code: user?.affiliate_code ?? newestOwnedCode ?? "",
          totalReferred: affiliateAccount.total_referred,
          totalWagerVolumeUsd: toNumber(affiliateAccount.total_wager_volume_usd),
          totalEarnedUsd: toNumber(affiliateAccount.total_earned_usd),
          availableUsd: toNumber(affiliateAccount.available_usd),
          totalPaidOutUsd: toNumber(affiliateAccount.total_paid_out_usd),
          totalBonusDistributedUsd: toNumber(affiliateAccount.total_bonus_distributed_usd),
          lastPayoutAt: affiliateAccount.last_payout_at?.toISOString() ?? null,
        }
      : null,
    shippingAddress: shippingAddress
      ? {
          firstName: shippingAddress.first_name,
          lastName: shippingAddress.last_name,
          phoneCountryCode: shippingAddress.phone_country_code,
          phoneNumber: shippingAddress.phone_number,
          addressLine1: shippingAddress.address_line_1,
          addressLine2: shippingAddress.address_line_2,
          city: shippingAddress.city,
          zipCode: shippingAddress.zip_code,
          stateProvince: shippingAddress.state_province,
          country: shippingAddress.country,
        }
      : null,
    vault: vault
      ? {
          id: vault.id,
          name: vault.name,
          customerRefId: vault.customer_ref_id,
          fireblocksVaultId: vault.fireblocks_vault_id ?? null,
          createdAt: vault.created_at.toISOString(),
        }
      : null,
    mutes: mutes.map((m) => ({
      id: m.id,
      mutedBy: m.muted_by,
      reason: m.reason,
      expiresAt: m.expires_at?.toISOString() ?? null,
      unmutedAt: m.unmuted_at?.toISOString() ?? null,
      unmutedBy: m.unmuted_by,
      createdAt: m.created_at.toISOString(),
    })),
    cardWithdrawals: cardWithdrawals.map((cw) => ({
      id: cw.id,
      method: cw.method,
      totalValueUsd: toNumber(cw.total_value_usd),
      shippingFeeUsd: cw.shipping_fee_usd ? toNumber(cw.shipping_fee_usd) : null,
      trackingNumber: cw.tracking_number,
      carrier: cw.carrier,
      status: cw.status,
      failureReason: cw.failure_reason,
      requestedAt: cw.requested_at.toISOString(),
      completedAt: cw.completed_at?.toISOString() ?? null,
    })),
    activeSeed: activeSeed
      ? {
          clientSeed: activeSeed.client_seed,
          serverSeedHash: activeSeed.server_seed_hash,
          nonce: activeSeed.nonce,
        }
      : null,
    depositAddresses: depositAddresses.map((da) => ({
      id: da.id,
      assetId: da.asset_id,
      address: da.address,
      tag: da.tag,
      legacyAddress: da.legacy_address,
      createdAt: da.created_at.toISOString(),
    })),
    counts: {
      deposits: depositCount,
      withdrawals: withdrawalCount,
      avgDeposit:
        depositCount > 0
          ? toNumber(depositTotalAgg._sum.amount ?? 0) / depositCount
          : 0,
    },
  };
}
