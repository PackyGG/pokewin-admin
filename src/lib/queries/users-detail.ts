import { getDb } from "@/lib/db";
import { affiliate_usage_type } from "@/generated/prisma/enums";
import { toNumber } from "@/lib/utils/decimal";
import { isUserId, isUuid } from "@/lib/utils/ids";
import { filterLedgerTxTypesLive } from "./_ledger-tx-types";
import { calculateUserPnl } from "./pnl";
import { affiliateLeaderboardsApi } from "@/lib/backend-api/affiliate-leaderboards";

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
  const [rows, rainAgg, rainRecent, leaderboardAgg, leaderboardRecent, raceAgg, raceRecent] =
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
      // On-site race prize claims (race_prize) — same pattern as rain_win.
      db.ledger_transactions.aggregate({
        where: { user_id: userId, type: "race_prize" },
        _count: { _all: true },
        _sum: { amount: true },
      }),
      db.ledger_transactions.findMany({
        where: { user_id: userId, type: "race_prize" },
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
    raceClaims: {
      count: raceAgg._count._all,
      totalUsd: toNumber(raceAgg._sum.amount ?? 0),
      recent: raceRecent.map((r) => {
        const meta = parseRaceClaimMetadata(r.metadata);
        return {
          id: r.id,
          amountUsd: toNumber(r.amount),
          counterpartyId: null,
          counterpartyName: null,
          createdAt: r.created_at.toISOString(),
          raceType: meta.raceType,
          position: meta.position,
        };
      }),
    },
  };
}

function parseRaceClaimMetadata(metadata: unknown): {
  raceType: string | null;
  position: number | null;
} {
  const m =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)
      : null;
  const raceType =
    m && typeof m.race_type === "string" ? m.race_type : null;
  const position =
    m && typeof m.position === "number" && Number.isFinite(m.position)
      ? m.position
      : null;
  return { raceType, position };
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
/**
 * Resolve a `/users/[id]` route segment to the canonical packy.gg user id.
 * Accepts UUIDs, nanoid-style user ids, or a username (case-insensitive).
 */
export async function resolveUserIdFromRouteKey(
  key: string,
): Promise<string | null> {
  const trimmed = key.trim();
  if (!trimmed) return null;

  const db = await getDb();
  if (isUuid(trimmed) || isUserId(trimmed)) {
    const user = await db.user.findUnique({
      where: { id: trimmed },
      select: { id: true },
    });
    return user?.id ?? null;
  }

  const byUsername = await db.user.findFirst({
    where: { username: { equals: trimmed, mode: "insensitive" } },
    select: { id: true },
  });
  return byUsername?.id ?? null;
}

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

/**
 * Reads the spendable-points counter name-agnostically across schema drift.
 * The dev and prod DBs are on different migrations: 0127 renamed
 * balances.bonus_points -> shards on dev but not (yet) on prod. The same
 * generated Prisma client serves BOTH DBs, so a bare findUnique() (which
 * pulls every model column) requests the divergent column and throws P2022
 * on whichever DB lacks it. Try the post-rename name first, fall back to the
 * legacy name, and treat "column absent" as 0. id is parameterised and the
 * column names are a fixed allowlist, so $queryRawUnsafe is safe here.
 */
async function fetchBalancePoints(db: Db, id: string): Promise<number> {
  for (const col of ["shards", "bonus_points"] as const) {
    try {
      const rows = await db.$queryRawUnsafe<Array<{ pts: number | null }>>(
        `SELECT "${col}" AS pts FROM balances WHERE user_id = $1`,
        id,
      );
      return Number(rows[0]?.pts ?? 0);
    } catch {
      // Column doesn't exist on this DB's migration state — try the next name.
    }
  }
  return 0;
}

