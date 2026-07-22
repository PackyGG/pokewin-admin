import "server-only";

import { adminDb } from "@/lib/admin-db";
import { getProdDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";

import { computeAllEntitlements, computeEntitlement } from "./compute";
import {
  isCreatorRewardType,
  type CreatorRewardClaimStatus,
  type CreatorRewardProgramWithStats,
} from "./types";

/**
 * Read layer for the creator VIP reward tab.
 *
 * Cross-DB by necessity and by the book: programs + claims live in the ADMIN
 * DB, while the usernames they reference live in MAIN. There is no join —
 * each side is queried separately and merged in code (CLAUDE.md), and every
 * MAIN read here is a `WHERE id IN (...)` point lookup on the primary key.
 */

/** Resolve MAIN-DB display names for a set of user ids. Never throws. */
async function resolveUsernames(
  userIds: readonly string[],
): Promise<Map<string, string | null>> {
  const unique = [...new Set(userIds)].filter(Boolean);
  if (unique.length === 0) return new Map();
  try {
    const rows = await getProdDb().user.findMany({
      where: { id: { in: unique } },
      select: { id: true, username: true, email: true },
    });
    return new Map(rows.map((r) => [r.id, r.username ?? r.email ?? null]));
  } catch (err) {
    // A name is decoration; a failed lookup must not blank the whole table.
    console.error("[creator-vip] username resolve failed:", err);
    return new Map();
  }
}

export async function getProgramsWithStats(): Promise<
  CreatorRewardProgramWithStats[]
> {
  const programs = await adminDb.creator_reward_programs.findMany({
    orderBy: [{ is_active: "desc" }, { created_at: "desc" }],
  });
  if (programs.length === 0) return [];

  // One grouped pass over claims rather than N per-program queries.
  const grouped = await adminDb.creator_reward_claims.groupBy({
    by: ["program_id", "status"],
    _count: { _all: true },
    _sum: { amount_usd: true },
  });

  const names = await resolveUsernames(programs.map((p) => p.creator_user_id));

  return programs.map((p) => {
    const rows = grouped.filter((g) => g.program_id === p.id);
    const countOf = (s: CreatorRewardClaimStatus) =>
      rows.find((r) => r.status === s)?._count._all ?? 0;
    const approved = rows.find((r) => r.status === "approved");

    return {
      id: p.id,
      name: p.name,
      creatorUserId: p.creator_user_id,
      creatorUsername: names.get(p.creator_user_id) ?? null,
      codes: p.codes,
      type: isCreatorRewardType(p.type) ? p.type : "wager",
      thresholdUsd: p.threshold_usd == null ? null : toNumber(p.threshold_usd),
      rewardUsd: p.reward_usd == null ? null : toNumber(p.reward_usd),
      lossbackPct: p.lossback_pct == null ? null : toNumber(p.lossback_pct),
      minDepositUsd:
        p.min_deposit_usd == null ? null : toNumber(p.min_deposit_usd),
      vipRewardUsd:
        p.vip_reward_usd == null ? null : toNumber(p.vip_reward_usd),
      isActive: p.is_active,
      accrualStartAt: p.accrual_start_at.toISOString(),
      maxRewardPerUserUsd:
        p.max_reward_per_user_usd == null
          ? null
          : toNumber(p.max_reward_per_user_usd),
      createdAt: p.created_at.toISOString(),
      updatedAt: p.updated_at.toISOString(),
      pendingClaims: countOf("pending"),
      approvedClaims: countOf("approved"),
      paidOutUsd: toNumber(approved?._sum.amount_usd ?? 0),
    };
  });
}

export type CreatorRewardClaimRow = {
  id: string;
  programId: string;
  programName: string;
  creatorUserId: string;
  creatorUsername: string | null;
  userId: string;
  username: string | null;
  discordUserId: string | null;
  wagerBasisUsd: number;
  lifetimeWagerUsd: number;
  forfeitedWagerUsd: number;
  priorConsumedUsd: number;
  consumedWagerUsd: number;
  units: number;
  amountUsd: number;
  appliedRewardUsd: number;
  wasVip: boolean;
  status: CreatorRewardClaimStatus;
  requestedAt: string;
  reviewedBy: string | null;
  reviewerName: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  ledgerTxId: string | null;
  /** Set when this claim was rejected and later put back into review. */
  reinstatedAt: string | null;
  /**
   * PENDING rows only: has the player deliberately SWITCHED to a different
   * creator's code since filing?
   *
   * Only a switch counts. An expired code is not one — the attribution simply
   * lapsed and the player did nothing, so it is no reason to flag the claim.
   *
   * Claims are never auto-voided either way: one filed on day 6 and reviewed
   * on day 8 was legitimately earned, and with a 7-day window that gap is
   * routine. The reviewer is TOLD and decides. `null` for already-reviewed
   * rows, and when the lookup failed.
   */
  switchedAway: boolean | null;
};

export async function getClaims(params: {
  status?: CreatorRewardClaimStatus;
  limit?: number;
}): Promise<CreatorRewardClaimRow[]> {
  const limit = Math.max(1, Math.min(params.limit ?? 100, 500));

  const claims = await adminDb.creator_reward_claims.findMany({
    where: params.status ? { status: params.status } : undefined,
    include: { program: true },
    // Pending first when unfiltered, then newest — the review queue is the
    // point of this table, so an old pending row must never sink below a
    // freshly-approved one.
    orderBy: [{ status: "asc" }, { requested_at: "desc" }],
    take: limit,
  });
  if (claims.length === 0) return [];

  const names = await resolveUsernames([
    ...claims.map((c) => c.user_id),
    ...claims.map((c) => c.program.creator_user_id),
  ]);

  // One batched read for every pending claimant's CURRENT code, rather than a
  // per-row probe. Mirrors the eligibility engine: the raw column, with NO
  // expiry test — expiring is not switching.
  const pendingUserIds = [
    ...new Set(
      claims.filter((c) => c.status === "pending").map((c) => c.user_id),
    ),
  ];
  const activeCodeByUser = new Map<string, string | null>();
  if (pendingUserIds.length > 0) {
    try {
      const rows = await getProdDb().user.findMany({
        where: { id: { in: pendingUserIds } },
        select: { id: true, affiliate_code: true },
      });
      for (const r of rows) {
        activeCodeByUser.set(
          r.id,
          r.affiliate_code ? r.affiliate_code.toUpperCase() : null,
        );
      }
    } catch (err) {
      // Leave the map empty → `switchedAway` reports null (unknown) rather
      // than a confident "they left", which is worse than saying nothing.
      console.error("[creator-vip] active-code lookup failed:", err);
    }
  }

  // Reviewer names come from the ADMIN DB (they're admin users, not players).
  const reviewerIds = [
    ...new Set(claims.map((c) => c.reviewed_by).filter(Boolean)),
  ] as string[];
  const reviewers =
    reviewerIds.length > 0
      ? await adminDb.admin_users.findMany({
          where: { id: { in: reviewerIds } },
          select: { id: true, username: true },
        })
      : [];
  const reviewerById = new Map(reviewers.map((r) => [r.id, r.username]));

  return claims.map((c) => ({
    id: c.id,
    programId: c.program_id,
    programName: c.program.name,
    creatorUserId: c.program.creator_user_id,
    creatorUsername: names.get(c.program.creator_user_id) ?? null,
    userId: c.user_id,
    username: names.get(c.user_id) ?? null,
    discordUserId: c.discord_user_id,
    wagerBasisUsd: toNumber(c.wager_basis_usd),
    lifetimeWagerUsd: toNumber(c.lifetime_wager_usd),
    forfeitedWagerUsd: toNumber(c.forfeited_wager_usd),
    priorConsumedUsd: toNumber(c.prior_consumed_usd),
    consumedWagerUsd: toNumber(c.consumed_wager_usd),
    units: c.units,
    amountUsd: toNumber(c.amount_usd),
    appliedRewardUsd: toNumber(c.applied_reward_usd),
    wasVip: c.was_vip,
    status: c.status as CreatorRewardClaimStatus,
    requestedAt: c.requested_at.toISOString(),
    reviewedBy: c.reviewed_by,
    reviewerName: c.reviewed_by
      ? (reviewerById.get(c.reviewed_by) ?? null)
      : null,
    reviewedAt: c.reviewed_at?.toISOString() ?? null,
    reviewNote: c.review_note,
    ledgerTxId: c.ledger_tx_id,
    reinstatedAt: c.reinstated_at?.toISOString() ?? null,
    switchedAway: (() => {
      if (c.status !== "pending" || !activeCodeByUser.has(c.user_id)) {
        return null;
      }
      const now = activeCodeByUser.get(c.user_id) ?? null;
      // No code set is not a switch — only being on a DIFFERENT one is.
      if (!now) return false;
      return !c.program.codes.map((x) => x.toUpperCase()).includes(now);
    })(),
  }));
}

export type PlayerRewardSummary = {
  userId: string;
  username: string | null;
  /** The code currently set on the player, UPPERCASE. Null if they have none. */
  code: string | null;
  /** When the 7-day attribution lapses. Null when no code / no expiry set. */
  codeExpiresAt: string | null;
  /**
   * Seconds until the attribution lapses, floored at 0. Null when unknown.
   * An expired code is NOT a problem for claiming — see `computeEntitlement`
   * — but the player still wants to know, so it's reported either way.
   */
  codeSecondsRemaining: number | null;
  /** True once the window has passed. Wager stops booking until they re-enter. */
  codeExpired: boolean;
  /** Claimable right now, summed across every program they qualify on. */
  openRewardsUsd: number;
  /** Already filed and waiting on staff review. */
  pendingReviewUsd: number;
  /** Approved and paid out, lifetime. */
  totalClaimedUsd: number;
};

/**
 * Everything the bot's `/info` command shows about one player.
 *
 * Deliberately built from the SAME `computeAllEntitlements` the `/check`
 * command uses, so the two commands can never quote different numbers.
 */
export async function getPlayerRewardSummary(
  userId: string,
): Promise<PlayerRewardSummary> {
  const [user, entitlements, claimTotals] = await Promise.all([
    getProdDb().user.findUnique({
      where: { id: userId },
      select: {
        username: true,
        affiliate_code: true,
        affiliate_code_expires_at: true,
      },
    }),
    computeAllEntitlements(userId),
    adminDb.creator_reward_claims.groupBy({
      by: ["status"],
      where: { user_id: userId },
      _sum: { amount_usd: true },
    }),
  ]);

  const expiresAt = user?.affiliate_code_expires_at ?? null;
  const msLeft = expiresAt ? expiresAt.getTime() - Date.now() : null;

  const sumFor = (status: string) =>
    toNumber(
      claimTotals.find((t) => t.status === status)?._sum.amount_usd ?? 0,
    );

  return {
    userId,
    username: user?.username ?? null,
    code: user?.affiliate_code ? user.affiliate_code.toUpperCase() : null,
    codeExpiresAt: expiresAt?.toISOString() ?? null,
    codeSecondsRemaining:
      msLeft === null ? null : Math.max(0, Math.floor(msLeft / 1000)),
    codeExpired: msLeft !== null && msLeft <= 0,
    openRewardsUsd: entitlements.reduce((sum, e) => sum + e.amountUsd, 0),
    pendingReviewUsd: sumFor("pending"),
    totalClaimedUsd: sumFor("approved"),
  };
}

export type CreateClaimResult =
  | { ok: true; claimId: string; amountUsd: number; units: number }
  | { ok: false; error: string; code: string };

/**
 * Create a claim request. THE shared entry point — the Discord-bot endpoint
 * and the admin's "raise a claim" both land here, so eligibility can only ever
 * be decided in one place.
 *
 * Recomputes from scratch every time. The caller supplies WHO and WHICH
 * PROGRAM; it never supplies an amount, and any amount it may have displayed
 * earlier is irrelevant — if the user's position moved in between, the value
 * written here is the one that was true at write time.
 *
 * Concurrency: two simultaneous claims for the same (program, user) both pass
 * the compute step and both try to insert. The partial unique index
 * `creator_reward_claims_one_pending_per_user` makes the loser fail with
 * P2002, which is translated into a friendly "already pending" rather than a
 * 500 — that index, not this function, is what actually guarantees the
 * one-open-claim rule.
 */
export async function createClaimRequest(params: {
  programId: string;
  userId: string;
  discordUserId?: string | null;
}): Promise<CreateClaimResult> {
  const program = await adminDb.creator_reward_programs.findUnique({
    where: { id: params.programId },
  });
  if (!program) {
    return { ok: false, error: "Program not found.", code: "program_not_found" };
  }

  const entitlement = await computeEntitlement(program, params.userId);
  if (entitlement.blockedReason) {
    return {
      ok: false,
      error: entitlement.blockedReason,
      code: "not_eligible",
    };
  }
  if (entitlement.units < 1) {
    return {
      ok: false,
      error:
        entitlement.type === "ftd_lossback"
          ? "Nothing to claim on this reward yet."
          : `Nothing to claim yet — $${entitlement.wagerToNextUnitUsd.toFixed(2)} more wager needed.`,
      code: "nothing_claimable",
    };
  }

  try {
    const created = await adminDb.creator_reward_claims.create({
      data: {
        program_id: program.id,
        user_id: params.userId,
        discord_user_id: params.discordUserId ?? null,
        // FTD lossback has no wager basis; its own snapshot lives in the
        // ftd_* columns. The wager columns stay 0 rather than being reused for
        // a different meaning.
        ftd_deposit_usd: entitlement.ftd?.firstDepositUsd ?? null,
        ftd_loss_usd: entitlement.ftd?.lostUsd ?? null,
        wager_basis_usd: entitlement.qualifyingWagerUsd,
        lifetime_wager_usd: entitlement.lifetimeWagerUsd,
        forfeited_wager_usd: entitlement.forfeitedWagerUsd,
        run_started_at: new Date(entitlement.runStartedAt),
        prior_consumed_usd: entitlement.priorConsumedUsd,
        consumed_wager_usd: entitlement.consumesWagerUsd,
        units: entitlement.units,
        amount_usd: entitlement.amountUsd,
        applied_reward_usd: entitlement.appliedRewardUsd,
        was_vip: entitlement.isVip,
        status: "pending",
      },
      select: { id: true },
    });

    return {
      ok: true,
      claimId: created.id,
      amountUsd: entitlement.amountUsd,
      units: entitlement.units,
    };
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      (err as { code?: string }).code === "P2002"
    ) {
      return {
        ok: false,
        error: "You already have a claim awaiting review on this program.",
        code: "already_pending",
      };
    }
    throw err;
  }
}
