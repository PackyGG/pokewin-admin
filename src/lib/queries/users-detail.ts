import { queryMainRows } from "@/lib/drizzle-query";
import * as mainSchema from "@/lib/db-schema/main/schema";
import { toNumber } from "@/lib/utils/decimal";
import { isUserId, isUuid } from "@/lib/utils/ids";
import { filterLedgerTxTypesLive } from "./_ledger-tx-types";
import { calculateUserPnl } from "./pnl";
import { affiliateLeaderboardsApi } from "@/lib/backend-api/affiliate-leaderboards";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getExcludedUserIdsForAdminSearch } from "@/lib/excluded-users/search-visible-override";
import { logError } from "@/lib/errors/logger";
import { hasWagerProgressColumns } from "./users-wager-progress";

const TIP_RECENT_LIMIT = 10;

function toIso(value: string | Date): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function toMillis(value: string | Date | null): number {
  return value == null ? Infinity : new Date(value).getTime();
}

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
async function getUserTips(userId: string) {
  const [rows, prizeRows] = await Promise.all([
    queryMainRows<
      {
        id: string;
        amount: string;
        balance_before: string;
        balance_after: string;
        metadata: unknown;
        created_at: Date | string;
        sent: boolean;
        direction_count: string;
        direction_total: string | null;
        counterparty_id: string | null;
        counterparty_name: string | null;
      }[]
    >(
      `WITH classified AS (
           SELECT lt.id, lt.amount, lt.balance_before, lt.balance_after,
                  lt.metadata, lt.created_at,
                  CASE
                    WHEN lt.metadata->>'direction' = 'sent' THEN true
                    WHEN lt.metadata->>'direction' = 'received' THEN false
                    ELSE lt.balance_after < lt.balance_before
                  END AS sent,
                  COALESCE(
                    lt.metadata->>'sender_user_id',
                    lt.metadata->>'recipient_user_id'
                  ) AS counterparty_id
             FROM ledger_transactions lt
            WHERE lt.user_id = $1
              AND lt.type = 'creator_tip'::ledger_transaction_type
         ), ranked AS (
           SELECT c.*,
                  COUNT(*) OVER (PARTITION BY c.sent) AS direction_count,
                  SUM(c.amount::numeric) OVER (PARTITION BY c.sent) AS direction_total,
                  ROW_NUMBER() OVER (
                    PARTITION BY c.sent ORDER BY c.created_at DESC
                  ) AS row_num
             FROM classified c
         )
         SELECT r.id, r.amount::text, r.balance_before::text,
                r.balance_after::text, r.metadata, r.created_at, r.sent,
                r.direction_count::text, r.direction_total::text,
                r.counterparty_id,
                COALESCE(u.username, u.email, u.id) AS counterparty_name
           FROM ranked r
           LEFT JOIN "user" u ON u.id = r.counterparty_id
          WHERE r.row_num <= $2
          ORDER BY r.created_at DESC`,
      userId,
      TIP_RECENT_LIMIT,
    ),
    queryMainRows<
      {
        id: string;
        type: string;
        amount: string;
        created_at: Date | string;
        metadata: unknown;
        type_count: string;
        type_total: string | null;
      }[]
    >(
      `SELECT id, type, amount::text, created_at, metadata,
                type_count::text, type_total::text
           FROM (
             SELECT id, type::text AS type, amount, created_at, metadata,
                    COUNT(*) OVER (PARTITION BY type) AS type_count,
                    SUM(amount::numeric) OVER (PARTITION BY type) AS type_total,
                    ROW_NUMBER() OVER (
                      PARTITION BY type ORDER BY created_at DESC
                    ) AS row_num
               FROM ledger_transactions
              WHERE user_id = $1
                AND type IN (
                  'rain_win'::ledger_transaction_type,
                  'affiliate_leaderboard_prize'::ledger_transaction_type,
                  'race_prize'::ledger_transaction_type
                )
           ) ranked
          WHERE row_num <= $2
          ORDER BY created_at DESC`,
      userId,
      TIP_RECENT_LIMIT,
    ),
  ]);
  const aggregate = new Map(
    prizeRows.map((row) => [
      row.type,
      { count: row.type_count, total: row.type_total },
    ]),
  );
  const recentByType = (type: string) =>
    prizeRows.filter((row) => row.type === type);
  const rainAgg = aggregate.get("rain_win");
  const leaderboardAgg = aggregate.get("affiliate_leaderboard_prize");
  const raceAgg = aggregate.get("race_prize");
  const rainRecent = recentByType("rain_win");
  const leaderboardRecent = recentByType("affiliate_leaderboard_prize");
  const raceRecent = recentByType("race_prize");

  type Entry = {
    id: string;
    amountUsd: number;
    counterpartyId: string | null;
    counterpartyName: string | null;
    createdAt: string;
    sent: boolean;
  };

  const entries: Entry[] = rows.map((r) => ({
    id: r.id,
    amountUsd: toNumber(r.amount),
    counterpartyId: r.counterparty_id,
    counterpartyName: r.counterparty_name,
    createdAt: new Date(r.created_at).toISOString(),
    sent: r.sent,
  }));

  const received = entries.filter((e) => !e.sent);
  const sent = entries.filter((e) => e.sent);

  const directionStats = new Map(
    rows.map((row) => [
      row.sent,
      {
        count: Number(row.direction_count ?? 0),
        totalUsd: toNumber(row.direction_total),
      },
    ]),
  );
  const strip = (e: Entry) => ({
    id: e.id,
    amountUsd: e.amountUsd,
    counterpartyId: e.counterpartyId,
    counterpartyName: e.counterpartyName,
    createdAt: e.createdAt,
  });

  return {
    received: {
      count: directionStats.get(false)?.count ?? 0,
      totalUsd: directionStats.get(false)?.totalUsd ?? 0,
      recent: received.slice(0, TIP_RECENT_LIMIT).map(strip),
    },
    sent: {
      count: directionStats.get(true)?.count ?? 0,
      totalUsd: directionStats.get(true)?.totalUsd ?? 0,
      recent: sent.slice(0, TIP_RECENT_LIMIT).map(strip),
    },
    // Rain prizes have no counterparty — they come from the rain pool.
    rainPrizes: {
      count: Number(rainAgg?.count ?? 0),
      totalUsd: toNumber(rainAgg?.total ?? 0),
      recent: rainRecent.map((r) => ({
        id: r.id,
        amountUsd: toNumber(r.amount),
        counterpartyId: null,
        counterpartyName: null,
        createdAt: new Date(r.created_at).toISOString(),
      })),
    },
    // Affiliate-leaderboard wins (affiliate_leaderboard_prize) — credits
    // paid out by creator-leaderboard rankings. Same shape as rain
    // prizes (no counterparty), with two extra fields per row pulled
    // off the prize ledger row's metadata so the UI can label which
    // leaderboard the win came from and deep-link to it.
    leaderboardWins: {
      count: Number(leaderboardAgg?.count ?? 0),
      totalUsd: toNumber(leaderboardAgg?.total ?? 0),
      recent: await enrichLeaderboardWins(leaderboardRecent),
    },
    raceClaims: {
      count: Number(raceAgg?.count ?? 0),
      totalUsd: toNumber(raceAgg?.total ?? 0),
      recent: raceRecent.map((r) => {
        const meta = parseRaceClaimMetadata(r.metadata);
        return {
          id: r.id,
          amountUsd: toNumber(r.amount),
          counterpartyId: null,
          counterpartyName: null,
          createdAt: new Date(r.created_at).toISOString(),
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
  const raceType = m && typeof m.race_type === "string" ? m.race_type : null;
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
    created_at: Date | string;
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
      p.title ??
      (p.leaderboardId ? (titleById.get(p.leaderboardId) ?? null) : null);
    return {
      id: r.id,
      amountUsd: toNumber(r.amount),
      counterpartyId: null,
      counterpartyName: null,
      createdAt: new Date(r.created_at).toISOString(),
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
 *
 * The username branch is a RAW parameterized `lower(username) = lower($1)`
 * lookup rather than an `ILIKE`, which
 * `username ILIKE $1` and (EXPLAIN-proven against prod, read-only) SEQ-SCANS
 * the `"user"` table (cost ≈ 912). Under the MAIN `max:3` pool that seq scan
 * is the crash source on this (#1-traffic) route. The `lower(username) = $1`
 * form is served as an Index Scan by the EXISTING functional index
 * `idx_user_lower_username_prefix` (`btree (lower(username) text_pattern_ops)`):
 * the `text_pattern_ops` opclass includes the `=` operator, so the planner
 * uses it with a clean `Index Cond: (lower(username) = $1)` (cost ≈ 8.30,
 * ~110× cheaper), and a mixed-case input still resolves to the same lowered
 * key. Exact-match semantics are preserved (no wildcard → the route key must
 * equal the whole handle, case-insensitively). UUID / nanoid ids keep the PK
 * lookup path unchanged.
 */
export async function resolveUserIdFromRouteKey(
  key: string,
): Promise<string | null> {
  const trimmed = key.trim();
  if (!trimmed) return null;

  if (isUuid(trimmed) || isUserId(trimmed)) {
    const rows = await queryMainRows<{ id: string }[]>(
      `SELECT id FROM "user" WHERE id = $1 LIMIT 1`,
      trimmed,
    );
    return rows[0]?.id ?? null;
  }

  // Case-insensitive EXACT username → id. Parameterized ($1 via tagged
  // template), so no injection surface; served by
  // idx_user_lower_username_prefix as an Index Scan (see doc comment above).
  const rows = await queryMainRows<{ id: string }[]>(
    `SELECT id FROM "user" WHERE lower(username) = lower($1) LIMIT 1`,
    trimmed,
  );
  return rows[0]?.id ?? null;
}

export async function getUserHeader(id: string): Promise<{
  id: string;
  username: string | null;
  email: string | null;
} | null> {
  const [user] = await queryMainRows<
    { id: string; username: string | null; email: string | null }[]
  >(`SELECT id, username, email FROM "user" WHERE id = $1 LIMIT 1`, id);
  if (!user) return null;
  return { id: user.id, username: user.username, email: user.email };
}

type UserDetailBalanceRow = {
  available_balance: string;
  locked_balance: string;
  total_wagered: string;
  total_won: string;
  unlock_at: Date | string | null;
  wager_requirement_remaining: string | null;
  wager_requirement_progress: string | null;
};

/**
 * Fetch the rendered balance fields and the two wager-debt fields together.
 * The shared capability probe keeps dev/prod schema drift safe and is also
 * reused by getUserWagerProgress during the same request.
 */
async function getUserDetailBalances(
  id: string,
): Promise<UserDetailBalanceRow | null> {
  const hasWagerColumns = await hasWagerProgressColumns();
  const wagerColumns = hasWagerColumns
    ? `wager_requirement_remaining::text AS wager_requirement_remaining,
       wager_requirement_progress::text AS wager_requirement_progress`
    : `NULL::text AS wager_requirement_remaining,
       NULL::text AS wager_requirement_progress`;
  const rows = await queryMainRows<UserDetailBalanceRow[]>(
    `SELECT available_balance::text, locked_balance::text,
            total_wagered::text, total_won::text, unlock_at,
            ${wagerColumns}
       FROM balances WHERE user_id = $1 LIMIT 1`,
    id,
  );
  return rows[0] ?? null;
}

export async function getUserDetail(id: string) {
  // Everything is independent — one Promise.all instead of two serialized ones
  // cuts the worst-case latency roughly in half on hot user-detail loads.
  let wagerBreakdown: { type: string; _sum: { amount: unknown } }[] = [];

  // Wager-breakdown groupBy — the requested type list is intersected against
  // the LIVE prod enum at call time (filterLedgerTxTypesLive), NOT just the
  // generated enum. The generated schema is ahead of prod for the
  // unlaunched upgrader feature: passing `upgrader_bet` into an enum
  // predicate made Postgres throw `22P02 invalid input value for
  // enum`, which the .catch below silently swallowed → packs/battles-wagered
  // tiles rendered 0 on every prod profile. The live probe is 5-min
  // unstable_cache'd, so steady-state adds no extra round trip.
  const wagerBreakdownPromise = filterLedgerTxTypesLive([
    "pack_opening",
    "battle_bet",
    "battle_sponsorship",
    "upgrader_bet",
  ])
    .then((types) =>
      types.length === 0
        ? []
        : queryMainRows<{ type: string; amount: string | null }[]>(
            `SELECT type::text AS type, SUM(amount::numeric)::text AS amount
               FROM ledger_transactions
              WHERE user_id = $1
                AND type = ANY($2::ledger_transaction_type[])
                AND status = 'completed'::ledger_transaction_status
              GROUP BY type`,
            id,
            types,
          ).then((rows) =>
            rows.map((row) => ({
              type: row.type,
              _sum: { amount: row.amount },
            })),
          ),
    )
    .catch((e) => {
      logError("users.detail.wagerBreakdown", "query failed", e);
      return [] as { type: string; _sum: { amount: unknown } }[];
    });

  // Excluded (blacklisted) user ids for the per-owned-code referral count
  // below, resolved with the SAME default (non-search) semantics
  // /users?affiliateCode=<code> and /users?affiliateOwnerId=<ownerId> use
  // when reached via the plain "View referrals" link (no active search term
  // → getExcludedUserIdsForAdminSearch's `isSearching: false` branch, which
  // returns the FULL excluded_users blacklist regardless of
  // includeAllBlacklisted). Without this, a referred user who is on the
  // blacklist inflated the displayed count above what clicking through
  // actually lists. Independent of `id` — resolved once and reused by the
  // referral-count query promise below.
  const ownedCodeReferralCountPromise = getExcludedUserIdsForAdminSearch({
    includeAllBlacklisted: false,
    isSearching: false,
  })
    .then((excludedUserIds) =>
      queryMainRows<
        { upper_code: string; referral_count: string | number | null }[]
      >(
        `
        WITH codes AS (
          SELECT UPPER(code) AS upper_code FROM affiliate_codes WHERE user_id = $1
        )
        SELECT c.upper_code,
               COUNT(DISTINCT acu.referred_user_id) AS referral_count
          FROM codes c
          LEFT JOIN affiliate_code_usages acu
                 ON UPPER(acu.code) = c.upper_code
                AND NOT (acu.referred_user_id = ANY($2::text[]))
         GROUP BY c.upper_code
        `,
        id,
        excludedUserIds,
      ),
    )
    .catch((e) => {
      logError("users.detail.referralCounts", "query failed", e);
      return [] as Array<{
        upper_code: string;
        referral_count: string | number | null;
      }>;
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
  const balancesPromise = getUserDetailBalances(id);

  // Device-fingerprint alt-account signal (fingerprints table — device
  // fingerprinting on signup/login, index-backed on user_id + visitor_id;
  // see idx_fingerprints_user_id / idx_fingerprints_visitor_id). Two parts:
  //   - suspectedAlt mirrors the platform's OWN heuristic
  //     (fingerprints.suspected_alt_triggered) for this user.
  //   - linkedDeviceAccountCount counts OTHER accounts that share ANY of
  //     this user's device visitor_ids — a broader, purely-derived overlap
  //     signal that can be non-zero even when the platform flag never
  //     fired. `my_fp` empty (no fingerprint rows yet — the feature is new,
  //     table is empty on prod as of 2026-07-22) degrades both to
  //     false/0 via COALESCE / the empty-set IN, not an error.
  // Best-effort: a failure degrades to "no signal" rather than blocking the
  // whole fan-out.
  // Other accounts that signed up from the SAME IP. Best-effort, and
  // deliberately a count rather than a flag — see UserDetail.signupIpSharedCount.
  // `user.signup_ip` is NOT indexed (verified against prod), so this is a
  // sequential scan over ~16.5k rows; cheap today, wants an index in the
  // backend repo before the table grows much further.
  // Keyed on the user ID, not on signup_ip, so it can run inside the same
  // parallel fan-out — resolving the IP first would cost a sequential
  // round-trip. GREATEST(...,0) keeps a NULL signup_ip at 0 rather than -1.
  const signupIpSharedPromise = queryMainRows<{ others: number | null }[]>(
    `
      SELECT GREATEST(COUNT(*) - 1, 0)::int AS others
        FROM "user"
       WHERE signup_ip IS NOT NULL
         AND signup_ip = (SELECT signup_ip FROM "user" WHERE id = $1)
    `,
    id,
  )
    .then((rows) => Number(rows[0]?.others ?? 0))
    .catch((e) => {
      logError("users.detail.sharedSignupIp", "query failed", e);
      return 0;
    });

  const fingerprintSignalPromise = queryMainRows<
    {
      suspected_alt: boolean | null;
      linked_count: string | number | null;
      capture_count: number | null;
      captured_at: Date | string | null;
      best_confidence: number | null;
      visitor_id: string | null;
      distinct_visitor_ids: number | null;
      signup_capture_count: number | null;
      login_capture_count: number | null;
      last_login_at: Date | string | null;
      last_login_ip: string | null;
      last_login_visitor_id: string | null;
    }[]
  >(
    `
      WITH my_fp AS (
        SELECT visitor_id, suspected_alt_triggered, confidence, created_at,
          event_type, ip
        FROM fingerprints
        WHERE user_id = $1
      )
      SELECT
        COALESCE(bool_or(suspected_alt_triggered), false) AS suspected_alt,
        COUNT(*)::int AS capture_count,
        MAX(created_at) AS captured_at,
        MAX(confidence) AS best_confidence,
        -- The MOST RECENT visitor_id, not an arbitrary one: a user can have
        -- several (new device, cleared storage), and the newest is the one
        -- that matters when reviewing the account now.
        (array_agg(visitor_id ORDER BY created_at DESC))[1] AS visitor_id,
        COUNT(DISTINCT visitor_id)::int AS distinct_visitor_ids,
        COUNT(*) FILTER (WHERE event_type::text = 'signup')::int AS signup_capture_count,
        COUNT(*) FILTER (WHERE event_type::text = 'login')::int AS login_capture_count,
        MAX(created_at) FILTER (WHERE event_type::text = 'login') AS last_login_at,
        (array_agg(ip::text ORDER BY created_at DESC)
          FILTER (WHERE event_type::text = 'login'))[1] AS last_login_ip,
        (array_agg(visitor_id ORDER BY created_at DESC)
          FILTER (WHERE event_type::text = 'login'))[1] AS last_login_visitor_id,
        (
          SELECT COUNT(DISTINCT f.user_id)
          FROM fingerprints f
          WHERE f.visitor_id IN (SELECT visitor_id FROM my_fp)
            AND f.user_id IS NOT NULL
            AND f.user_id != $1
        ) AS linked_count
      FROM my_fp
      `,
    id,
  )
    .then((rows) => ({
      suspectedAlt: rows[0]?.suspected_alt ?? false,
      linkedDeviceAccountCount: Number(rows[0]?.linked_count ?? 0),
      // Capture facts — these drive the ALWAYS-visible device chip, so
      // "never captured" is a state the admin can see rather than infer
      // from the absence of a flag. Aggregates over an empty my_fp yield
      // 0 / NULL (one row is still returned), never an error.
      deviceCaptureCount: Number(rows[0]?.capture_count ?? 0),
      deviceCapturedAt: rows[0]?.captured_at
        ? new Date(rows[0].captured_at).toISOString()
        : null,
      deviceConfidence: rows[0]?.best_confidence ?? null,
      deviceVisitorId: rows[0]?.visitor_id ?? null,
      deviceVisitorIdCount: Number(rows[0]?.distinct_visitor_ids ?? 0),
      deviceSignupCaptureCount: Number(rows[0]?.signup_capture_count ?? 0),
      deviceLoginCaptureCount: Number(rows[0]?.login_capture_count ?? 0),
      deviceLastLoginAt: rows[0]?.last_login_at
        ? new Date(rows[0].last_login_at).toISOString()
        : null,
      deviceLastLoginIp: rows[0]?.last_login_ip ?? null,
      deviceLastLoginVisitorId: rows[0]?.last_login_visitor_id ?? null,
    }))
    .catch((e) => {
      logError("users.detail.fingerprint", "query failed", e);
      return {
        suspectedAlt: false,
        linkedDeviceAccountCount: 0,
        deviceCaptureCount: 0,
        deviceCapturedAt: null,
        deviceConfidence: null,
        deviceVisitorId: null,
        deviceVisitorIdCount: 0,
        deviceSignupCaptureCount: 0,
        deviceLoginCaptureCount: 0,
        deviceLastLoginAt: null,
        deviceLastLoginIp: null,
        deviceLastLoginVisitorId: null,
      };
    });

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
    ownedCodeReferralCountRows,
    tips,
    liveAffiliateRows,
    fingerprintSignal,
    signupIpSharedCount,
  ] = await Promise.all([
    queryMainRows<
      (typeof mainSchema.user.$inferSelect & {
        account: {
          providerId: string;
          accountId: string;
          created_at: string | null;
        }[];
        referrer_context: {
          username: string | null;
          email: string | null;
          affiliate_code: string | null;
        } | null;
        signup_referral_code: string | null;
        latest_referral_code: string | null;
      })[]
    >(
      `SELECT u.*,
              (
                SELECT jsonb_build_object(
                  'username', r.username,
                  'email', r.email,
                  'affiliate_code', r.affiliate_code
                )
                  FROM "user" r
                 WHERE r.id = u.referred_by
                 LIMIT 1
              ) AS referrer_context,
              (
                SELECT acu.code
                  FROM affiliate_code_usages acu
                 WHERE acu.referred_user_id = u.id
                   AND acu.usage_type::text = 'signup'
                 ORDER BY acu.created_at DESC
                 LIMIT 1
              ) AS signup_referral_code,
              (
                SELECT acu.code
                  FROM affiliate_code_usages acu
                 WHERE acu.referred_user_id = u.id
                 ORDER BY acu.created_at DESC
                 LIMIT 1
              ) AS latest_referral_code,
              COALESCE(
                jsonb_agg(jsonb_build_object(
                  'providerId', a."providerId",
                  'accountId', a."accountId",
                  'created_at', a.created_at
                )) FILTER (WHERE a.id IS NOT NULL),
                '[]'::jsonb
              ) AS account
         FROM "user" u
         LEFT JOIN account a ON a."userId" = u.id
        WHERE u.id = $1
        GROUP BY u.id`,
      id,
    ).then((rows) => rows[0] ?? null),
    balancesPromise,
    queryMainRows<(typeof mainSchema.user_statistics.$inferSelect)[]>(
      `SELECT * FROM user_statistics WHERE user_id = $1 LIMIT 1`,
      id,
    ).then((rows) => rows[0] ?? null),
    queryMainRows<(typeof mainSchema.user_feature_locks.$inferSelect)[]>(
      `SELECT * FROM user_feature_locks WHERE user_id = $1 LIMIT 1`,
      id,
    ).then((rows) => rows[0] ?? null),
    // user_battle_limits now EXISTS on live prod (verified read-only via
    // to_regclass, 2026-07-01), so the historical missing-table throw
    // this .catch was written for no longer fires there. The .catch is KEPT
    // as defence-in-depth: the same generated client also serves the
    // dev-toggled DB (which can lag prod's migration state), and a bare
    // rejection here would take down the WHOLE 19-promise aggregate and
    // render the amber error instead of the page. On prod a null now means
    // "no per-user override row" (site_config defaults apply) — the TRUE
    // answer — returned by the query itself, not the catch.
    queryMainRows<(typeof mainSchema.user_battle_limits.$inferSelect)[]>(
      `SELECT * FROM user_battle_limits WHERE user_id = $1 LIMIT 1`,
      id,
    )
      .then((rows) => rows[0] ?? null)
      .catch(() => null),
    queryMainRows<{ count: string }[]>(
      `SELECT COUNT(*)::text AS count FROM user_inventory
        WHERE user_id = $1 AND sold_at IS NULL AND exchanged_at IS NULL`,
      id,
    ).then((rows) => Number(rows[0]?.count ?? 0)),
    queryMainRows<(typeof mainSchema.affiliate_accounts.$inferSelect)[]>(
      `SELECT * FROM affiliate_accounts WHERE user_id = $1 LIMIT 1`,
      id,
    ).then((rows) => rows[0] ?? null),
    queryMainRows<(typeof mainSchema.shipping_addresses.$inferSelect)[]>(
      `SELECT * FROM shipping_addresses WHERE user_id = $1 LIMIT 1`,
      id,
    ).then((rows) => rows[0] ?? null),
    queryMainRows<(typeof mainSchema.vaults.$inferSelect)[]>(
      `SELECT * FROM vaults WHERE user_id = $1 LIMIT 1`,
      id,
    ).then((rows) => rows[0] ?? null),
    queryMainRows<(typeof mainSchema.user_mutes.$inferSelect)[]>(
      `SELECT * FROM user_mutes WHERE user_id = $1
        ORDER BY created_at DESC LIMIT $2`,
      id,
      10,
    ),
    queryMainRows<(typeof mainSchema.card_withdrawal_requests.$inferSelect)[]>(
      `SELECT * FROM card_withdrawal_requests WHERE user_id = $1
        ORDER BY requested_at DESC LIMIT $2`,
      id,
      10,
    ),
    queryMainRows<(typeof mainSchema.active_seeds.$inferSelect)[]>(
      `SELECT * FROM active_seeds WHERE user_id = $1 LIMIT 1`,
      id,
    ).then((rows) => rows[0] ?? null),
    queryMainRows<(typeof mainSchema.deposit_addresses.$inferSelect)[]>(
      `SELECT * FROM deposit_addresses
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      id,
      50,
    ),
    // Event counts surfaced at the top of the detail page header. Counts
    // are defined to mirror the existing "total withdrawn" aggregate in
    // balances so the header and the Balances card agree on what counts
    // as a completed deposit / withdrawal. Combined count + sum into one
    // aggregate call so we hit the deposit ledger filter exactly once
    // instead of twice — same plan, half the round-trips.
    queryMainRows<
      { count: string; total: string | null; fiat_total: string | null }[]
    >(
      `SELECT COUNT(*)::text AS count,
              SUM(amount::numeric)::text AS total,
              SUM(amount::numeric) FILTER (
                WHERE crypto_asset IS NULL
              )::text AS fiat_total
         FROM ledger_transactions
        WHERE user_id = $1
          AND type = 'deposit'::ledger_transaction_type
          AND status = 'completed'::ledger_transaction_status`,
      id,
    ).then(([row]) => ({
      _count: { _all: Number(row?.count ?? 0) },
      _sum: { amount: row?.total ?? null },
      fiatAmount: row?.fiat_total ?? null,
    })),
    queryMainRows<{ count: string }[]>(
      `SELECT COUNT(*)::text AS count FROM card_withdrawal_requests
        WHERE user_id = $1 AND status = ANY($2::card_withdrawal_status[])`,
      id,
      ["completed", "shipped"],
    ).then((rows) => Number(rows[0]?.count ?? 0)),
    userPnlPromise,
    wagerBreakdownPromise,
    // Every code this user owns (rows in affiliate_codes). No dependency
    // on any other query result — keyed on the id param — so it runs in
    // the main batch instead of a serial tail. orderBy created_at ASC:
    // the LAST row is the newest, used as the affiliate-code fallback
    // below (replaces the dropped findFirst ... orderBy desc limit 1).
    queryMainRows<{ code: string; created_at: Date | string }[]>(
      `SELECT code, created_at FROM affiliate_codes
        WHERE user_id = $1 ORDER BY created_at ASC`,
      id,
    ),
    // Per-owned-code referral counts for the "Codes they own" list — DISTINCT
    // referred_user_id per code, same case-fold (UPPER(code)) and
    // no-usage_type-restriction semantics as getCodeReferrals/getCodeAnalytics
    // (creators-codes.ts), so the number shown next to each code here agrees
    // with what /users?affiliateCode=<code> ("View referrals" link,
    // OwnedCodeRow below) actually lists — including the excluded_users
    // blacklist exclusion that list applies (see ownedCodeReferralCountPromise
    // above). Keyed on `id` only (not on ownedCodeRows' resolved value) via
    // its own `codes` CTE, so it runs in this same batch instead of a serial
    // tail waiting on ownedCodeRows. UPPER(code) is index-backed on prod
    // (idx_acu_upper_code — see prisma/recommended-indexes.sql #5c APPLIED
    // STATUS), the same index the sibling live-affiliate-aggregate query
    // below already relies on. .catch keeps a schema hiccup from taking down
    // the whole aggregate — an empty array degrades every code's count to 0
    // via the Map lookup below, not a broken page.
    ownedCodeReferralCountPromise,
    // Creator tips received + sent (both are creator_tip rows, split by
    // metadata.direction). Runs in parallel; resolves counterparty names
    // for the shown rows internally.
    getUserTips(id),
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
    queryMainRows<
      {
        total_referred: string | number | null;
        total_wager_volume_usd: string | null;
      }[]
    >(
      `
      WITH codes AS (
        SELECT UPPER(code) AS uc FROM affiliate_codes WHERE user_id = $1
      )
      SELECT
        (SELECT COUNT(DISTINCT acu.referred_user_id)
           FROM affiliate_code_usages acu
           WHERE UPPER(acu.code) IN (SELECT uc FROM codes)) AS total_referred,
        (SELECT COALESCE(SUM(acu.wager_amount_usd::numeric), 0)::text
           FROM affiliate_code_usages acu
           WHERE UPPER(acu.code) IN (SELECT uc FROM codes)
             AND acu.usage_type::text = 'wager') AS total_wager_volume_usd
      `,
      id,
    ).catch((e) => {
      logError("users.detail.affiliateAggregate", "query failed", e);
      return [] as Array<{
        total_referred: string | number | null;
        total_wager_volume_usd: string | null;
      }>;
    }),
    fingerprintSignalPromise,
    signupIpSharedPromise,
  ]);

  const depositCount = depositAgg._count._all;
  const depositTotalAgg = depositAgg;

  wagerBreakdown = wagerBreakdownResolved as typeof wagerBreakdown;

  if (!user) return null;

  // WITHDRAWAL SUPPRESSION for blacklisted (excluded_users) users. A
  // blacklisted user (e.g. kartos) is hidden wholesale from analytics/PnL
  // elsewhere; on the per-user detail surface we additionally hide ALL of
  // their WITHDRAWAL entries + amounts (every method, not just balance) while
  // keeping the rest of the page viewable. Deposits, inventory, gaming and
  // every other section are untouched.
  //
  // Gated GENERICALLY on blacklist membership (no hardcoded id) and applied
  // for EVERYONE viewing — there is no per-admin override that re-exposes it.
  // `getExcludedUserIds` reads the ADMIN DB (allowed), is React-cache()'d so
  // it costs one admin-DB round trip per request, and fails CLOSED (throws if
  // the blacklist is unavailable and no prior good list exists) — matching how
  // the rest of the app scopes on this list.
  const isBlacklisted = (await getExcludedUserIds()).includes(user.id);

  // Referrer identity + the latest usage code are folded into the main user
  // query above. This avoids a serial post-aggregate query tail for every
  // referred account while preserving the historical signup-code fallback
  // for environments whose affiliate_usage_type enum includes that member.
  let referredByUsername: string | null = null;
  let referredByCode: string | null = null;
  if (user.referred_by) {
    const referrer = user.referrer_context;
    referredByUsername =
      referrer?.username ?? referrer?.email ?? user.referred_by;
    // Resolution order:
    //   1. historical signup usage (when the environment records it),
    //   2. the active code the user is on now (user.affiliate_code —
    //      set by the admin override), which is what wager income
    //      follows,
    //   3. the latest recorded usage row (manual/deposit attribution),
    //   4. the referrer's own code as a last resort.
    // NOTE: referrer.affiliate_code is the code the OWNER is carrying,
    // not necessarily a code they own, so it's the weakest fallback.
    referredByCode =
      user.signup_referral_code ??
      user.affiliate_code ??
      user.latest_referral_code ??
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
  // UPPER(code) -> distinct referred-user count, from the batched query
  // above. The LEFT JOIN there means every owned code appears exactly once
  // (a code with zero usage rows still gets one grouped row with
  // referral_count = 0, not a missing row) — the `?? 0` on the Map lookup
  // is just defence-in-depth for the .catch()-empty-array failure path.
  const referralCountByUpperCode = new Map<string, number>(
    ownedCodeReferralCountRows.map((r) => [
      r.upper_code,
      Number(r.referral_count ?? 0),
    ]),
  );
  const ownedCodes = ownedCodeRows.map((c) => ({
    code: c.code,
    createdAt: new Date(c.created_at).toISOString(),
    isPrimary: c.code === user.affiliate_code,
    referralCount: referralCountByUpperCode.get(c.code.toUpperCase()) ?? 0,
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
      bannedAt: user.banned_at ? toIso(user.banned_at) : null,
      bannedBy: user.banned_by,
      isLocked: user.is_locked,
      lockedReason: user.locked_reason,
      lockedAt: user.locked_at ? toIso(user.locked_at) : null,
      lockedBy: user.locked_by,
      lockedUntil: user.locked_until ? toIso(user.locked_until) : null,
      // Self-exclusion (responsible-gambling). USER-initiated on the game
      // platform — there is no admin endpoint to impose/lift it, so this is
      // DISPLAY-ONLY here. Mirrors the four game-DB columns straight off the
      // user row (no extra query — they live on the same select
      // as banned/locked). `isSelfExcluded` can be true while
      // `selfExcludedUntil` is in the PAST = EXPIRED; the view derives
      // active-vs-expired from the timestamp, this just surfaces the raw
      // fields. When active, the user is currently restricted on the game
      // platform (the betting/withdrawal routes 403 for them).
      isSelfExcluded: user.is_self_excluded,
      selfExcludedReason: user.self_excluded_reason,
      selfExcludedAt: user.self_excluded_at
        ? toIso(user.self_excluded_at)
        : null,
      selfExcludedUntil: user.self_excluded_until
        ? toIso(user.self_excluded_until)
        : null,
      // Device-fingerprint alt-account signal — see fingerprintSignalPromise
      // above. suspectedAlt mirrors the platform's own heuristic;
      // linkedDeviceAccountCount is the broader device-overlap count (can be
      // >0 even when suspectedAlt is false).
      suspectedAlt: fingerprintSignal.suspectedAlt,
      linkedDeviceAccountCount: fingerprintSignal.linkedDeviceAccountCount,
      deviceCaptureCount: fingerprintSignal.deviceCaptureCount,
      deviceCapturedAt: fingerprintSignal.deviceCapturedAt,
      deviceConfidence: fingerprintSignal.deviceConfidence,
      deviceVisitorId: fingerprintSignal.deviceVisitorId,
      deviceVisitorIdCount: fingerprintSignal.deviceVisitorIdCount,
      deviceSignupCaptureCount: fingerprintSignal.deviceSignupCaptureCount,
      deviceLoginCaptureCount: fingerprintSignal.deviceLoginCaptureCount,
      deviceLastLoginAt: fingerprintSignal.deviceLastLoginAt,
      deviceLastLoginIp: fingerprintSignal.deviceLastLoginIp,
      deviceLastLoginVisitorId: fingerprintSignal.deviceLastLoginVisitorId,
      country: user.country,
      countryCode: user.country_code,
      city: user.city,
      state: user.state,
      continentCode: user.continent_code,
      signupIp: user.signup_ip,
      signupIpSharedCount,
      referredBy: user.referred_by,
      referredByUsername,
      referredByCode,
      ownedCodes,
      affiliateCode: user.affiliate_code,
      affiliateCodeActive: user.affiliate_code_active ?? false,
      affiliateCodeExpiresAt: user.affiliate_code_expires_at
        ? toIso(user.affiliate_code_expires_at)
        : null,
      affiliateBonusOptedIn: user.affiliate_bonus_opted_in ?? false,
      hasApiKey: !!user.api_key,
      createdAt: toIso(user.created_at),
      updatedAt: toIso(user.updated_at),
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
          const ta = toMillis(a.created_at);
          const tb = toMillis(b.created_at);
          return ta - tb;
        });
        return sorted[0]?.providerId ?? null;
      })(),
      discord: (() => {
        const dc = user.account.find((a) => a.providerId === "discord");
        if (!dc) return null;
        return {
          id: dc.accountId,
          linkedAt: dc.created_at ? toIso(dc.created_at) : null,
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
          // VAULT-COOLDOWN pocket — see balances type doc. Distinct from the
          // bonus wager-locked debt (wagerLocked below): this is the user's
          // own money, just inside the cooldown window paired with unlockAt.
          lockedBalance: toNumber(balances.locked_balance),
          // FROZEN-RATE bonus debt that gates withdrawals — distinct from
          // the vault cooldown (lockedBalance above). These come from the
          // same balance-row query as the visible balance fields.
          wagerLocked:
            balances.wager_requirement_remaining == null
              ? null
              : toNumber(balances.wager_requirement_remaining),
          wagerProgress:
            balances.wager_requirement_progress == null
              ? null
              : toNumber(balances.wager_requirement_progress),
          // P&L components come from the shared helper so this view can
          // never drift from users-list / dashboard.
          totalDeposited: userPnl.deposits,
          // Fiat (non-crypto / card) portion of completed deposits — from the
          // combined deposit aggregate above. Lifetime; surfaced on the P&L box, KYC
          // decision panel, and Account tab as an "of which fiat" figure.
          fiatDeposits: toNumber(depositAgg.fiatAmount ?? 0),
          // Blacklisted user → hide the lifetime withdrawn total. Every
          // consumer composes the displayed P&L client-side as
          // `deposits − totalWithdrawn − onSiteBalance − inventory − vouchers`
          // (see user-view-modern*.tsx / user-tabs-cards.tsx), so zeroing the
          // withdrawals term HERE keeps the shown "Total Withdrawn" KPI, the
          // balance breakdown, AND the composed P&L / net internally
          // consistent (P&L recomputed as if withdrawals were 0 — never a
          // stale/original withdrawal figure). `availableBalance` is derived
          // from `userPnl.onSiteBalance`, which never included withdrawals, so
          // the balance is untouched.
          totalWithdrawn: isBlacklisted ? 0 : userPnl.withdrawals,
          totalWagered: toNumber(balances.total_wagered),
          totalWon: toNumber(balances.total_won),
          unlockAt: balances.unlock_at
            ? new Date(balances.unlock_at).toISOString()
            : null,
          inventoryValue: userPnl.inventoryValue,
          vouchersValue: userPnl.unclaimedVouchers,
          packsWagered: Math.abs(
            toNumber(
              wagerBreakdown.find((w) => w.type === "pack_opening")?._sum
                .amount ?? 0,
            ),
          ),
          battlesWagered: Math.abs(
            toNumber(
              wagerBreakdown.find((w) => w.type === "battle_bet")?._sum
                .amount ?? 0,
            ) +
              toNumber(
                wagerBreakdown.find((w) => w.type === "battle_sponsorship")
                  ?._sum.amount ?? 0,
              ),
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
          lastWageredAt: statistics.last_wagered_at
            ? toIso(statistics.last_wagered_at)
            : null,
          currentDayWageredUsd: toNumber(statistics.current_day_wagered_usd),
          currentWeekWageredUsd: toNumber(statistics.current_week_wagered_usd),
          currentMonthWageredUsd: toNumber(
            statistics.current_month_wagered_usd,
          ),
          isProfilePrivate: statistics.is_profile_private,
        }
      : null,
    featureLocks: featureLocks
      ? {
          lockedWithdrawalsCrypto:
            featureLocks.locked_withdrawals_crypto.length > 0,
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
        totalEarnedUsd: affiliateAccount
          ? toNumber(affiliateAccount.total_earned_usd)
          : 0,
        availableUsd: affiliateAccount
          ? toNumber(affiliateAccount.available_usd)
          : 0,
        totalPaidOutUsd: affiliateAccount
          ? toNumber(affiliateAccount.total_paid_out_usd)
          : 0,
        totalBonusDistributedUsd: affiliateAccount
          ? toNumber(affiliateAccount.total_bonus_distributed_usd)
          : 0,
        lastPayoutAt: affiliateAccount?.last_payout_at
          ? toIso(affiliateAccount.last_payout_at)
          : null,
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
          createdAt: toIso(vault.created_at),
        }
      : null,
    mutes: mutes.map((m) => ({
      id: m.id,
      mutedBy: m.muted_by,
      reason: m.reason,
      expiresAt: m.expires_at ? toIso(m.expires_at) : null,
      unmutedAt: m.unmuted_at ? toIso(m.unmuted_at) : null,
      unmutedBy: m.unmuted_by,
      createdAt: toIso(m.created_at),
    })),
    // Blacklisted user → hide the whole card-withdrawal-requests list (the
    // "Card Withdrawals" sub-table on the Deposits & Withdrawals tab).
    cardWithdrawals: isBlacklisted
      ? []
      : cardWithdrawals.map((cw) => ({
          id: cw.id,
          method: cw.method,
          totalValueUsd: toNumber(cw.total_value_usd),
          shippingFeeUsd: cw.shipping_fee_usd
            ? toNumber(cw.shipping_fee_usd)
            : null,
          trackingNumber: cw.tracking_number,
          carrier: cw.carrier,
          status: cw.status,
          failureReason: cw.failure_reason,
          requestedAt: toIso(cw.requested_at),
          completedAt: cw.completed_at ? toIso(cw.completed_at) : null,
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
      createdAt: toIso(da.created_at),
    })),
    counts: {
      deposits: depositCount,
      // Blacklisted user → hide the withdrawal count in the deposits/
      // withdrawals count tile.
      withdrawals: isBlacklisted ? 0 : withdrawalCount,
      avgDeposit:
        depositCount > 0
          ? toNumber(depositTotalAgg._sum.amount ?? 0) / depositCount
          : 0,
    },
  };
}
