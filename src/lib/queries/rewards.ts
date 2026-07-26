import { unstable_cache } from "next/cache";
import { queryMainRows } from "@/lib/drizzle-query";
import { toNumber } from "@/lib/utils/decimal";
import { excludeStaffCreatorsAndBlacklistedSqlFromIds } from "./_blacklist";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { RAKEBACK_CACHE_TAGS } from "./insights-rewards/rakeback/_cache-tags";
import { getInstantRakebackClaimIds } from "./rakeback-instant-ledger";
import {
  accruedRakebackBeforeInstantFee,
  getRakebackInstantClaimConfig,
  instantClaimPayoutPercentByType,
  instantClaimPayoutPercentForType,
} from "./rakeback-instant-claim";
import type { PaginatedResult } from "@/lib/types";

export type RakebackConfigItem = {
  id: string;
  type: string;
  percentage: number;
  expirationDays: number;
  displayName: string;
  enabled: boolean;
};

export type RakebackClaimItem = {
  id: string;
  userId: string;
  username: string | null;
  rakebackType: string;
  periodStart: string;
  wageredAmountUsd: number;
  rakebackAmountUsd: number;
  claimedAt: string | null;
  createdAt: string;
  /**
   * True when this claim used the instant/early-claim flow
   * (`rakeback_claims.last_preclaim_at` is non-null). Drift-safe: false on a
   * DB env that hasn't shipped the early-claim column yet (prod), so the row
   * just reads "Rakeback" there instead of throwing.
   */
  instant: boolean;
  /**
   * Full accrued rakeback before the instant-claim discount. Set only when
   * `instant` is true; `rakebackAmountUsd` is what was actually paid out.
   */
  instantAccruedAmountUsd: number | null;
};

export type RakebackStats = {
  totalClaimed: number;
  totalPending: number;
  claimCount: number;
  byType: {
    type: string;
    totalAmount: number;
    claimCount: number;
  }[];
};

export async function getRakebackConfigs(): Promise<RakebackConfigItem[]> {
  const configs = await queryMainRows<{
    id: string;
    type: string;
    percentage: string;
    expiration_days: number;
    display_name: string;
    enabled: boolean;
  }[]>(
    `SELECT id, type::text AS type, percentage::text AS percentage,
            expiration_days, display_name, enabled
     FROM rakeback_config
     ORDER BY type ASC`,
  );

  return configs.map((r) => ({
    id: r.id,
    type: r.type,
    percentage: toNumber(r.percentage),
    expirationDays: r.expiration_days,
    displayName: r.display_name,
    enabled: r.enabled,
  }));
}

export async function getRakebackClaims(params: {
  page?: number;
  perPage?: number;
  type?: string;
  search?: string;
}): Promise<PaginatedResult<RakebackClaimItem>> {
  const page = Math.max(1, Math.floor(params.page ?? 1));
  const perPage = Math.max(1, Math.min(200, Math.floor(params.perPage ?? 20)));
  const type = params.type && params.type !== "all" ? params.type : null;
  const search = params.search?.trim() || null;
  type ClaimRow = {
    id: string;
    user_id: string;
    username: string | null;
    rakeback_type: string;
    period_start: Date;
    wagered_amount_usd: string;
    rakeback_amount_usd: string;
    claimed_at: Date | null;
    created_at: Date;
  };

  const [claims, total] = await Promise.all([
    queryMainRows<ClaimRow[]>(
      `SELECT rc.id, rc.user_id, u.username,
              rc.rakeback_type::text AS rakeback_type,
              rc.period_start,
              rc.wagered_amount_usd::text AS wagered_amount_usd,
              rc.rakeback_amount_usd::text AS rakeback_amount_usd,
              rc.claimed_at, rc.created_at
       FROM rakeback_claims rc
       LEFT JOIN "user" u ON u.id = rc.user_id
       WHERE ($1::text IS NULL OR rc.rakeback_type::text = $1)
         AND ($2::text IS NULL OR u.username ILIKE '%' || $2 || '%')
       ORDER BY rc.created_at DESC
       LIMIT $3 OFFSET $4`,
      type,
      search,
      perPage,
      (page - 1) * perPage,
    ),
    queryMainRows<{ count: string }[]>(
      `SELECT COUNT(*)::text AS count
       FROM rakeback_claims rc
       LEFT JOIN "user" u ON u.id = rc.user_id
       WHERE ($1::text IS NULL OR rc.rakeback_type::text = $1)
         AND ($2::text IS NULL OR u.username ILIKE '%' || $2 || '%')`,
      type,
      search,
    ).then((rows) => Number(rows[0]?.count ?? 0)),
  ]);

  // Instant-claim enrichment — flag which claims on this page were early-
  // claimed (last_preclaim_at non-null). Drift-safe + best-effort: a failure,
  // or an env without the early-claim column (prod), leaves every row as a
  // plain "Rakeback" claim instead of throwing.
  let instantClaimIds = new Set<string>();
  let payoutByType = new Map<string, number>();
  if (claims.length > 0) {
    try {
      const [ids, instantConfig] = await Promise.all([
        getInstantRakebackClaimIds(claims.map((c) => c.id)),
        getRakebackInstantClaimConfig(),
      ]);
      instantClaimIds = ids;
      payoutByType = instantClaimPayoutPercentByType(instantConfig);
    } catch (e) {
      console.error(
        "[getRakebackClaims] instant-claim lookup failed (non-fatal):",
        e,
      );
    }
  }

  return {
    data: claims.map((c) => {
      const instant = instantClaimIds.has(c.id);
      const rakebackAmountUsd = toNumber(c.rakeback_amount_usd);
      const instantAccruedAmountUsd = instant
        ? accruedRakebackBeforeInstantFee(
            rakebackAmountUsd,
            instantClaimPayoutPercentForType(payoutByType, c.rakeback_type),
          )
        : null;

      return {
        id: c.id,
        userId: c.user_id,
        username: c.username,
        rakebackType: c.rakeback_type,
        periodStart: c.period_start.toISOString(),
        wageredAmountUsd: toNumber(c.wagered_amount_usd),
        rakebackAmountUsd,
        claimedAt: c.claimed_at?.toISOString() ?? null,
        createdAt: c.created_at.toISOString(),
        instant,
        instantAccruedAmountUsd,
      };
    }),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  };
}

