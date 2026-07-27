import "server-only";

import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gt,
  inArray,
  isNull,
  sql,
} from "drizzle-orm";
import { adminDrizzle } from "@/lib/drizzle";
import {
  admin_users,
  creator_reward_claims,
  creator_reward_offer_windows,
  creator_reward_programs,
} from "@/lib/db-schema/admin/schema";
import { user as mainUsers } from "@/lib/db-schema/main/schema";
import { getProdReadDrizzleDb } from "@/lib/db";
import { isPostgresError } from "@/lib/postgres-errors";
import { toNumber } from "@/lib/utils/decimal";

import {
  computeAllEntitlements,
  computeEntitlement,
  computeLossbackEntitlement,
} from "./compute";
import {
  isCreatorRewardType,
  type CreatorRewardClaimStatus,
  type CreatorRewardProgramWithStats,
  type CreatorRewardType,
} from "./types";

/**
 * Read layer for the creator VIP reward tab.
 *
 * Cross-DB by necessity and by the book: programs + claims live in the ADMIN
 * DB, while the usernames they reference live in MAIN. There is no join —
 * each side is queried separately and merged in code (CLAUDE.md), and every
 * MAIN read here is a `WHERE id IN (...)` point lookup on the primary key.
 */

/**
 * The MAIN-DB profile behind a claim, as far as a reviewer needs it.
 *
 * More than a name because approving a claim moves money: who is asking, how
 * old the account is, and whether it is already flagged all belong on the row
 * that carries the Approve button. Reading them from the user page afterwards
 * is a step nobody takes under a queue.
 */
type ClaimantProfile = {
  name: string | null;
  image: string | null;
  createdAt: string | null;
  isBanned: boolean;
  isLocked: boolean;
  suspectedAlt: boolean;
  countryCode: string | null;
};

/** Resolve MAIN-DB profiles for a set of user ids. Never throws. */
async function resolveUsers(
  userIds: readonly string[],
): Promise<Map<string, ClaimantProfile>> {
  const unique = [...new Set(userIds)].filter(Boolean);
  if (unique.length === 0) return new Map();
  try {
    // Still one `WHERE id IN (...)` point lookup on the primary key — this
    // widens the projection, not the access path.
    const rows = await getProdReadDrizzleDb()
      .select({
        id: mainUsers.id,
        username: mainUsers.username,
        email: mainUsers.email,
        image: mainUsers.image,
        created_at: mainUsers.created_at,
        is_banned: mainUsers.is_banned,
        is_locked: mainUsers.is_locked,
        is_suspected_alt: mainUsers.is_suspected_alt,
        country_code: mainUsers.country_code,
      })
      .from(mainUsers)
      .where(inArray(mainUsers.id, unique));
    return new Map(
      rows.map((r) => [
        r.id,
        {
          name: r.username ?? r.email ?? null,
          image: r.image,
          createdAt: new Date(r.created_at).toISOString(),
          isBanned: r.is_banned,
          isLocked: r.is_locked,
          suspectedAlt: r.is_suspected_alt,
          countryCode: r.country_code,
        },
      ]),
    );
  } catch (err) {
    // A profile is decoration; a failed lookup must not blank the whole table.
    // Every consumer below falls back to the raw id and to "not flagged" —
    // which is why the flags render as absence-of-badge, never as "clean".
    console.error("[creator-vip] user resolve failed:", err);
    return new Map();
  }
}

export async function getProgramsWithStats(): Promise<
  CreatorRewardProgramWithStats[]
