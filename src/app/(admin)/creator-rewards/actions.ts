"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { adminDb } from "@/lib/admin-db";
import { getProdDb } from "@/lib/db";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { requireAdmin, requirePageAccess } from "@/lib/dal";
import { adjustBalance } from "@/app/(admin)/users/[id]/actions";
import { computeProgramOffers } from "@/lib/creator-vip/compute";
import { createClaimRequest } from "@/lib/creator-vip/queries";
import { sanitizeProgramName } from "@/lib/creator-vip/sanitize";
import {
  CREATOR_REWARD_TYPES,
  type CreatorRewardType,
} from "@/lib/creator-vip/types";

/**
 * Creator VIP wager-reward programs + the manual claim-review queue.
 *
 * ── GATES ─────────────────────────────────────────────────────────────────
 * EVERY action here is `requirePageAccess("/creator-rewards")` AND `requireAdmin()`.
 * The admin requirement is not belt-and-braces — it is the control that stops
 * a CREATOR approving payouts against their own program. Creators hold real
 * admin-dashboard sessions (role `creator`, minted by `makeCreator`), so a
 * page-access check alone would let the beneficiary of a program sign off on
 * its own payouts. `requireAdmin()` excludes every non-admin role outright,
 * which is both stricter and simpler than trying to match an admin_user back
 * to a MAIN-DB creator by email.
 *
 * ── WHY APPROVAL GOES THROUGH `adjustBalance` ─────────────────────────────
 * Approving pays real money. Rather than a bespoke write, it calls the
 * existing, audited `adjustBalance` — so a VIP payout automatically gets the
 * optimistic-locking balance transaction, `balance_before`/`balance_after`,
 * the frozen wager requirement, the per-admin balance limit, 2FA, and the
 * admin audit event, exactly like every other adjustment. The only new part
 * is the `creator_vip_reward` category and the claim back-reference it stamps.
 *
 * NOTE: `adjustBalance` gates on `requirePageAccess("/users")`, so an approver
 * needs /users access too. That is deliberate — approving credits a player's
 * balance, and anyone allowed to do that should be allowed to see the player.
 */

const CodesSchema = z
  .array(z.string().trim().min(1).max(32))
  .min(1, "Pick at least one code")
  .max(25);

const ProgramInputSchema = z.object({
  name: z.string().trim().min(2).max(80),
  creatorUserId: z.string().trim().min(1).max(64),
  codes: CodesSchema,
  // A program has no single "type": it runs the WAGER leg, the LOSSBACK leg,
  // or both, and a leg is on exactly when its own fields are filled in. So
  // every terms field is nullable here and the real rules live in
  // `validateTerms`, where an error can name the leg it belongs to instead of
  // producing a bare "required" on a field the operator never opened.
  thresholdUsd: z.number().finite().positive().max(1_000_000).nullable(),
  rewardUsd: z.number().finite().positive().max(100_000).nullable(),
  /** Uplift rate for `vip`-tagged players. null = everyone earns the standard rate. */
  vipRewardUsd: z.number().finite().positive().max(100_000).nullable(),
  // FTD_LOSSBACK only.
  lossbackPct: z.number().finite().positive().max(100).nullable(),
  minDepositUsd: z.number().finite().positive().max(1_000_000).nullable(),
  maxRewardPerUserUsd: z.number().finite().positive().max(1_000_000).nullable(),
});

export type ActionResult<T = undefined> =
  | ({ success: true } & (T extends undefined ? object : { data: T }))
  | { success: false; error: string };

/**
 * Per-LEG terms validation.
 *
 * A program runs the wager leg, the lossback leg, or both, and a leg counts as
 * ON exactly when its own fields are filled in — the same rule `legConfigured`
 * applies at compute time. Validating on leg presence rather than on a
 * program-level "type" is what keeps the two in step: anything this accepts as
 * configured is what the bot will actually offer.
 *
 * A reward that pays out more than it demands is a money pump — the house
 * loses on every unit, forever. Cheap to typo ($5 threshold / $1000 reward),
 * catastrophic to ship, so it is refused outright rather than warned about.
 */