export type RewardPack = {
  id: string;
  name: string;
  imageUrl: string | null;
  priceUsd: number;
};

export type RewardItem = {
  id: string;
  slug: string;
  name: string;
  type: string;
  levelRequired: number;
  cashAmount: number | null;
  /** Daily rewards only. Fraction (0.01 = 1%). null = 1% default. */
  dailyUnlockPercentage: number | null;
  packIds: string[];
  packs: RewardPack[];
  packCount: number;
  createdAt: string;
};

type RewardRow = {
  id: string;
  slug: string;
  name: string;
  type: string;
  level_required: number;
  cash_amount: string | null;
  daily_unlock_percentage: string | null;
  pack_ids: string[];
  created_at: Date;
};

async function hydrateRewards(rewards: RewardRow[]): Promise<RewardItem[]> {
  const allPackIds = [...new Set(rewards.flatMap((reward) => reward.pack_ids))];
  const packsMap = new Map<string, RewardPack>();
  if (allPackIds.length > 0) {
    const packs = await queryMainRows<{
      id: string;
      name: string;
      image_url: string | null;
      price: string;
    }[]>(
      `SELECT id, name, image_url, price::text AS price
       FROM packs
       WHERE id = ANY($1::text[])`,
      allPackIds,
    );
    for (const pack of packs) {
      packsMap.set(pack.id, {
        id: pack.id,
        name: pack.name,
        imageUrl: pack.image_url,
        priceUsd: toNumber(pack.price),
      });
    }
  }

  return rewards.map((reward) => ({
    id: reward.id,
    slug: reward.slug,
    name: reward.name,
    type: reward.type,
    levelRequired: reward.level_required,
    cashAmount:
      reward.cash_amount == null ? null : toNumber(reward.cash_amount),
    dailyUnlockPercentage:
      reward.daily_unlock_percentage == null
        ? null
        : toNumber(reward.daily_unlock_percentage),
    packIds: reward.pack_ids,
    packs: reward.pack_ids
      .map((id) => packsMap.get(id))
      .filter((pack): pack is RewardPack => pack != null),
    packCount: reward.pack_ids.length,
    createdAt: reward.created_at.toISOString(),
  }));
}