> {
  const programs = await adminDrizzle
    .select()
    .from(creator_reward_programs)
    .orderBy(
      desc(creator_reward_programs.is_active),
      desc(creator_reward_programs.created_at),
    );
  if (programs.length === 0) return [];

  // One grouped pass over claims rather than N per-program queries.
  const grouped = await adminDrizzle
    .select({
      program_id: creator_reward_claims.program_id,
      status: creator_reward_claims.status,
      claimCount: sql<number>`COUNT(*)::int`,
      amount: sql<string>`COALESCE(SUM(${creator_reward_claims.amount_usd}), 0)::text`,
    })
    .from(creator_reward_claims)
    .groupBy(creator_reward_claims.program_id, creator_reward_claims.status);

  const users = await resolveUsers(programs.map((p) => p.creator_user_id));

  return programs.map((p) => {
    const rows = grouped.filter((g) => g.program_id === p.id);
    const countOf = (s: CreatorRewardClaimStatus) =>
      rows.find((r) => r.status === s)?.claimCount ?? 0;
    const approved = rows.find((r) => r.status === "approved");

    return {
      id: p.id,
      name: p.name,
      creatorUserId: p.creator_user_id,
      creatorUsername: users.get(p.creator_user_id)?.name ?? null,
      creatorImage: users.get(p.creator_user_id)?.image ?? null,
      creatorCountryCode: users.get(p.creator_user_id)?.countryCode ?? null,
      // Default false, not null: a failed lookup renders as no badge, and a
      // missing badge must never read as "checked and clean".
      creatorIsBanned: users.get(p.creator_user_id)?.isBanned ?? false,
      codes: p.codes ?? [],
      thresholdUsd: p.threshold_usd == null ? null : toNumber(p.threshold_usd),
      rewardUsd: p.reward_usd == null ? null : toNumber(p.reward_usd),
      lossbackPct: p.lossback_pct == null ? null : toNumber(p.lossback_pct),
      minDepositUsd:
        p.min_deposit_usd == null ? null : toNumber(p.min_deposit_usd),
      vipRewardUsd:
        p.vip_reward_usd == null ? null : toNumber(p.vip_reward_usd),
      isActive: p.is_active,
      accrualStartAt: new Date(p.accrual_start_at).toISOString(),
      maxRewardPerUserUsd:
        p.max_reward_per_user_usd == null
          ? null
          : toNumber(p.max_reward_per_user_usd),
      createdAt: new Date(p.created_at).toISOString(),
      updatedAt: new Date(p.updated_at).toISOString(),
      pendingClaims: countOf("pending"),
      approvedClaims: countOf("approved"),
      paidOutUsd: toNumber(approved?.amount),
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
  /**
   * MAIN-DB profile of the claimant, for the review row.
   *
   * Approving moves money, so the reviewer sees who is asking and whether the
   * account is already flagged without leaving the queue. All of it degrades to
   * null/false if the MAIN lookup fails — the row still renders, just plainer.
   */
  userImage: string | null;
  userCreatedAt: string | null;
  userIsBanned: boolean;
  userIsLocked: boolean;
  userSuspectedAlt: boolean;
  userCountryCode: string | null;
  discordUserId: string | null;
  /** Which leg of the program this claim is for. */
  leg: CreatorRewardType;
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
   * Discord-bot DM state for the decision. `botNotifiedAt` set = delivered;
   * `botNotifyError` set = the last failure, and the row offers a resend.
   * BOTH null on a pending claim, on a dashboard-raised claim with no Discord
   * user, and when the webhook isn't configured — none of which is a fault.
   */
  botNotifiedAt: string | null;
  botNotifyError: string | null;
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

  const claimRows = await adminDrizzle
    .select({
      claim: getTableColumns(creator_reward_claims),
      program: getTableColumns(creator_reward_programs),
    })
    .from(creator_reward_claims)
    .innerJoin(
      creator_reward_programs,
      eq(creator_reward_programs.id, creator_reward_claims.program_id),
    )
    .where(
      params.status
        ? eq(creator_reward_claims.status, params.status)
        : undefined,
    )
    // Pending first when unfiltered, then newest — the review queue is the
    // point of this table, so an old pending row must never sink below a
    // freshly-approved one.
    .orderBy(
      asc(creator_reward_claims.status),
      desc(creator_reward_claims.requested_at),
    )
    .limit(limit);
  const claims = claimRows.map((row) => ({
    ...row.claim,
    program: row.program,
  }));
  if (claims.length === 0) return [];

  const users = await resolveUsers([
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
      const rows = await getProdReadDrizzleDb()
        .select({ id: mainUsers.id, affiliate_code: mainUsers.affiliate_code })
        .from(mainUsers)
        .where(inArray(mainUsers.id, pendingUserIds));
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
      ? await adminDrizzle
          .select({ id: admin_users.id, username: admin_users.username })
          .from(admin_users)
          .where(inArray(admin_users.id, reviewerIds))
      : [];
  const reviewerById = new Map(reviewers.map((r) => [r.id, r.username]));

  return claims.map((c) => ({
    id: c.id,
    programId: c.program_id,
    programName: c.program.name,
    creatorUserId: c.program.creator_user_id,
    creatorUsername: users.get(c.program.creator_user_id)?.name ?? null,
    userId: c.user_id,
    username: users.get(c.user_id)?.name ?? null,
    userImage: users.get(c.user_id)?.image ?? null,
    userCreatedAt: users.get(c.user_id)?.createdAt ?? null,
    // Default false, not null: a failed profile lookup renders as no badge,
    // and a missing badge must never be read as "checked and clean".
    userIsBanned: users.get(c.user_id)?.isBanned ?? false,
    userIsLocked: users.get(c.user_id)?.isLocked ?? false,
    userSuspectedAlt: users.get(c.user_id)?.suspectedAlt ?? false,
    userCountryCode: users.get(c.user_id)?.countryCode ?? null,
    discordUserId: c.discord_user_id,
    leg: isCreatorRewardType(c.leg) ? c.leg : "wager",
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
    requestedAt: new Date(c.requested_at).toISOString(),
    reviewedBy: c.reviewed_by,
    reviewerName: c.reviewed_by
      ? (reviewerById.get(c.reviewed_by) ?? null)
      : null,
    reviewedAt: c.reviewed_at ? new Date(c.reviewed_at).toISOString() : null,
    reviewNote: c.review_note,
    ledgerTxId: c.ledger_tx_id,
    reinstatedAt: c.reinstated_at
      ? new Date(c.reinstated_at).toISOString()
      : null,
    botNotifiedAt: c.bot_notified_at
      ? new Date(c.bot_notified_at).toISOString()
      : null,
    botNotifyError: c.bot_notify_error,
    switchedAway: (() => {
      if (c.status !== "pending" || !activeCodeByUser.has(c.user_id)) {
        return null;
      }
      const now = activeCodeByUser.get(c.user_id) ?? null;
      // No code set is not a switch — only being on a DIFFERENT one is.
      if (!now) return false;
      return !(c.program.codes ?? [])
        .map((x) => x.toUpperCase())
        .includes(now);
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
  // The entitlement sweep is isolated for the same reason as in /check: the
  // player's code, timer and claim totals are useful on their own, and must
  // not disappear because the offers engine tripped.
  const safeEntitlements = computeAllEntitlements(userId).catch((err) => {
    console.error("[creator-vip] summary offers failed:", err);
    return [] as Awaited<ReturnType<typeof computeAllEntitlements>>;
  });

  const [userRows, entitlements, claimTotals] = await Promise.all([
    getProdReadDrizzleDb()
      .select({
        username: mainUsers.username,
        affiliate_code: mainUsers.affiliate_code,
        affiliate_code_expires_at: mainUsers.affiliate_code_expires_at,
      })
      .from(mainUsers)
      .where(eq(mainUsers.id, userId))
      .limit(1),
    safeEntitlements,
    adminDrizzle
      .select({
        status: creator_reward_claims.status,
        amount: sql<string>`COALESCE(SUM(${creator_reward_claims.amount_usd}), 0)::text`,
      })
      .from(creator_reward_claims)
      .where(eq(creator_reward_claims.user_id, userId))
      .groupBy(creator_reward_claims.status),
  ]);
  const user = userRows[0];

  const expiresAt = user?.affiliate_code_expires_at ?? null;
  const msLeft = expiresAt
    ? new Date(expiresAt).getTime() - Date.now()
    : null;

  const sumFor = (status: string) =>
    toNumber(
      claimTotals.find((t) => t.status === status)?.amount ?? 0,
    );

  return {
    userId,
    username: user?.username ?? null,
    code: user?.affiliate_code ? user.affiliate_code.toUpperCase() : null,
    codeExpiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
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
 * SQLSTATE 23505, which is translated into a friendly "already pending" rather than a
 * 500 — that index, not this function, is what actually guarantees the
 * one-open-claim rule.
 */
export async function createClaimRequest(params: {
  programId: string;
  /** Which leg is being claimed. A program can offer both. */
  leg: CreatorRewardType;
  userId: string;
  discordUserId?: string | null;
}): Promise<CreateClaimResult> {
  const programRow = (
    await adminDrizzle
      .select()
      .from(creator_reward_programs)
      .where(eq(creator_reward_programs.id, params.programId))
      .limit(1)
  )[0];
  if (!programRow) {
    return { ok: false, error: "Program not found.", code: "program_not_found" };
  }
  const program = {
    ...programRow,
    codes: programRow.codes ?? [],
    accrual_start_at: new Date(programRow.accrual_start_at),
  };

  const entitlement =
    params.leg === "ftd_lossback"
      ? await computeLossbackEntitlement(program, params.userId)
      : await computeEntitlement(program, params.userId);
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
    const created = await adminDrizzle.transaction(async (tx) => {
      const [claim] = await tx
        .insert(creator_reward_claims)
        .values({
          program_id: program.id,
          leg: params.leg,
          user_id: params.userId,
          discord_user_id: params.discordUserId ?? null,
          // FTD lossback has no wager basis; its own snapshot lives in the
          // ftd_* columns. The wager columns stay 0 rather than being reused for
          // a different meaning.
          ftd_deposit_usd:
            entitlement.ftd?.firstDepositUsd != null
              ? String(entitlement.ftd.firstDepositUsd)
              : null,
          ftd_loss_usd:
            entitlement.ftd?.lostUsd != null
              ? String(entitlement.ftd.lostUsd)
              : null,
          wager_basis_usd: String(entitlement.qualifyingWagerUsd),
          lifetime_wager_usd: String(entitlement.lifetimeWagerUsd),
          forfeited_wager_usd: String(entitlement.forfeitedWagerUsd),
          run_started_at: new Date(entitlement.runStartedAt).toISOString(),
          prior_consumed_usd: String(entitlement.priorConsumedUsd),
          consumed_wager_usd: String(entitlement.consumesWagerUsd),
          units: entitlement.units,
          amount_usd: String(entitlement.amountUsd),
          applied_reward_usd: String(entitlement.appliedRewardUsd),
          was_vip: entitlement.isVip,
          status: "pending",
        })
        .returning({ id: creator_reward_claims.id });

      const now = new Date().toISOString();
      const claimedWindows = await tx
        .select({ id: creator_reward_offer_windows.id })
        .from(creator_reward_offer_windows)
        .where(
          and(
            eq(creator_reward_offer_windows.program_id, program.id),
            eq(creator_reward_offer_windows.user_id, params.userId),
            eq(creator_reward_offer_windows.leg, params.leg),
            isNull(creator_reward_offer_windows.claimed_at),
            gt(creator_reward_offer_windows.expires_at, now),
          ),
        )
        .orderBy(asc(creator_reward_offer_windows.expires_at))
        .limit(entitlement.units);
      if (claimedWindows.length > 0) {
        await tx
          .update(creator_reward_offer_windows)
          .set({ claimed_at: now })
          .where(
            inArray(
              creator_reward_offer_windows.id,
              claimedWindows.map((window) => window.id),
            ),
          );
      }
      return claim;
    });

    return {
      ok: true,
      claimId: created.id,
      amountUsd: entitlement.amountUsd,
      units: entitlement.units,
    };
  } catch (err) {
    if (isPostgresError(err, "23505")) {
      return {
        ok: false,
        error: "You already have a claim awaiting review for this reward.",
        code: "already_pending",
      };
    }
    throw err;
  }
}