function validateTerms(d: {
  thresholdUsd: number | null;
  rewardUsd: number | null;
  vipRewardUsd: number | null;
  lossbackPct: number | null;
  minDepositUsd: number | null;
}): string | null {
  // "Touched" = the operator opened this leg at all. A leg with SOME of its
  // fields set is a half-filled form, not an off leg, so it must fail loudly
  // instead of being silently dropped and never paying out.
  const wagerTouched =
    d.thresholdUsd != null || d.rewardUsd != null || d.vipRewardUsd != null;
  const lossbackTouched = d.lossbackPct != null || d.minDepositUsd != null;

  if (!wagerTouched && !lossbackTouched) {
    return "Configure at least one leg — wager milestones, FTD lossback, or both.";
  }

  if (wagerTouched) {
    if (d.thresholdUsd == null) return "Wager threshold is required.";
    if (d.rewardUsd == null) return "Reward is required.";
    if (d.rewardUsd >= d.thresholdUsd) {
      return "Reward must be smaller than the wager threshold — otherwise every unit loses money.";
    }
    if (d.vipRewardUsd != null) {
      if (d.vipRewardUsd >= d.thresholdUsd) {
        return "VIP reward must be smaller than the wager threshold — otherwise every unit loses money.";
      }
      // Not a money-pump, but almost certainly a typo: a "VIP" rate paying less
      // than standard would quietly punish the tag it is meant to reward.
      if (d.vipRewardUsd < d.rewardUsd) {
        return "VIP reward must be at least the standard reward.";
      }
    }
  }

  if (lossbackTouched) {
    if (d.lossbackPct == null) return "Lossback percent is required.";
    if (d.minDepositUsd == null) return "Minimum deposit is required.";
    // 100% back is not a reward, it is a refund with extra steps — and above
    // that we would be paying more than the player ever put in.
    if (d.lossbackPct >= 100) {
      return "Lossback percent must be below 100% — otherwise we refund more than they deposited.";
    }
  }

  return null;
}

export async function createCreatorRewardProgram(input: {
  name: string;
  creatorUserId: string;
  codes: string[];
  thresholdUsd: number | null;
  rewardUsd: number | null;
  vipRewardUsd: number | null;
  lossbackPct: number | null;
  minDepositUsd: number | null;
  maxRewardPerUserUsd: number | null;
}): Promise<ActionResult> {
  await requirePageAccess("/creator-rewards");
  const session = await requireAdmin();

  const parsed = ProgramInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }
  const d = parsed.data;

  const rateError = validateTerms(d);
  if (rateError) return { success: false, error: rateError };

  // The name is echoed by the Discord bot, where it is parsed as markdown and
  // mentions — so it is neutralised BEFORE storage, not on the way out. See
  // sanitize.ts for why escaping-on-output would be the wrong fix.
  const name = sanitizeProgramName(d.name);
  if (name.length < 2) {
    return {
      success: false,
      error: "Program name has no usable characters — try plain text.",
    };
  }

  // The creator must be real. Accept a current creator only — a program is a
  // forward-looking commitment, so unlike a leaderboard back-fill there is no
  // reason to allow attaching one to a retired account.
  const creator = await getProdDb().user.findUnique({
    where: { id: d.creatorUserId },
    select: { id: true, role: true },
  });
  if (!creator) return { success: false, error: "Creator not found" };
  if (creator.role !== "creator") {
    return { success: false, error: "That user is not a creator" };
  }

  // Codes are stored UPPERCASE and matched case-insensitively at read time —
  // `affiliate_codes` casing is mixed for legacy rows.
  const codes = [...new Set(d.codes.map((c) => c.trim().toUpperCase()))];

  // Every code must actually belong to this creator, or the program would
  // silently accrue on someone else's traffic.
  const owned = await getProdDb().affiliate_codes.findMany({
    where: { user_id: d.creatorUserId },
    select: { code: true },
  });
  const ownedUpper = new Set(owned.map((c) => c.code.toUpperCase()));
  const foreign = codes.filter((c) => !ownedUpper.has(c));
  if (foreign.length > 0) {
    return {
      success: false,
      error: `Not owned by this creator: ${foreign.join(", ")}`,
    };
  }

  // Accrual starts NOW. Wager booked before this instant never counts — the
  // guard against a new program instantly owing against years of history.
  const accrualStartAt = new Date();

  const created = await adminDb.creator_reward_programs.create({
    data: {
      name,
      creator_user_id: d.creatorUserId,
      codes,
      threshold_usd: d.thresholdUsd,
      reward_usd: d.rewardUsd,
      vip_reward_usd: d.vipRewardUsd,
      lossback_pct: d.lossbackPct,
      min_deposit_usd: d.minDepositUsd,
      max_reward_per_user_usd: d.maxRewardPerUserUsd,
      accrual_start_at: accrualStartAt,
      created_by: session.userId,
    },
    select: { id: true },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "creator_reward_program_created",
    targetUserId: d.creatorUserId,
    metadata: {
      program_id: created.id,
      name,
      codes,
      threshold_usd: d.thresholdUsd,
      reward_usd: d.rewardUsd,
      vip_reward_usd: d.vipRewardUsd,
      lossback_pct: d.lossbackPct,
      min_deposit_usd: d.minDepositUsd,
      max_reward_per_user_usd: d.maxRewardPerUserUsd,
      accrual_start_at: accrualStartAt.toISOString(),
    },
  });

  revalidatePath("/creator-rewards");
  return { success: true };
}

