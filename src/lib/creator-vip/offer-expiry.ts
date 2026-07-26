import "server-only";

import { and, eq, gt, isNotNull, isNull, lte, sql } from "drizzle-orm";

import { creator_reward_offer_windows } from "@/lib/db-schema/admin/schema";
import { adminDrizzle } from "@/lib/drizzle";
import { toNumber } from "@/lib/utils/decimal";

import type { CreatorRewardEntitlement } from "./types";

const OFFER_LIFETIME_MS = 5 * 24 * 60 * 60 * 1000;

export async function expiredWagerBasisUsd(
  programId: string,
  userId: string,
  runStartedAt: Date,
): Promise<number> {
  const rows = await adminDrizzle
    .select({
      value: sql<string>`COALESCE(SUM(${creator_reward_offer_windows.basis_usd}), 0)::text`,
    })
    .from(creator_reward_offer_windows)
    .where(
      and(
        eq(creator_reward_offer_windows.program_id, programId),
        eq(creator_reward_offer_windows.user_id, userId),
        eq(creator_reward_offer_windows.leg, "wager"),
        eq(
          creator_reward_offer_windows.run_started_at,
          runStartedAt.toISOString(),
        ),
        isNull(creator_reward_offer_windows.claimed_at),
        lte(creator_reward_offer_windows.expires_at, new Date().toISOString()),
      ),
    );
  return toNumber(rows[0]?.value);
}

export async function enforceOfferExpiry(
  entitlement: CreatorRewardEntitlement,
  userId: string,
): Promise<CreatorRewardEntitlement> {
  if (entitlement.blockedReason || entitlement.units < 1) return entitlement;

  const now = new Date();
  const runStartedAt =
    entitlement.type === "ftd_lossback"
      ? (entitlement.ftd?.firstDepositAt ?? entitlement.runStartedAt)
      : entitlement.runStartedAt;
  const unitBasis =
    entitlement.type === "wager" && entitlement.units > 0
      ? entitlement.consumesWagerUsd / entitlement.units
      : 0;

  const rows = Array.from({ length: entitlement.units }, (_, index) => ({
    program_id: entitlement.programId,
    user_id: userId,
    leg: entitlement.type,
    run_started_at: runStartedAt,
    basis_position_usd: String(
      entitlement.type === "wager"
        ? entitlement.priorConsumedUsd + index * unitBasis
        : 0,
    ),
    basis_usd: String(unitBasis),
    claimable_at: now.toISOString(),
    expires_at: new Date(now.getTime() + OFFER_LIFETIME_MS).toISOString(),
  }));

  await adminDrizzle
    .insert(creator_reward_offer_windows)
    .values(rows)
    .onConflictDoUpdate({
      target: [
        creator_reward_offer_windows.program_id,
        creator_reward_offer_windows.user_id,
        creator_reward_offer_windows.leg,
        creator_reward_offer_windows.run_started_at,
        creator_reward_offer_windows.basis_position_usd,
      ],
      set: {
        claimable_at: now.toISOString(),
        expires_at: new Date(now.getTime() + OFFER_LIFETIME_MS).toISOString(),
        claimed_at: null,
      },
      setWhere: isNotNull(creator_reward_offer_windows.claimed_at),
    });

  const active = await adminDrizzle
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(creator_reward_offer_windows)
    .where(
      and(
        eq(creator_reward_offer_windows.program_id, entitlement.programId),
        eq(creator_reward_offer_windows.user_id, userId),
        eq(creator_reward_offer_windows.leg, entitlement.type),
        eq(creator_reward_offer_windows.run_started_at, runStartedAt),
        isNull(creator_reward_offer_windows.claimed_at),
        gt(creator_reward_offer_windows.expires_at, now.toISOString()),
      ),
    );

  if ((active[0]?.count ?? 0) > 0) return entitlement;
  return {
    ...entitlement,
    units: 0,
    amountUsd: 0,
    consumesWagerUsd: 0,
    blockedReason: "This reward offer expired.",
  };
}