export async function getUserDetail(id: string) {
  const db = await getDb();
  // Everything is independent — one Promise.all instead of two serialized ones
  // cuts the worst-case latency roughly in half on hot user-detail loads.
  let wagerBreakdown: { type: string; _sum: { amount: unknown } }[] = [];

  // Wager-breakdown groupBy — the requested type list is intersected against
  // the LIVE prod enum at call time (filterLedgerTxTypesLive), NOT just the
  // generated Prisma enum. The generated client is AHEAD of prod for the
  // unlaunched upgrader feature: passing `upgrader_bet` into a Prisma
  // `type: { in: [...] }` made Postgres throw `22P02 invalid input value for
  // enum`, which the .catch below silently swallowed → packs/battles-wagered
  // tiles rendered 0 on every prod profile. The live probe is 5-min
  // unstable_cache'd, so steady-state adds no extra round trip. (Prisma
  // `in: []` on an empty live list is valid and returns no rows.)
  const wagerBreakdownPromise = filterLedgerTxTypesLive([
    "pack_opening",
    "battle_bet",
    "battle_sponsorship",
    "upgrader_bet",
  ])
    .then((types) =>
      db.ledger_transactions.groupBy({
        by: ["type"],
        where: {
          user_id: id,
          type: { in: types },
          status: "completed",
        },
        _sum: { amount: true },
      }),
    )
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
    balancePoints,
    liveAffiliateRows,
  ] = await Promise.all([
    db.user.findUnique({
      where: { id },
      include: {
        account: {
          select: { providerId: true, accountId: true, created_at: true },
        },
      },
    }),
    // SCHEMA-DRIFT GUARD: dev and prod are on different migrations (0127
    // renamed balances.bonus_points -> shards on dev only). A bare
    // findUnique() pulls EVERY model column, so it requests the divergent
    // column and throws P2022 on whichever DB lacks it. Select only columns
    // that exist identically in BOTH DBs; the points value is read
    // name-agnostically via fetchBalancePoints below.
    db.balances.findUnique({
      where: { user_id: id },
      select: {
        available_balance: true,
        locked_balance: true,
        total_wagered: true,
        total_won: true,
        unlock_at: true,
      },
    }),
    db.user_statistics.findUnique({ where: { user_id: id } }),
    db.user_feature_locks.findUnique({ where: { user_id: id } }),
    // The user_battle_limits table is ABSENT in live prod (P2021). A missing
    // table means no per-user override row can exist, so `null` is the TRUE
    // answer (site_config defaults apply) — not a degraded value. Without
    // this .catch the rejection took down the WHOLE 19-promise aggregate and
    // the entire body band rendered the amber error instead of the page.
    db.user_battle_limits.findUnique({ where: { user_id: id } }).catch(() => null),
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
    // Spendable points counter, read name-agnostically across the
    // bonus_points -> shards rename (see fetchBalancePoints).
    fetchBalancePoints(db, id),
    // LIVE affiliate aggregates — sourced from the canonical
    // affiliate_code_usages table the leaderboard reads (see
    // creators-leaderboards.ts:142-161). The denormalized
    // affiliate_accounts row can be stale / missing for code-owners
    // whose totals haven't been backfilled, so the Affiliate Stats
    // tiles on /users/[id] read live for the click/wager numbers.
    // Payout fields stay on affiliateAccount (cash-out state lives
    // there authoritatively). Matches the leaderboard's exact
    // semantics: UPPER(code) match, usage_type::text='wager',
    // referred_user_id counted DISTINCT. Lifetime (no window) to
    // match what the user-page currently shows. Single round-trip,
    // .catch keeps page from breaking on enum/schema drift.
    db.$queryRaw<Array<{ total_referred: bigint | number | null; total_wager_volume_usd: string | null }>>`
      WITH codes AS (
        SELECT UPPER(code) AS uc FROM affiliate_codes WHERE user_id = ${id}
      )
      SELECT
        (SELECT COUNT(DISTINCT acu.referred_user_id)
           FROM affiliate_code_usages acu
           WHERE UPPER(acu.code) IN (SELECT uc FROM codes)) AS total_referred,
        (SELECT COALESCE(SUM(acu.wager_amount_usd::numeric), 0)::text
           FROM affiliate_code_usages acu
           WHERE UPPER(acu.code) IN (SELECT uc FROM codes)
             AND acu.usage_type::text = 'wager') AS total_wager_volume_usd
    `.catch((e) => {
      console.error("[getUserDetail] live affiliate aggregate query failed:", e);
      return [] as Array<{ total_referred: bigint | number | null; total_wager_volume_usd: string | null }>;
    }),
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
      // The LIVE prod affiliate_usage_type enum is {deposit,wager} only —
      // `signup` exists just in the generated client, so this filter throws
      // 22P02 on prod. Zero rows could carry the missing member anyway, so
      // null is the TRUE result; the fallback chain below (user.affiliate_code
      // → latestUsage → referrer) absorbs it. No live-probe infra for this
      // enum — a single .catch is the house rule for one-off enum reads.
      db.affiliate_code_usages
        .findFirst({
          where: {
            referred_user_id: user.id,
            usage_type: affiliate_usage_type.signup,
          },
          orderBy: { created_at: "desc" },
          select: { code: true },
        })
        .catch(() => null),
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
      // Self-exclusion (responsible-gambling). USER-initiated on the game
      // platform — there is no admin endpoint to impose/lift it, so this is
      // DISPLAY-ONLY here. Mirrors the four game-DB columns straight off the
      // Prisma `user` model (no extra query — they live on the same findUnique
      // as banned/locked). `isSelfExcluded` can be true while
      // `selfExcludedUntil` is in the PAST = EXPIRED; the view derives
      // active-vs-expired from the timestamp, this just surfaces the raw
      // fields. When active, the user is currently restricted on the game
      // platform (the betting/withdrawal routes 403 for them).
      isSelfExcluded: user.is_self_excluded,
      selfExcludedReason: user.self_excluded_reason,
      selfExcludedAt: user.self_excluded_at?.toISOString() ?? null,
      selfExcludedUntil: user.self_excluded_until?.toISOString() ?? null,
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
          // FAKE-BALANCE: net the signed official_stream credit out of the
          // DISPLAYED available balance so it matches the P&L treatment
          // (calculateUserPnl already nets it from onSiteBalance). Derived
          // from the PnL components — no second query — so the displayed
          // figure and the P&L can never drift: onSiteBalance = available +
          // locked − officialStreamNet, so available_netted =
          // onSiteBalance − locked. Clamp ≥ 0 defensively (a debit-heavy
          // clawback can't push the shown balance negative).
          availableBalance: Math.max(
            0,
            userPnl.onSiteBalance - toNumber(balances.locked_balance),
          ),
          // Raw spendable column — what a removal adjustment actually debits.
          // The Adjust-Balance dialog validates against this so its preview
          // matches the server (the netted `availableBalance` above can be
          // inflated by official-stream credits that aren't real cash).
          availableBalanceRaw: toNumber(balances.available_balance),
          lockedBalance: toNumber(balances.locked_balance),
          // P&L components come from the shared helper so this view can
          // never drift from users-list / dashboard.
          totalDeposited: userPnl.deposits,
          totalWithdrawn: userPnl.withdrawals,
          totalWagered: toNumber(balances.total_wagered),
          totalWon: toNumber(balances.total_won),
          bonusPoints: balancePoints,
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
    // Render the Affiliate Stats column whenever this user has ANY
    // affiliate footprint — owned codes, recorded usages keyed to
    // his codes (covered by liveAffiliateRows.total_referred > 0),
    // OR an existing affiliate_accounts row (payout state). The
    // previous gate required affiliate_accounts to exist, which
    // hid the column for code-owners whose denormalized row had
    // not been backfilled yet. Click/wager numbers now come from
    // affiliate_code_usages (same source the leaderboard reads —
    // see creators-leaderboards.ts:142-161); payout fields stay
    // on affiliate_accounts (authoritative cash-out state).
    affiliate: (() => {
      const live = liveAffiliateRows[0];
      const liveTotalReferred = Number(live?.total_referred ?? 0);
      const liveWager = toNumber(live?.total_wager_volume_usd ?? 0);
      const hasFootprint =
        ownedCodeRows.length > 0 ||
        liveTotalReferred > 0 ||
        affiliateAccount != null;
      if (!hasFootprint) return null;
      return {
        code: user?.affiliate_code ?? newestOwnedCode ?? "",
        // LIVE click/wager — parallel to the leaderboard's source.
        totalReferred: liveTotalReferred,
        totalWagerVolumeUsd: liveWager,
        // Payout state stays on affiliate_accounts (the cash-out
        // source of truth even when click/wager totals are stale).
        // Falls back to 0 / null when no account row exists yet —
        // the panel still renders so admins see the live numbers.
        totalEarnedUsd: affiliateAccount ? toNumber(affiliateAccount.total_earned_usd) : 0,
        availableUsd: affiliateAccount ? toNumber(affiliateAccount.available_usd) : 0,
        totalPaidOutUsd: affiliateAccount ? toNumber(affiliateAccount.total_paid_out_usd) : 0,
        totalBonusDistributedUsd: affiliateAccount
          ? toNumber(affiliateAccount.total_bonus_distributed_usd)
          : 0,
        lastPayoutAt: affiliateAccount?.last_payout_at?.toISOString() ?? null,
      };
    })(),
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