export async function setCreatorRewardProgramActive(input: {
  programId: string;
  isActive: boolean;
}): Promise<ActionResult> {
  await requirePageAccess("/creator-rewards");
  const session = await requireAdmin();

  const parsed = z
    .object({ programId: z.string().uuid(), isActive: z.boolean() })
    .safeParse(input);
  if (!parsed.success) return { success: false, error: "Invalid input" };

  const existing = await adminDb.creator_reward_programs.findUnique({
    where: { id: parsed.data.programId },
    select: { id: true, name: true, is_active: true, creator_user_id: true },
  });
  if (!existing) return { success: false, error: "Program not found" };

  await adminDb.creator_reward_programs.update({
    where: { id: existing.id },
    data: { is_active: parsed.data.isActive },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "creator_reward_program_toggled",
    targetUserId: existing.creator_user_id,
    metadata: {
      program_id: existing.id,
      name: existing.name,
      was_active: existing.is_active,
      is_active: parsed.data.isActive,
    },
  });

  revalidatePath("/creator-rewards");
  return { success: true };
}

/**
 * Approve a pending claim and pay it out.
 *
 * The stored `amount_usd` is what gets paid — NOT a recomputation. That is
 * deliberate: the claim is a frozen artifact of what the user was told they
 * could claim, and it already reserved exactly that much basis when it was
 * created. Recomputing here would let the number drift between what the user
 * saw in Discord and what staff approves. If a claim looks wrong, reject it;
 * the basis is released and the user can raise a fresh one at current values.
 */
export async function approveCreatorRewardClaim(input: {
  claimId: string;
  totpCode: string;
  note?: string;
}): Promise<ActionResult> {
  await requirePageAccess("/creator-rewards");
  const session = await requireAdmin();

  const parsed = z
    .object({
      claimId: z.string().uuid(),
      totpCode: z.string().trim().min(6).max(10),
      note: z.string().trim().max(1000).optional(),
    })
    .safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  const claim = await adminDb.creator_reward_claims.findUnique({
    where: { id: parsed.data.claimId },
    include: { program: true },
  });
  if (!claim) return { success: false, error: "Claim not found" };
  if (claim.status !== "pending") {
    return { success: false, error: `Claim is already ${claim.status}` };
  }

  const amountUsd = Number(claim.amount_usd);
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    return { success: false, error: "Claim has no payable amount" };
  }

  // Pay FIRST, then mark approved. If the credit fails the claim stays
  // pending and can be retried; the reverse order could mark a claim paid
  // that never was. The partial unique index only constrains `pending` rows,
  // so a stuck-pending claim is always recoverable.
  const credit = await adjustBalance({
    userId: claim.user_id,
    amount: amountUsd,
    category: "creator_vip_reward",
    reason: `Creator VIP reward — ${claim.program.name} (${claim.units} × $${Number(claim.program.reward_usd).toFixed(2)})`,
    totpCode: parsed.data.totpCode,
    details: {
      creatorId: claim.program.creator_user_id,
      vipClaimId: claim.id,
      vipProgramId: claim.program_id,
    },
  });

  if (!credit.success) {
    return { success: false, error: credit.error };
  }

  await adminDb.creator_reward_claims.update({
    where: { id: claim.id },
    data: {
      status: "approved",
      reviewed_by: session.userId,
      reviewed_at: new Date(),
      review_note: parsed.data.note ?? null,
      ledger_tx_id: credit.ledgerTxId,
    },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "creator_reward_claim_approved",
    targetUserId: claim.user_id,
    metadata: {
      claim_id: claim.id,
      program_id: claim.program_id,
      program_name: claim.program.name,
      creator_user_id: claim.program.creator_user_id,
      units: claim.units,
      amount_usd: amountUsd,
      consumed_wager_usd: Number(claim.consumed_wager_usd),
      ledger_tx_id: credit.ledgerTxId,
      note: parsed.data.note ?? null,
    },
  });

  revalidatePath("/creator-rewards");
  return { success: true };
}

