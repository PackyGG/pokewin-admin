import { unstable_cache } from "next/cache";
import { queryMainRows } from "@/lib/drizzle-query";
import { toNumber } from "@/lib/utils/decimal";
import type { PaginatedResult } from "@/lib/types";

type PromoCodeDbRow = {
  id: string;
  code_hash: string;
  value: string;
  region: string;
  minimum_level: number;
  minimum_wager_amount: string;
  wager_period_days: number;
  minimum_account_age_days: number;
  maximum_account_age_hours: number;
  minimum_deposit_amount: string;
  minimum_recent_deposit_amount: string;
  recent_deposit_period_minutes: number;
  required_affiliate_code: string | null;
  requires_discord: boolean;
  max_uses: number;
  expires_at: Date | null;
  created_at: Date;
  metadata: unknown;
};

export type PromoCodeListItem = {
  id: string;
  code: string | null;
  codeHash: string;
  value: number;
  region: string;
  minimumLevel: number;
  /** Lifetime wager required (USD) before the user can redeem. 0 = no gate. */
  minimumWagerAmount: number;
  /**
   * Window the wager requirement is evaluated over (days). 0 means "all-time
   * lifetime wager"; non-zero means "wager in the last N days".
   */
  wagerPeriodDays: number;
  /** Minimum account age in days before the user can redeem. 0 = no gate. */
  minimumAccountAgeDays: number;
  /**
   * Brand-new-signup gate — max account age in HOURS. 0 = no maximum
   * (redeemable at any age). Non-zero means "new signups only, first N hours".
   */
  maximumAccountAgeHours: number;
  /** All-time deposit total (USD) the user must reach before redeeming. 0 = no gate. */
  minimumDepositAmount: number;
  /**
   * Windowed recent-deposit gate — USD the user must have deposited within the
   * last `recentDepositPeriodMinutes`. 0 = no gate (both must be > 0 to enable).
   */
  minimumRecentDepositAmount: number;
  /** Window (minutes) the recent-deposit gate is evaluated over. 0 = no gate. */
  recentDepositPeriodMinutes: number;
  /** If set, the user must have signed up with this exact affiliate code (case-insensitive). */
  requiredAffiliateCode: string | null;
  /** Whether the user must have a linked Discord account to redeem. */
  requiresDiscord: boolean;
  maxUses: number;
  redemptionCount: number;
  expiresAt: string | null;
  createdAt: string;
};