export async function getRewards(params: {
  page?: number;
  perPage?: number;
  search?: string;
  type?: string;
  minCashAmount?: number;
  maxCashAmount?: number;
}): Promise<PaginatedResult<RewardItem>> {
  const page = Math.max(1, Math.floor(params.page ?? 1));
  const perPage = Math.max(1, Math.min(200, Math.floor(params.perPage ?? 20)));
  const search = params.search?.trim() || null;
  const type = params.type && params.type !== "all" ? params.type : null;

  const [rewards, total] = await Promise.all([
    queryMainRows<RewardRow[]>(
      `SELECT id, slug, name, type::text AS type, level_required,
              cash_amount::text AS cash_amount,
              daily_unlock_percentage::text AS daily_unlock_percentage,
              pack_ids, created_at
       FROM rewards
       WHERE ($1::text IS NULL OR type::text = $1)
         AND ($2::text IS NULL OR name ILIKE '%' || $2 || '%' OR slug ILIKE '%' || $2 || '%')
         AND ($3::numeric IS NULL OR cash_amount >= $3)
         AND ($4::numeric IS NULL OR cash_amount <= $4)
       ORDER BY created_at DESC
       LIMIT $5 OFFSET $6`,
      type,
      search,
      params.minCashAmount ?? null,
      params.maxCashAmount ?? null,
      perPage,
      (page - 1) * perPage,
    ),
    queryMainRows<{ count: string }[]>(
      `SELECT COUNT(*)::text AS count
       FROM rewards
       WHERE ($1::text IS NULL OR type::text = $1)
         AND ($2::text IS NULL OR name ILIKE '%' || $2 || '%' OR slug ILIKE '%' || $2 || '%')
         AND ($3::numeric IS NULL OR cash_amount >= $3)
         AND ($4::numeric IS NULL OR cash_amount <= $4)`,
      type,
      search,
      params.minCashAmount ?? null,
      params.maxCashAmount ?? null,
    ).then((rows) => Number(rows[0]?.count ?? 0)),
  ]);

  return {
    data: await hydrateRewards(rewards),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  };
}

export async function getLevelUpRewards(params: {
  page?: number;
  perPage?: number;
}): Promise<PaginatedResult<RewardItem>> {
  const page = Math.max(1, Math.floor(params.page ?? 1));
  const perPage = Math.max(1, Math.min(200, Math.floor(params.perPage ?? 20)));

  const [rewards, total] = await Promise.all([
    queryMainRows<RewardRow[]>(
      `SELECT id, slug, name, type::text AS type, level_required,
              cash_amount::text AS cash_amount,
              daily_unlock_percentage::text AS daily_unlock_percentage,
              pack_ids, created_at
       FROM rewards
       WHERE level_required > 0
       ORDER BY level_required ASC
       LIMIT $1 OFFSET $2`,
      perPage,
      (page - 1) * perPage,
    ),
    queryMainRows<{ count: string }[]>(
      `SELECT COUNT(*)::text AS count FROM rewards WHERE level_required > 0`,
    ).then((rows) => Number(rows[0]?.count ?? 0)),
  ]);

  return {
    data: await hydrateRewards(rewards),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  };
}

// Lifetime rakeback summary for the /rewards hero strip. Three aggregates
// pushed to Postgres (no per-row JS scan). Cached cross-request (300s) —
// it's a no-timeframe headline aggregate like the promo-codes money stats,
// and /rewards mutations call `revalidatePath("/rewards")` to refresh it.
// The resolved customer scope (staff/creator/blacklist filter) is passed as
// the argument so it participates in the cache key — a blacklist change
// keys a fresh entry rather than serving a stale population.
const cachedRakebackStats = unstable_cache(
  async (excludedIds: string[]): Promise<RakebackStats> => {
    const scope = excludeStaffCreatorsAndBlacklistedSqlFromIds(excludedIds).replace(
      /^user_id/,
      "rc.user_id",
    );
    const byTypeRows = await queryMainRows<{
      rakeback_type: string;
      total_amount: string;
      claimed_amount: string;
      pending_amount: string;
      claim_count: string;
    }[]>(
      `SELECT rc.rakeback_type::text AS rakeback_type,
              COALESCE(SUM(rc.rakeback_amount_usd::numeric), 0)::text AS total_amount,
              COALESCE(SUM(rc.rakeback_amount_usd::numeric)
                FILTER (WHERE rc.claimed_at IS NOT NULL), 0)::text AS claimed_amount,
              COALESCE(SUM(rc.rakeback_amount_usd::numeric)
                FILTER (WHERE rc.claimed_at IS NULL), 0)::text AS pending_amount,
              COUNT(*)::text AS claim_count
       FROM rakeback_claims rc
       WHERE ${scope}
       GROUP BY rc.rakeback_type`,
    );

    return {
      totalClaimed: byTypeRows.reduce(
        (sum, row) => sum + toNumber(row.claimed_amount),
        0,
      ),
      totalPending: byTypeRows.reduce(
        (sum, row) => sum + toNumber(row.pending_amount),
        0,
      ),
      claimCount: byTypeRows.reduce(
        (sum, row) => sum + Number(row.claim_count),
        0,
      ),
      byType: byTypeRows.map((r) => ({
        type: r.rakeback_type,
        totalAmount: toNumber(r.total_amount),
        claimCount: Number(r.claim_count),
      })),
    };
  },
  ["rewards-rakeback-stats-v1"],
  { revalidate: 300, tags: [...RAKEBACK_CACHE_TAGS] },
);

export async function getRakebackStats(): Promise<RakebackStats> {
  const excludedIds = [...(await getExcludedUserIds())].sort();
  return cachedRakebackStats(excludedIds);
}