/**
 * Reject a pending claim. This RELEASES the reserved wager basis with no
 * compensating write — a rejected row simply stops matching the
 * pending+approved filter the consumption sum uses.
 */
export async function rejectCreatorRewardClaim(input: {
  claimId: string;
  note: string;
}): Promise<ActionResult> {
  await requirePageAccess("/creator-rewards");
  const session = await requireAdmin();

  const parsed = z
    .object({
      claimId: z.string().uuid(),
      // Required: a rejection takes money away from someone who was told they
      // had earned it, so the reason is not optional.
      note: z.string().trim().min(3).max(1000),
    })
    .safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "A reason is required",
    };
  }

  const claim = await adminDb.creator_reward_claims.findUnique({
    where: { id: parsed.data.claimId },
    include: { program: true },
  });
  if (!claim) return { success: false, error: "Claim not found" };
  if (claim.status !== "pending") {
    return { success: false, error: `Claim is already ${claim.status}` };
  }

  await adminDb.creator_reward_claims.update({
    where: { id: claim.id },
    data: {
      status: "rejected",
      reviewed_by: session.userId,
      reviewed_at: new Date(),
      review_note: parsed.data.note,
    },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "creator_reward_claim_rejected",
    targetUserId: claim.user_id,
    metadata: {
      claim_id: claim.id,
      program_id: claim.program_id,
      program_name: claim.program.name,
      units: claim.units,
      amount_usd: Number(claim.amount_usd),
      released_wager_usd: Number(claim.consumed_wager_usd),
      note: parsed.data.note,
    },
  });

  revalidatePath("/creator-rewards");
  return { success: true };
}

/**
 * Put a REJECTED claim back into review (rejected → pending).
 *
 * The undo for rejecting the wrong row. Rejection itself already demands a
 * typed reason, so a stray click can't fire it — what this covers is the
 * reviewer who rejected a claim they meant to keep.
 *
 * Only REJECTED claims can be reopened. An approved one never can: money has
 * already moved, and "unapproving" would imply a clawback this action has no
 * business performing silently.
 *
 * Reinstating re-reserves the wager basis (a pending claim holds it again),
 * which is exactly why it can collide: if the player has since filed a fresh
 * claim, the partial unique index refuses a second pending row. That P2002 is
 * translated rather than surfaced as a crash — the reviewer is told to deal
 * with the newer claim instead.
 *
 * The original rejection reason is deliberately KEPT in `review_note`, so
 * whoever picks the claim up second can see why it was turned down first.
 */
export async function reinstateCreatorRewardClaim(input: {
  claimId: string;
  note: string;
}): Promise<ActionResult> {
  await requirePageAccess("/creator-rewards");
  const session = await requireAdmin();

  const parsed = z
    .object({
      claimId: z.string().uuid(),
      // Reopening a decision someone else made is itself a decision worth
      // recording, so a reason is required here too.
      note: z.string().trim().min(3).max(1000),
    })
    .safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "A reason is required",
    };
  }

  const claim = await adminDb.creator_reward_claims.findUnique({
    where: { id: parsed.data.claimId },
    include: { program: true },
  });
  if (!claim) return { success: false, error: "Claim not found" };
  if (claim.status !== "rejected") {
    return {
      success: false,
      error:
        claim.status === "approved"
          ? "Already approved and paid — reopening isn't possible."
          : "That claim is already awaiting review.",
    };
  }

  try {
    await adminDb.creator_reward_claims.update({
      where: { id: claim.id },
      data: {
        status: "pending",
        reinstated_at: new Date(),
        reinstated_by: session.userId,
        // Cleared so the row reads as genuinely awaiting review again; who
        // rejected it, and why, is preserved in review_note + the audit trail.
        reviewed_by: null,
        reviewed_at: null,
      },
    });
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      (err as { code?: string }).code === "P2002"
    ) {
      return {
        success: false,
        error:
          "This player already has a newer claim awaiting review — handle that one instead.",
      };
    }
    throw err;
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "creator_reward_claim_reinstated",
    targetUserId: claim.user_id,
    metadata: {
      claim_id: claim.id,
      program_id: claim.program_id,
      program_name: claim.program.name,
      amount_usd: Number(claim.amount_usd),
      original_rejection_note: claim.review_note,
      originally_rejected_by: claim.reviewed_by,
      reason: parsed.data.note,
    },
  });

  revalidatePath("/creator-rewards");
  return { success: true };
}