export async function getPromoCodes(params: {
  page?: number;
  perPage?: number;
  region?: string;
  status?: string;
}): Promise<PaginatedResult<PromoCodeListItem>> {
  const { page = 1, perPage = 20, region, status } = params;
  const safePage = Math.max(1, Math.floor(page));
  const safePerPage = Math.max(1, Math.min(200, Math.floor(perPage)));
  const binds: unknown[] = [];
  const filters: string[] = [];
  if (region && region !== "all") {
    binds.push(region);
    filters.push(`pc.region::text = $${binds.length}`);
  }
  if (status === "active") {
    filters.push(`(pc.expires_at IS NULL OR pc.expires_at > NOW())`);
  } else if (status === "expired") {
    filters.push(`pc.expires_at <= NOW()`);
  }
  const whereSql = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
  const limitIndex = binds.length + 1;
  const offsetIndex = binds.length + 2;
  const [codes, countRows] = await Promise.all([
    queryMainRows<(PromoCodeDbRow & { redemption_count: string })[]>(
      `SELECT pc.*, COALESCE(redemptions.cnt, 0)::text AS redemption_count
         FROM promo_codes pc
         LEFT JOIN (
           SELECT promo_code_id, COUNT(*) AS cnt
             FROM promo_code_redemptions
            GROUP BY promo_code_id
         ) redemptions ON redemptions.promo_code_id = pc.id
         ${whereSql}
         ORDER BY pc.created_at DESC
         LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
      ...binds,
      safePerPage,
      (safePage - 1) * safePerPage,
    ),
    queryMainRows<{ total: string }[]>(
      `SELECT COUNT(*)::text AS total FROM promo_codes pc ${whereSql}`,
      ...binds,
    ),
  ]);
  const total = Number(countRows[0]?.total ?? 0);

  return {
    data: codes.map((c) => {
      const meta = c.metadata as Record<string, unknown> | null;
      return {
        id: c.id,
        code: (meta?.code as string) ?? null,
        codeHash: c.code_hash,
        value: toNumber(c.value),
        region: c.region,
        minimumLevel: c.minimum_level,
        minimumWagerAmount: toNumber(c.minimum_wager_amount),
        wagerPeriodDays: c.wager_period_days,
        minimumAccountAgeDays: c.minimum_account_age_days,
        maximumAccountAgeHours: c.maximum_account_age_hours,
        minimumDepositAmount: toNumber(c.minimum_deposit_amount),
        minimumRecentDepositAmount: toNumber(c.minimum_recent_deposit_amount),
        recentDepositPeriodMinutes: c.recent_deposit_period_minutes,
        requiredAffiliateCode: c.required_affiliate_code,
        requiresDiscord: c.requires_discord,
        maxUses: c.max_uses,
        redemptionCount: Number(c.redemption_count),
        expiresAt: c.expires_at?.toISOString() ?? null,
        createdAt: c.created_at.toISOString(),
      };
    }),
    total,
    page: safePage,
    perPage: safePerPage,
    totalPages: Math.ceil(total / safePerPage),
  };
}

// The redemptions list on the detail page is BOUNDED at this limit so a
// heavily-redeemed code can't drag an unbounded row-set into the page. The
// real (unbounded) count lives on the header (`getPromoCodeDetail`) via
// `count()` so "Remaining" / "Redemptions n/max" stay correct past the cap.
const DETAIL_REDEMPTIONS_LIMIT = 100;

/**
 * Header + config + REAL (unbounded) redemption count for the /promo-codes/[id]
 * detail page shell. Deliberately does NOT pull the redemption rows — those
 * stream in separately via `getPromoCodeRedemptionRows` behind the page's
 * Suspense boundary so the PageHero + KPI strip paint immediately.
 *
 * `redemptionCount` is a real `count()` (not a capped `.length`) so the
 * "Remaining" tile and the "n / max" figure are correct even past the
 * DETAIL_REDEMPTIONS_LIMIT row cap.
 */
export async function getPromoCodeDetail(id: string) {
  const [codeRows, countRows] = await Promise.all([
    queryMainRows<PromoCodeDbRow[]>(
      `SELECT * FROM promo_codes WHERE id = $1::uuid LIMIT 1`,
      id,
    ),
    queryMainRows<{ count: string }[]>(
      `SELECT COUNT(*)::text AS count
         FROM promo_code_redemptions WHERE promo_code_id = $1::uuid`,
      id,
    ),
  ]);
  const code = codeRows[0];
  const redemptionCount = Number(countRows[0]?.count ?? 0);
  if (!code) return null;

  const meta = code.metadata as Record<string, unknown> | null;
  return {
    id: code.id,
    code: (meta?.code as string) ?? null,
    codeHash: code.code_hash,
    value: toNumber(code.value),
    region: code.region,
    minimumLevel: code.minimum_level,
    minimumWagerAmount: toNumber(code.minimum_wager_amount),
    wagerPeriodDays: code.wager_period_days,
    minimumAccountAgeDays: code.minimum_account_age_days,
    maximumAccountAgeHours: code.maximum_account_age_hours,
    minimumDepositAmount: toNumber(code.minimum_deposit_amount),
    minimumRecentDepositAmount: toNumber(code.minimum_recent_deposit_amount),
    recentDepositPeriodMinutes: code.recent_deposit_period_minutes,
    requiredAffiliateCode: code.required_affiliate_code,
    requiresDiscord: code.requires_discord,
    maxUses: code.max_uses,
    expiresAt: code.expires_at?.toISOString() ?? null,
    metadata: code.metadata,
    createdAt: code.created_at.toISOString(),
    /** Real unbounded redemption count — use this for Remaining / n-of-max. */
    redemptionCount,
  };
}

export type PromoCodeRedemptionRow = {
  id: string;
  userId: string;
  username: string | null;
  email: string | null;
  ipAddress: string;
  redeemedAt: string;
};

export type PromoCodeRedemptionRows = {
  /** Most-recent-first, capped at DETAIL_REDEMPTIONS_LIMIT. */
  rows: PromoCodeRedemptionRow[];
  /** Real unbounded count for this code. */
  totalCount: number;
  /** Whether `rows` was truncated by the cap. */
  truncated: boolean;
};

/**
 * The bounded redemption row-set for the /promo-codes/[id] table. Streamed in
 * a Suspense child so the heavy row read never blocks the detail shell's first
 * paint. Capped at DETAIL_REDEMPTIONS_LIMIT; `totalCount` is the real
 * unbounded figure so the table header can honestly say "showing 100 of N".
 */
export async function getPromoCodeRedemptionRows(
  id: string,
): Promise<PromoCodeRedemptionRows> {
  const [rows, countRows] = await Promise.all([
    queryMainRows<
      {
        id: string;
        user_id: string;
        username: string | null;
        email: string | null;
        ip_address: string;
        redeemed_at: Date;
      }[]
    >(
      `SELECT pcr.id, pcr.user_id, u.username, u.email,
              pcr.ip_address, pcr.redeemed_at
         FROM promo_code_redemptions pcr
         LEFT JOIN "user" u ON u.id = pcr.user_id
        WHERE pcr.promo_code_id = $1::uuid
        ORDER BY pcr.redeemed_at DESC LIMIT $2`,
      id,
      DETAIL_REDEMPTIONS_LIMIT,
    ),
    queryMainRows<{ count: string }[]>(
      `SELECT COUNT(*)::text AS count
         FROM promo_code_redemptions WHERE promo_code_id = $1::uuid`,
      id,
    ),
  ]);
  const totalCount = Number(countRows[0]?.count ?? 0);

  return {
    rows: rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      username: r.username,
      email: r.email,
      ipAddress: r.ip_address,
      redeemedAt: r.redeemed_at.toISOString(),
    })),
    totalCount,
    truncated: totalCount > rows.length,
  };
}

// ─── Per-code claim detail for the click-through dialog ───────────────
//
// Powers the "who claimed this code" popup on /promo-codes. Lazy-loaded
// on dialog-open (NOT fetched for every row up-front) and cached per code
// id (60s) so re-opening the same code is a cache hit. The claims list is
// BOUNDED at CLAIMS_LIMIT so a heavily-redeemed code can't drag a huge
// row-set into the dialog; `totalClaims` is the real unbounded count so
// the header can show "showing 200 of N".
//
// There is NO per-redemption amount column on `promo_code_redemptions`
// (schema: id, promo_code_id, user_id, ip_address, ledger_tx_id,
// redeemed_at). Every redemption of a code credits the SAME `value` that
// lives on the `promo_codes` row, so the credited amount per claim is the
// code's `value` and the total value given is `value * totalClaims`.
// House-POV: that value is house-paid credit → house cost → rendered rose
// at the call site.

const CLAIMS_LIMIT = 200;

export type PromoCodeClaim = {
  id: string;
  userId: string;
  username: string | null;
  email: string | null;
  image: string | null;
  ipAddress: string;
  redeemedAt: string;
};

export type PromoCodeClaimsDetail = {
  id: string;
  code: string | null;
  codeHash: string;
  /** Value credited per claim (USD). Same for every redemption of the code. */
  value: number;
  region: string;
  maxUses: number;
  requiresDiscord: boolean;
  expiresAt: string | null;
  createdAt: string;
  /** Real unbounded redemption count for this code. */
  totalClaims: number;
  /** value * totalClaims — total house credit handed out via this code. */
  totalValueGiven: number;
  /** Whether the claims array was truncated by CLAIMS_LIMIT. */
  truncated: boolean;
  /** Most-recent-first, capped at CLAIMS_LIMIT. */
  claims: PromoCodeClaim[];
};

const cachedPromoCodeClaims = unstable_cache(
  async (id: string): Promise<PromoCodeClaimsDetail | null> => {
    const codeRows = await queryMainRows<PromoCodeDbRow[]>(
      `SELECT * FROM promo_codes WHERE id = $1::uuid LIMIT 1`,
      id,
    );
    const code = codeRows[0];
    if (!code) return null;

    // Real count (unbounded) + the bounded row slice in parallel — one
    // count aggregate, one ordered LIMIT scan, both on the same indexed
    // promo_code_id.
    const [countRows, rows] = await Promise.all([
      queryMainRows<{ count: string }[]>(
        `SELECT COUNT(*)::text AS count
           FROM promo_code_redemptions WHERE promo_code_id = $1::uuid`,
        id,
      ),
      queryMainRows<
        {
          id: string;
          user_id: string;
          ip_address: string;
          redeemed_at: Date;
          username: string | null;
          email: string | null;
          image: string | null;
        }[]
      >(
        `SELECT pcr.id, pcr.user_id, pcr.ip_address, pcr.redeemed_at,
                u.username, u.email, u.image
           FROM promo_code_redemptions pcr
           LEFT JOIN "user" u ON u.id = pcr.user_id
          WHERE pcr.promo_code_id = $1::uuid
          ORDER BY pcr.redeemed_at DESC LIMIT $2`,
        id,
        CLAIMS_LIMIT,
      ),
    ]);
    const totalClaims = Number(countRows[0]?.count ?? 0);

    const meta = code.metadata as Record<string, unknown> | null;
    const value = toNumber(code.value);

    return {
      id: code.id,
      code: (meta?.code as string) ?? null,
      codeHash: code.code_hash,
      value,
      region: code.region,
      maxUses: code.max_uses,
      requiresDiscord: code.requires_discord,
      expiresAt: code.expires_at?.toISOString() ?? null,
      createdAt: code.created_at.toISOString(),
      totalClaims,
      totalValueGiven: value * totalClaims,
      truncated: totalClaims > rows.length,
      claims: rows.map((r) => ({
        id: r.id,
        userId: r.user_id,
        username: r.username,
        email: r.email,
        image: r.image,
        ipAddress: r.ip_address,
        redeemedAt: r.redeemed_at.toISOString(),
      })),
    };
  },
  ["promo-code-claims-v1"],
  { revalidate: 60, tags: ["promo-code-claims"] },
);

/**
 * Lazy-loaded claim detail for a single promo code, used by the
 * click-through dialog on /promo-codes. Cached per id (60s). Returns
 * `null` when the code id doesn't exist.
 */
export async function getPromoCodeClaims(
  id: string,
): Promise<PromoCodeClaimsDetail | null> {
  return cachedPromoCodeClaims(id);
}

// ─── Global KPI stats for the /promo-codes page hero strip ────────────
//
// Counts that describe the WHOLE promo-codes pool independent of the
// filtered list slice on screen. Active = no expiry OR expiry in the
// future (mirrors `status === 'active'` in the list query). Total
// redemptions is the sum of redemption_count across every code (NOT
// the count of promo_code_redemptions rows — same number, faster
// because no JOIN).
//
// One round-trip; cached cross-request (60s).

export type PromoCodesListStats = {
  totalCodes: number;
  activeCount: number;
  expiredCount: number;
  totalRedemptions: number;
};

const cachedPromoCodesListStats = unstable_cache(
  async (): Promise<PromoCodesListStats> => {
    // Total redemptions live on a SEPARATE table — `promo_codes` has
    // no `redemption_count` column (`getPromoCodes` computes per-row
    // counts via `db.promo_code_redemptions.groupBy`). The earlier
    // `SUM(redemption_count)` referenced a non-existent column and
    // crashed every Marketing page that reads off this stats query.
    // Use a sub-select against `promo_code_redemptions` instead — same
    // single-round-trip cost, but actually executes.
    const rows = await queryMainRows<
      {
        total: string;
        active: string;
        expired: string;
        redemptions: string;
      }[]
    >(
      `
      SELECT
        COUNT(*)::text                                                                              AS total,
        COUNT(*) FILTER (WHERE expires_at IS NULL OR expires_at > NOW())::text                       AS active,
        COUNT(*) FILTER (WHERE expires_at IS NOT NULL AND expires_at <= NOW())::text                 AS expired,
        COALESCE((SELECT COUNT(*) FROM promo_code_redemptions), 0)::text                              AS redemptions
      FROM promo_codes
      `,
    );
    const r = rows[0];
    return {
      totalCodes: Number(r?.total ?? 0),
      activeCount: Number(r?.active ?? 0),
      expiredCount: Number(r?.expired ?? 0),
      totalRedemptions: Number(r?.redemptions ?? 0),
    };
  },
  // Bumped to v2 so the broken cached value (if any) is invalidated
  // immediately — the v1 key would still serve the failed-render
  // remnant for up to 60s otherwise.
  ["promo-codes-list-stats-v2"],
  { revalidate: 60, tags: ["promo-codes-list-stats"] },
);

export async function getPromoCodesListStats(): Promise<PromoCodesListStats> {
  return cachedPromoCodesListStats();
}

// ─── Full-dataset "deletable" id sets for the Quick-select buttons ────
//
// /promo-codes is SERVER-side paginated (getPromoCodes does skip/take), so
// the client table only ever holds ONE page. The "Select used-up" /
// "Select expired" toolbar buttons must act on EVERY matching code across
// ALL pages, not just the visible one — so the candidate id sets are
// computed here, server-side, over the whole table, using the SAME
// predicates the client uses per-row in data-table.tsx:
//
//   used-up  : max_uses > 0 AND redemptionCount >= max_uses
//              (redemptionCount = COUNT of promo_code_redemptions rows for
//               the code, exactly how getPromoCodes derives it; max_uses=0
//               means "no cap" → never used-up)
//   expired  : expires_at IS NOT NULL AND expires_at < NOW()
//              (strict `<`, matching the client isExpired())
//
// One round-trip: a single LEFT JOIN onto the per-code redemption counts,
// filtered to rows that are used-up OR expired (the only rows the buttons
// care about), returning two boolean flags so we can split the ids in JS.
// Bounded by MAX_DELETABLE_IDS so a pathological table can't return an
// unbounded id payload to the client; the count is the real total.

export type DeletablePromoCodeIds = {
  /** Ids of every used-up code across all pages. */
  exhaustedIds: string[];
  /** Ids of every expired code across all pages. */
  expiredIds: string[];
};

// Safety bound on the id payload returned to the client. Far above any
// realistic interactive selection, but stops an unbounded scan from
// shipping a giant array. If a real table ever exceeds this, the buttons
// still select (and delete, chunked) up to this many — never silently
// nothing.
const MAX_DELETABLE_IDS = 20_000;

const cachedDeletablePromoCodeIds = unstable_cache(
  async (): Promise<DeletablePromoCodeIds> => {
    const rows = await queryMainRows<
      { id: string; used_up: boolean; expired: boolean }[]
    >(
      `
      SELECT
        pc.id::text                                                    AS id,
        (pc.max_uses > 0 AND COALESCE(r.cnt, 0) >= pc.max_uses)        AS used_up,
        (pc.expires_at IS NOT NULL AND pc.expires_at < NOW())          AS expired
      FROM promo_codes pc
      LEFT JOIN (
        SELECT promo_code_id, COUNT(*)::int AS cnt
        FROM promo_code_redemptions
        GROUP BY promo_code_id
      ) r ON r.promo_code_id = pc.id
      WHERE (pc.max_uses > 0 AND COALESCE(r.cnt, 0) >= pc.max_uses)
         OR (pc.expires_at IS NOT NULL AND pc.expires_at < NOW())
      ORDER BY pc.created_at DESC
      LIMIT $1
      `,
      MAX_DELETABLE_IDS,
    );

    const exhaustedIds: string[] = [];
    const expiredIds: string[] = [];
    for (const row of rows) {
      if (row.used_up) exhaustedIds.push(row.id);
      if (row.expired) expiredIds.push(row.id);
    }
    return { exhaustedIds, expiredIds };
  },
  ["promo-codes-deletable-ids-v1"],
  { revalidate: 60, tags: ["promo-codes-list-stats"] },
);

/**
 * Ids of every used-up and every expired promo code across the WHOLE
 * table (all pages), for the /promo-codes Quick-select buttons. Cached
 * 60s under the same tag as the list stats so a bulk-delete /
 * revalidatePath refresh re-derives both together.
 */
export async function getDeletablePromoCodeIds(): Promise<DeletablePromoCodeIds> {
  return cachedDeletablePromoCodeIds();
}