/**
 * Raise a claim on a user's behalf — the same path the Discord bot will use
 * once the API lands, so the review queue can be exercised end-to-end before
 * any bot traffic exists. Eligibility is recomputed server-side; the operator
 * chooses only WHO and WHICH PROGRAM, never an amount.
 */
export async function raiseCreatorRewardClaimForUser(input: {
  programId: string;
  leg: CreatorRewardType;
  userId: string;
}): Promise<ActionResult<{ amountUsd: number; units: number }>> {
  await requirePageAccess("/creator-rewards");
  const session = await requireAdmin();

  const parsed = z
    .object({
      programId: z.string().uuid(),
      leg: z.enum(CREATOR_REWARD_TYPES),
      userId: z.string().trim().min(1).max(64),
    })
    .safeParse(input);
  if (!parsed.success) return { success: false, error: "Invalid input" };

  const result = await createClaimRequest({
    programId: parsed.data.programId,
    leg: parsed.data.leg,
    userId: parsed.data.userId,
    discordUserId: null,
  });
  if (!result.ok) return { success: false, error: result.error };

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "creator_reward_claim_raised_by_admin",
    targetUserId: parsed.data.userId,
    metadata: {
      claim_id: result.claimId,
      program_id: parsed.data.programId,
      leg: parsed.data.leg,
      units: result.units,
      amount_usd: result.amountUsd,
    },
  });

  revalidatePath("/creator-rewards");
  return {
    success: true,
    data: { amountUsd: result.amountUsd, units: result.units },
  };
}

/**
 * Look a player up on a program and show what they'd get RIGHT NOW.
 *
 * Read-only — it runs the same `computeEntitlement` the claim path runs, so
 * the preview and the resulting claim can't disagree. Accepts a username,
 * email or raw user id so an operator can paste whatever they have.
 */
export async function previewCreatorRewardEntitlement(input: {
  programId: string;
  query: string;
}): Promise<
  ActionResult<{
    userId: string;
    username: string | null;
    /** Which leg this preview is describing. */
    leg: CreatorRewardType;
    /** Lossback leg only. */
    ftdLostUsd: number | null;
    ftdDepositUsd: number | null;
    isVip: boolean;
    appliedRewardUsd: number;
    qualifyingWagerUsd: number;
    lifetimeWagerUsd: number;
    forfeitedWagerUsd: number;
    runStartedAt: string;
    availableWagerUsd: number;
    priorConsumedUsd: number;
    units: number;
    amountUsd: number;
    wagerToNextUnitUsd: number;
    blockedReason: string | null;
  }>
> {
  await requirePageAccess("/creator-rewards");
  await requireAdmin();

  const parsed = z
    .object({
      programId: z.string().uuid(),
      query: z.string().trim().min(1).max(80),
    })
    .safeParse(input);
  if (!parsed.success) return { success: false, error: "Invalid input" };

  const program = await adminDb.creator_reward_programs.findUnique({
    where: { id: parsed.data.programId },
  });
  if (!program) return { success: false, error: "Program not found" };

  const q = parsed.data.query;
  const user = await getProdDb().user.findFirst({
    where: {
      OR: [
        { id: q },
        { username: { equals: q, mode: "insensitive" } },
        { email: { equals: q, mode: "insensitive" } },
      ],
    },
    select: { id: true, username: true, email: true },
  });
  if (!user) return { success: false, error: "No user matches that" };

  const offers = await computeProgramOffers(program, user.id);
  // The preview shows the leg with something payable; failing that, the
  // first configured one, so the operator still sees WHY nothing is due.
  const e = offers.find((o) => o.units > 0) ?? offers[0];
  if (!e) {
    return { success: false, error: "This program has no rewards configured" };
  }

  return {
    success: true,
    data: {
      userId: user.id,
      username: user.username ?? user.email ?? null,
      leg: e.type,
      ftdLostUsd: e.ftd?.lostUsd ?? null,
      ftdDepositUsd: e.ftd?.firstDepositUsd ?? null,
      isVip: e.isVip,
      appliedRewardUsd: e.appliedRewardUsd,
      qualifyingWagerUsd: e.qualifyingWagerUsd,
      lifetimeWagerUsd: e.lifetimeWagerUsd,
      forfeitedWagerUsd: e.forfeitedWagerUsd,
      runStartedAt: e.runStartedAt,
      availableWagerUsd: e.availableWagerUsd,
      priorConsumedUsd: e.priorConsumedUsd,
      units: e.units,
      amountUsd: e.amountUsd,
      wagerToNextUnitUsd: e.wagerToNextUnitUsd,
      blockedReason: e.blockedReason,
    },
  };
}

/** One row of the create-program dialog's creator picker. */
export type CreatorSearchResult = {
  userId: string;
  username: string | null;
  /** MAIN-DB `user.role` — shown so the operator sees what they're attaching. */
  role: string;
  /** Every affiliate code this user owns, uppercased. May be empty. */
  codes: string[];
};

/**
 * Creator picker for the create-program dialog.
 *
 * Matches a USERNAME / display name / email (prefix), an exact USER ID, or an
 * affiliate CODE (prefix) — one box, three ways in (owner request,
 * 2026-07-23). Typing a code resolves to whoever owns it, which is how an
 * operator who only knows the code finds the account.
 *
 * Only users who can actually carry a program come back: `role = 'creator'`
 * OR anyone who owns at least one affiliate code. Both matter — a code owner
 * is often NOT role creator (prod: PACKYGGG belongs to a plain `user`), and a
 * newly-made creator with no codes yet still has to be selectable. A plain
 * handle match that is neither shows nothing, rather than filling the list
 * with accounts that have no code to attach.
 *
 * Creators sort first, then by username. Read-only against MAIN; measured
 * 1.5 ms (EXPLAIN ANALYZE, prod 2026-07-23) — the union legs are index
 * searches, `affiliate_codes` is ~1k rows. Empty query lists creators so the
 * dialog opens with something to pick.
 */
export async function searchCreatorsWithCodes(
  query: string,
): Promise<CreatorSearchResult[]> {
  await requirePageAccess("/creator-rewards");
  await requireAdmin();

  const q = query.trim();
  const db = getProdDb();

  type Row = {
    id: string;
    username: string | null;
    email: string | null;
    role: string;
    codes: string[];
  };

  // Shared tail: hydrate + order + cap. `codes` is a correlated aggregate so
  // a user with no codes still comes back (empty array, not a dropped row).
  const SELECT_TAIL = `
    SELECT u.id, u.username, u.email, u.role::text AS role,
           COALESCE(
             (SELECT array_agg(UPPER(ac.code) ORDER BY ac.code)
                FROM affiliate_codes ac WHERE ac.user_id = u.id),
             '{}'
           ) AS codes
      FROM matched m
      JOIN "user" u ON u.id = m.id
     WHERE u.role = 'creator'::user_role
        OR EXISTS (SELECT 1 FROM affiliate_codes ac WHERE ac.user_id = u.id)
     ORDER BY (u.role = 'creator'::user_role) DESC, u.username ASC NULLS LAST
     LIMIT 20`;

  let rows: Row[];
  if (!q) {
    rows = await db.$queryRawUnsafe<Row[]>(`
      WITH matched AS (
        SELECT id FROM "user" WHERE role = 'creator'::user_role
      )
      ${SELECT_TAIL}
    `);
  } else {
    // LIKE metacharacters in the typed term are escaped so a pasted `%` / `_`
    // matches literally; both patterns are bound as params, never interpolated.
    const lower = q.toLowerCase().replace(/[\\%_]/g, "\\$&");
    const upper = q.toUpperCase().replace(/[\\%_]/g, "\\$&");
    rows = await db.$queryRawUnsafe<Row[]>(
      `
      WITH matched AS (
        SELECT id FROM "user" WHERE LOWER(username) LIKE $1 ESCAPE '\\'
        UNION
        SELECT id FROM "user" WHERE LOWER(display_username) LIKE $1 ESCAPE '\\'
        UNION
        SELECT id FROM "user" WHERE LOWER(email) LIKE $1 ESCAPE '\\'
        UNION
        SELECT id FROM "user" WHERE id = $2
        UNION
        SELECT user_id AS id FROM affiliate_codes WHERE UPPER(code) LIKE $3 ESCAPE '\\'
      )
      ${SELECT_TAIL}
    `,
      `${lower}%`,
      q,
      `${upper}%`,
    );
  }

  return rows.map((r) => ({
    userId: r.id,
    username: r.username ?? r.email ?? null,
    role: r.role,
    codes: r.codes ?? [],
  }));
}
