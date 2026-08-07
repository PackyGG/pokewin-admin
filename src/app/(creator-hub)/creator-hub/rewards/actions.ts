"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { z } from "zod";
import {
  and,
  eq,
  getTableColumns,
  ilike,
  isNotNull,
  isNull,
  or,
  sql,
} from "drizzle-orm";

import { adminDrizzle } from "@/lib/drizzle";
import {
  creator_reward_claims,
  creator_reward_offer_windows,
  creator_reward_program_windows,
  creator_reward_programs,
} from "@/lib/db-schema/admin/schema";
import { affiliate_codes, user } from "@/lib/db-schema/main/schema";
import { getPrimaryDrizzleDb, getProdReadDrizzleDb } from "@/lib/db";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { isPostgresError } from "@/lib/postgres-errors";
import { requireAdmin, requirePageAccess } from "@/lib/dal";
import { PASSKEY_GRACE_CREDENTIAL } from "@/lib/passkey-grace-shared";
import { adjustBalance } from "@/app/(admin)/users/[id]/actions";
import { computeProgramOffers } from "@/lib/creator-vip/compute";
import { createClaimRequest } from "@/lib/creator-vip/queries";
import { sanitizeProgramName } from "@/lib/creator-vip/sanitize";
import {
  claimEventId,
  botWebhookConfigStatus,
  isBotWebhookConfigured,
  sendClaimDecision,
  testBotWebhook,
  type ClaimDecisionEvent,
} from "@/lib/creator-vip/bot-webhook";
import { enqueueCreatorRewardClaimNotification } from "@/lib/discord-creator-reward-claims";
import {
  CREATOR_REWARD_TYPES,
  type CreatorRewardType,
} from "@/lib/creator-vip/types";

function normalizeProgram(row: typeof creator_reward_programs.$inferSelect) {
  return {
    ...row,
    codes: row.codes ?? [],
    accrual_start_at: new Date(row.accrual_start_at),
    ends_at: row.ends_at ? new Date(row.ends_at) : null,
  };
}

async function getClaimWithProgram(id: string) {
  const row = (
    await adminDrizzle
      .select({
        claim: getTableColumns(creator_reward_claims),
        program: getTableColumns(creator_reward_programs),
      })
      .from(creator_reward_claims)
      .innerJoin(
        creator_reward_programs,
        eq(creator_reward_programs.id, creator_reward_claims.program_id),
      )
      .where(eq(creator_reward_claims.id, id))
      .limit(1)
  )[0];
  return row ? { ...row.claim, program: normalizeProgram(row.program) } : null;
}

async function findCreatorRewardLedgerId(
  claimId: string,
): Promise<string | null> {
  const db = await getPrimaryDrizzleDb();
  const row = (
    await db.execute<{ id: string }>(sql`
      SELECT id
      FROM ledger_transactions
      WHERE type::text = 'admin_balance_adjustment'
        AND status::text = 'completed'
        AND metadata->>'vip_claim_id' = ${claimId}
      ORDER BY created_at DESC
      LIMIT 1
    `)
  ).rows[0];
  return row?.id ?? null;
}

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

/**
 * Creator Rewards now lives only in Creator Hub. Every mutation refreshes that
 * route so the Marketing surface always reflects the saved state.
 */
function revalidateCreatorRewards(): void {
  revalidatePath("/creator-hub/rewards");
}

const CodesSchema = z
  .array(z.string().trim().min(1).max(32))
  .min(1, "Pick at least one code")
  .max(25);

/**
 * Money fields land in `numeric(20,2)`, so anything finer than a cent is
 * rounded AT STORAGE — after `validateTerms` has already passed judgement on
 * the unrounded number. That gap is a money pump the validator exists to
 * prevent: `threshold 10.004 / reward 10.001` clears "reward must be smaller
 * than threshold" and then stores as `10.00 / 10.00`, paying out exactly what
 * it takes in, forever. Refusing sub-cent input closes it at the boundary
 * rather than trying to re-validate post-rounding.
 */
const UsdSchema = (max: number) =>
  z
    .number()
    .finite()
    .positive()
    .max(max)
    .refine(
      (v) =>
        Number.isInteger(Math.round(v * 100)) &&
        Math.abs(v * 100 - Math.round(v * 100)) < 1e-9,
      {
        message: "Amounts can't be finer than one cent.",
      },
    );

const ProgramInputSchema = z.object({
  name: z.string().trim().min(2).max(80),
  creatorUserId: z.string().trim().min(1).max(64),
  codes: CodesSchema,
  // A program has no single "type": it runs the WAGER leg, the LOSSBACK leg,
  // or both, and a leg is on exactly when its own fields are filled in. So
  // every terms field is nullable here and the real rules live in
  // `validateTerms`, where an error can name the leg it belongs to instead of
  // producing a bare "required" on a field the operator never opened.
  thresholdUsd: UsdSchema(1_000_000).nullable(),
  rewardUsd: UsdSchema(100_000).nullable(),
  /** Uplift rate for `vip`-tagged players. null = everyone earns the standard rate. */
  vipRewardUsd: UsdSchema(100_000).nullable(),
  // FTD_LOSSBACK only. The percent stores as numeric(6,2), so it takes the same
  // two-decimal treatment as the dollar fields.
  lossbackPct: UsdSchema(100).nullable(),
  minDepositUsd: UsdSchema(1_000_000).nullable(),
  maxRewardPerUserUsd: UsdSchema(1_000_000).nullable(),
  endsAt: z.string().datetime().nullable(),
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
  endsAt: string | null;
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
  const mainDb = getProdReadDrizzleDb();
  const [creator] = await mainDb
    .select({ id: user.id, role: user.role })
    .from(user)
    .where(eq(user.id, d.creatorUserId))
    .limit(1);
  if (!creator) return { success: false, error: "Creator not found" };
  if (creator.role !== "creator") {
    return { success: false, error: "That user is not a creator" };
  }

  // Codes are stored UPPERCASE and matched case-insensitively at read time —
  // `affiliate_codes` casing is mixed for legacy rows.
  const codes = [...new Set(d.codes.map((c) => c.trim().toUpperCase()))];

  // Every code must actually belong to this creator, or the program would
  // silently accrue on someone else's traffic.
  const owned = await mainDb
    .select({ code: affiliate_codes.code })
    .from(affiliate_codes)
    .where(eq(affiliate_codes.user_id, d.creatorUserId));
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
  const endsAt = d.endsAt ? new Date(d.endsAt) : null;
  if (endsAt && endsAt <= accrualStartAt) {
    return { success: false, error: "End date must be in the future." };
  }

  const created = await adminDrizzle.transaction(async (tx) => {
    const [program] = await tx
      .insert(creator_reward_programs)
      .values({
        // Opens the first live window. Wager only counts inside these, so a
        // program with none would accrue nothing — it is created atomically
        // with the program rather than as a follow-up write.
        name,
        creator_user_id: d.creatorUserId,
        codes,
        threshold_usd: d.thresholdUsd != null ? String(d.thresholdUsd) : null,
        reward_usd: d.rewardUsd != null ? String(d.rewardUsd) : null,
        vip_reward_usd: d.vipRewardUsd != null ? String(d.vipRewardUsd) : null,
        lossback_pct: d.lossbackPct != null ? String(d.lossbackPct) : null,
        min_deposit_usd:
          d.minDepositUsd != null ? String(d.minDepositUsd) : null,
        max_reward_per_user_usd:
          d.maxRewardPerUserUsd != null ? String(d.maxRewardPerUserUsd) : null,
        accrual_start_at: accrualStartAt.toISOString(),
        ends_at: endsAt?.toISOString() ?? null,
        created_by: session.userId,
      })
      .returning({ id: creator_reward_programs.id });
    await tx.insert(creator_reward_program_windows).values({
      program_id: program.id,
      started_at: accrualStartAt.toISOString(),
    });
    return program;
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
      ends_at: endsAt?.toISOString() ?? null,
    },
  });

  revalidateCreatorRewards();
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

  const existing = (
    await adminDrizzle
      .select({
        id: creator_reward_programs.id,
        name: creator_reward_programs.name,
        is_active: creator_reward_programs.is_active,
        creator_user_id: creator_reward_programs.creator_user_id,
        ends_at: creator_reward_programs.ends_at,
      })
      .from(creator_reward_programs)
      .where(eq(creator_reward_programs.id, parsed.data.programId))
      .limit(1)
  )[0];
  if (!existing) return { success: false, error: "Program not found" };
  const now = new Date();
  if (
    parsed.data.isActive &&
    existing.ends_at &&
    new Date(existing.ends_at).getTime() <= now.getTime()
  ) {
    return {
      success: false,
      error:
        "This program has ended. Extend its end date before activating it.",
    };
  }

  // Pausing CLOSES the open window; resuming OPENS a new one. Wager placed in
  // between therefore never counts, while progress earned before the pause
  // survives it — which is why this models intervals instead of moving the
  // program's start date forward.
  await adminDrizzle.transaction(async (tx) => {
    await tx
      .update(creator_reward_programs)
      // `updated_at` has to be written explicitly — the column's default only
      // applies on INSERT and there is no trigger, so before this it always
      // equalled `created_at` and the field was effectively dead.
      .set({ is_active: parsed.data.isActive, updated_at: now.toISOString() })
      .where(eq(creator_reward_programs.id, existing.id));

    if (parsed.data.isActive) {
      // Guard against double-open: only start a window if none is running.
      const open = (
        await tx
          .select({ id: creator_reward_program_windows.id })
          .from(creator_reward_program_windows)
          .where(
            and(
              eq(creator_reward_program_windows.program_id, existing.id),
              isNull(creator_reward_program_windows.ended_at),
            ),
          )
          .limit(1)
      )[0];
      if (!open) {
        await tx.insert(creator_reward_program_windows).values({
          program_id: existing.id,
          started_at: now.toISOString(),
        });
      }
    } else {
      await tx
        .update(creator_reward_program_windows)
        .set({ ended_at: now.toISOString() })
        .where(
          and(
            eq(creator_reward_program_windows.program_id, existing.id),
            isNull(creator_reward_program_windows.ended_at),
          ),
        );
    }
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
      // Which live-window edge this toggle produced, so the accrual gap is
      // reconstructable from the audit trail alone.
      window: parsed.data.isActive ? "opened" : "closed",
      at: now.toISOString(),
    },
  });

  revalidateCreatorRewards();
  return { success: true };
}

/* ───────────────────── Program edit / archive / delete ───────────────────── */

/**
 * Uppercase, dedupe, and prove every code belongs to this creator.
 *
 * Shared by create and edit because the failure it prevents is the same in
 * both: a program accruing on someone else's traffic. On edit it matters more,
 * not less — an operator adding a code to a live program is doing it against a
 * creator they picked weeks ago, with no picker in front of them.
 */
async function normalizeAndVerifyCodes(
  creatorUserId: string,
  codes: string[],
): Promise<{ ok: true; codes: string[] } | { ok: false; error: string }> {
  const upper = [...new Set(codes.map((c) => c.trim().toUpperCase()))];
  const owned = await getProdReadDrizzleDb()
    .select({ code: affiliate_codes.code })
    .from(affiliate_codes)
    .where(eq(affiliate_codes.user_id, creatorUserId));
  const ownedUpper = new Set(owned.map((c) => c.code.toUpperCase()));
  const foreign = upper.filter((c) => !ownedUpper.has(c));
  if (foreign.length > 0) {
    return {
      ok: false,
      error: `Not owned by this creator: ${foreign.join(", ")}`,
    };
  }
  return { ok: true, codes: upper };
}

/**
 * Edit a program's terms in place.
 *
 * ── WHAT IS DELIBERATELY NOT EDITABLE ─────────────────────────────────────
 * `creatorUserId` and `accrualStartAt`. Both are the program's identity as an
 * accrual instrument, not settings: re-pointing a program at another creator
 * would silently re-attribute every claim already paid under it, and moving the
 * start date would either invent or erase wager history. Wanting either means
 * wanting a different program — archive this one and create that one.
 *
 * ── WHAT AN EDIT DOES AND DOESN'T TOUCH ───────────────────────────────────
 * Terms are read live by `computeProgramOffers`, so new rates apply to the very
 * next offer. Claims already raised are frozen artifacts — `amount_usd` was
 * stamped when the player was told what they'd get, and approval pays the
 * stored number (see `approveCreatorRewardClaim`). So an edit never changes
 * what a pending claim pays out, which is the correct behaviour: the player was
 * quoted that figure. Staff who want the new terms applied reject the claim,
 * which releases its basis, and the player re-claims at the new rate.
 *
 * Turning a leg OFF stops it producing new offers; it does not withdraw the
 * pending claims it already produced. The dialog says so before submitting.
 */
export async function updateCreatorRewardProgram(input: {
  programId: string;
  name: string;
  codes: string[];
  thresholdUsd: number | null;
  rewardUsd: number | null;
  vipRewardUsd: number | null;
  lossbackPct: number | null;
  minDepositUsd: number | null;
  maxRewardPerUserUsd: number | null;
  endsAt: string | null;
}): Promise<ActionResult> {
  await requirePageAccess("/creator-rewards");
  const session = await requireAdmin();

  const parsed = ProgramInputSchema.omit({ creatorUserId: true })
    .extend({ programId: z.string().uuid() })
    .safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }
  const d = parsed.data;

  const rateError = validateTerms(d);
  if (rateError) return { success: false, error: rateError };

  const name = sanitizeProgramName(d.name);
  if (name.length < 2) {
    return {
      success: false,
      error: "Program name has no usable characters — try plain text.",
    };
  }

  const existing = (
    await adminDrizzle
      .select({
        id: creator_reward_programs.id,
        name: creator_reward_programs.name,
        creator_user_id: creator_reward_programs.creator_user_id,
        codes: creator_reward_programs.codes,
        threshold_usd: creator_reward_programs.threshold_usd,
        reward_usd: creator_reward_programs.reward_usd,
        vip_reward_usd: creator_reward_programs.vip_reward_usd,
        lossback_pct: creator_reward_programs.lossback_pct,
        min_deposit_usd: creator_reward_programs.min_deposit_usd,
        max_reward_per_user_usd:
          creator_reward_programs.max_reward_per_user_usd,
        accrual_start_at: creator_reward_programs.accrual_start_at,
        ends_at: creator_reward_programs.ends_at,
        archived_at: creator_reward_programs.archived_at,
      })
      .from(creator_reward_programs)
      .where(eq(creator_reward_programs.id, d.programId))
      .limit(1)
  )[0];
  if (!existing) return { success: false, error: "Program not found" };
  if (existing.archived_at) {
    return {
      success: false,
      error: "This program is archived — restore it before editing.",
    };
  }
  const endsAt = d.endsAt ? new Date(d.endsAt) : null;
  if (endsAt && endsAt <= new Date(existing.accrual_start_at)) {
    return {
      success: false,
      error: "End date must be after the program was created.",
    };
  }

  const codesResult = await normalizeAndVerifyCodes(
    existing.creator_user_id,
    d.codes,
  );
  if (!codesResult.ok) return { success: false, error: codesResult.error };

  await adminDrizzle
    .update(creator_reward_programs)
    .set({
      name,
      codes: codesResult.codes,
      threshold_usd: d.thresholdUsd != null ? String(d.thresholdUsd) : null,
      reward_usd: d.rewardUsd != null ? String(d.rewardUsd) : null,
      vip_reward_usd: d.vipRewardUsd != null ? String(d.vipRewardUsd) : null,
      lossback_pct: d.lossbackPct != null ? String(d.lossbackPct) : null,
      min_deposit_usd: d.minDepositUsd != null ? String(d.minDepositUsd) : null,
      max_reward_per_user_usd:
        d.maxRewardPerUserUsd != null ? String(d.maxRewardPerUserUsd) : null,
      ends_at: endsAt?.toISOString() ?? null,
      updated_at: new Date().toISOString(),
    })
    .where(eq(creator_reward_programs.id, existing.id));

  // Before/after in one event: an operator asking "why did this program start
  // paying double?" gets the answer from the audit row without diffing two.
  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "creator_reward_program_updated",
    targetUserId: existing.creator_user_id,
    metadata: {
      program_id: existing.id,
      before: {
        name: existing.name,
        codes: existing.codes ?? [],
        threshold_usd: existing.threshold_usd,
        reward_usd: existing.reward_usd,
        vip_reward_usd: existing.vip_reward_usd,
        lossback_pct: existing.lossback_pct,
        min_deposit_usd: existing.min_deposit_usd,
        max_reward_per_user_usd: existing.max_reward_per_user_usd,
        ends_at: existing.ends_at,
      },
      after: {
        name,
        codes: codesResult.codes,
        threshold_usd: d.thresholdUsd,
        reward_usd: d.rewardUsd,
        vip_reward_usd: d.vipRewardUsd,
        lossback_pct: d.lossbackPct,
        min_deposit_usd: d.minDepositUsd,
        max_reward_per_user_usd: d.maxRewardPerUserUsd,
        ends_at: endsAt?.toISOString() ?? null,
      },
    },
  });

  revalidateCreatorRewards();
  return { success: true };
}

/** What removing a given program would actually do — drives the confirm dialog. */
export type ProgramRemovalPlan = {
  programId: string;
  name: string;
  /** `delete` when nothing references it, otherwise `archive`. */
  mode: "delete" | "archive";
  totalClaims: number;
  pendingClaims: number;
  approvedClaims: number;
  paidOutUsd: number;
  /** Open offers that would be dropped — bot messages already sent out. */
  openOffers: number;
};

/**
 * Tell the operator what removal will do BEFORE they confirm it.
 *
 * The mode is decided by data, not by the UI: `creator_reward_claims` has an
 * ON DELETE RESTRICT back to programs, so a program that ever produced a claim
 * cannot be hard-deleted without destroying paid-out history. Rather than let
 * the delete fail with a foreign-key error, the plan reports `archive` and the
 * dialog changes what it offers.
 */
export async function planCreatorRewardProgramRemoval(input: {
  programId: string;
}): Promise<ActionResult<ProgramRemovalPlan>> {
  await requirePageAccess("/creator-rewards");
  await requireAdmin();

  const parsed = z.object({ programId: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { success: false, error: "Invalid input" };

  const program = (
    await adminDrizzle
      .select({
        id: creator_reward_programs.id,
        name: creator_reward_programs.name,
      })
      .from(creator_reward_programs)
      .where(eq(creator_reward_programs.id, parsed.data.programId))
      .limit(1)
  )[0];
  if (!program) return { success: false, error: "Program not found" };

  const [claimStats] = await adminDrizzle
    .select({
      total: sql<number>`count(*)::int`,
      pending: sql<number>`count(*) FILTER (WHERE ${creator_reward_claims.status} = 'pending')::int`,
      approved: sql<number>`count(*) FILTER (WHERE ${creator_reward_claims.status} = 'approved')::int`,
      paidOut: sql<string>`coalesce(sum(${creator_reward_claims.amount_usd}) FILTER (WHERE ${creator_reward_claims.status} = 'approved'), 0)`,
    })
    .from(creator_reward_claims)
    .where(eq(creator_reward_claims.program_id, program.id));

  const [offerStats] = await adminDrizzle
    .select({ open: sql<number>`count(*)::int` })
    .from(creator_reward_offer_windows)
    .where(
      and(
        eq(creator_reward_offer_windows.program_id, program.id),
        isNull(creator_reward_offer_windows.claimed_at),
      ),
    );

  const totalClaims = claimStats?.total ?? 0;
  return {
    success: true,
    data: {
      programId: program.id,
      name: program.name,
      mode: totalClaims === 0 ? "delete" : "archive",
      totalClaims,
      pendingClaims: claimStats?.pending ?? 0,
      approvedClaims: claimStats?.approved ?? 0,
      paidOutUsd: Number(claimStats?.paidOut ?? 0),
      openOffers: offerStats?.open ?? 0,
    },
  };
}

/**
 * Remove a program — hard delete when it is disposable, archive when it isn't.
 *
 * The caller states which one it expects (`expectedMode`, straight from the
 * plan the operator was shown). If the data moved in between — a claim landed
 * between opening the dialog and confirming it — the mismatch is refused rather
 * than silently upgraded to the other action. Deleting a program the operator
 * believed was empty, right after it took its first claim, is exactly the
 * mistake worth one extra round-trip.
 *
 * A pending claim blocks BOTH paths. Archiving one out from under a player who
 * is waiting on review would leave the claim in the queue attached to a retired
 * program; decide the queue first.
 */
export async function removeCreatorRewardProgram(input: {
  programId: string;
  expectedMode: "delete" | "archive";
}): Promise<ActionResult<{ mode: "delete" | "archive" }>> {
  await requirePageAccess("/creator-rewards");
  const session = await requireAdmin();

  const parsed = z
    .object({
      programId: z.string().uuid(),
      expectedMode: z.enum(["delete", "archive"]),
    })
    .safeParse(input);
  if (!parsed.success) return { success: false, error: "Invalid input" };

  const plan = await planCreatorRewardProgramRemoval({
    programId: parsed.data.programId,
  });
  if (!plan.success) return plan;

  if (plan.data.pendingClaims > 0) {
    return {
      success: false,
      error: `${plan.data.pendingClaims} claim${plan.data.pendingClaims === 1 ? " is" : "s are"} still pending review — approve or reject ${plan.data.pendingClaims === 1 ? "it" : "them"} first.`,
    };
  }

  if (plan.data.mode !== parsed.data.expectedMode) {
    return {
      success: false,
      error:
        plan.data.mode === "archive"
          ? "This program has claims now — it can only be archived. Reopen the dialog."
          : "This program no longer has claims. Reopen the dialog.",
    };
  }

  const now = new Date().toISOString();

  if (plan.data.mode === "delete") {
    // Windows and offer windows cascade; claims are proven absent above, so
    // the RESTRICT can't fire. Wrapped anyway so a concurrent claim insert
    // rolls the whole thing back instead of half-removing the program.
    try {
      await adminDrizzle.transaction(async (tx) => {
        await tx
          .delete(creator_reward_programs)
          .where(eq(creator_reward_programs.id, plan.data.programId));
      });
    } catch (err) {
      // 23503 = foreign_key_violation: a claim landed on this program between
      // the plan and the delete, so the RESTRICT fired after all.
      if (isPostgresError(err, "23503")) {
        return {
          success: false,
          error:
            "A claim was raised on this program just now — reopen the dialog to archive it instead.",
        };
      }
      throw err;
    }
  } else {
    await adminDrizzle.transaction(async (tx) => {
      await tx
        .update(creator_reward_programs)
        .set({
          archived_at: now,
          archived_by: session.userId,
          is_active: false,
          updated_at: now,
        })
        .where(eq(creator_reward_programs.id, plan.data.programId));
      // Close the accrual window, exactly as pausing does — an archived
      // program must not leave an open interval behind that a later restore
      // would treat as continuous.
      await tx
        .update(creator_reward_program_windows)
        .set({ ended_at: now })
        .where(
          and(
            eq(creator_reward_program_windows.program_id, plan.data.programId),
            isNull(creator_reward_program_windows.ended_at),
          ),
        );
    });
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType:
      plan.data.mode === "delete"
        ? "creator_reward_program_deleted"
        : "creator_reward_program_archived",
    metadata: {
      program_id: plan.data.programId,
      name: plan.data.name,
      total_claims: plan.data.totalClaims,
      approved_claims: plan.data.approvedClaims,
      paid_out_usd: plan.data.paidOutUsd,
      open_offers_dropped: plan.data.openOffers,
      at: now,
    },
  });

  revalidateCreatorRewards();
  return { success: true, data: { mode: plan.data.mode } };
}

/**
 * Bring an archived program back — paused, never straight to live.
 *
 * Restoring into an active state would resume accrual the instant someone
 * clicked, on terms nobody had looked at since it was retired. It comes back
 * paused with its window still closed; the normal toggle starts a fresh one.
 */
export async function restoreCreatorRewardProgram(input: {
  programId: string;
}): Promise<ActionResult> {
  await requirePageAccess("/creator-rewards");
  const session = await requireAdmin();

  const parsed = z.object({ programId: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { success: false, error: "Invalid input" };

  const existing = (
    await adminDrizzle
      .select({
        id: creator_reward_programs.id,
        name: creator_reward_programs.name,
        creator_user_id: creator_reward_programs.creator_user_id,
        archived_at: creator_reward_programs.archived_at,
      })
      .from(creator_reward_programs)
      .where(eq(creator_reward_programs.id, parsed.data.programId))
      .limit(1)
  )[0];
  if (!existing) return { success: false, error: "Program not found" };
  if (!existing.archived_at) {
    return { success: false, error: "That program isn't archived." };
  }

  const now = new Date().toISOString();
  await adminDrizzle
    .update(creator_reward_programs)
    .set({
      archived_at: null,
      archived_by: null,
      is_active: false,
      updated_at: now,
    })
    .where(eq(creator_reward_programs.id, existing.id));

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "creator_reward_program_restored",
    targetUserId: existing.creator_user_id,
    metadata: { program_id: existing.id, name: existing.name, at: now },
  });

  revalidateCreatorRewards();
  return { success: true };
}

/**
 * Tell the Discord bot about a decision, then record how that went.
 *
 * ── WHY THIS IS FIRE-AND-FORGET ───────────────────────────────────────────
 * Called via `after()`, so the approve/reject response returns immediately.
 * The webhook contract is explicit that a slow delivery must never make the
 * button feel broken — and more importantly, the balance has ALREADY moved by
 * the time this runs. A webhook failure must not be able to fail, retry or
 * roll back a payment that succeeded.
 *
 * ── WHY IT RECORDS THE OUTCOME ────────────────────────────────────────────
 * Delivery can genuinely fail (bot down, secret rotated, DMs closed upstream).
 * Silently swallowing that means a player is never told their claim was
 * decided, and nobody ever finds out. So the result lands on the claim row,
 * the queue shows a warning, and staff can resend.
 *
 * NEVER THROWS. An exception here would surface as an unhandled rejection in a
 * background task, long after the operator saw "approved".
 */
async function notifyBotOfDecision(params: {
  claimId: string;
  decision: "approved" | "rejected";
  discordUserId: string | null;
  amountUsd: number;
  rewardName: string;
  reason?: string | null;
  force?: boolean;
}): Promise<Awaited<ReturnType<typeof sendClaimDecision>> | null> {
  try {
    // A claim raised by an admin on someone's behalf has no Discord id — there
    // is no one to DM, and that is not an error worth flagging.
    if (!params.discordUserId) return null;
    if (!isBotWebhookConfigured()) return null;

    const event: ClaimDecisionEvent = {
      id: claimEventId(params.claimId, params.decision),
      type:
        params.decision === "approved" ? "claim.approved" : "claim.rejected",
      ...(params.force ? { force: true } : {}),
      data: {
        claimId: params.claimId,
        discordUserId: params.discordUserId,
        rewardName: params.rewardName,
        // Amount ONLY on approval, and only when non-zero: the bot renders 0
        // literally as "$0 has been credited". A rejection carries no amount.
        ...(params.decision === "approved" && params.amountUsd > 0
          ? { amount: params.amountUsd, currency: "USD" }
          : {}),
        // Shown to the player verbatim; the contract caps it at 300 chars,
        // while our review note allows 1000.
        ...(params.decision === "rejected" && params.reason
          ? { reason: params.reason.slice(0, 300) }
          : {}),
      },
    };

    const result = await sendClaimDecision(event);

    await adminDrizzle
      .update(creator_reward_claims)
      .set(
        result.ok
          ? {
              bot_notified_at: new Date().toISOString(),
              bot_notify_error: null,
            }
          : { bot_notify_error: result.error.slice(0, 500) },
      )
      .where(eq(creator_reward_claims.id, params.claimId))
      .catch(() => {});
    return result;
  } catch (err) {
    console.error("[creator-rewards] bot notification failed:", err);
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Delivery failed",
      retriable: false,
    };
  }
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
  /**
   * TOTP code OR a passkey step-up proof token — `require2FA` (via
   * `adjustBalance`) accepts either, so the field is deliberately not
   * constrained to 6 digits. A proof token is far longer than a TOTP code;
   * the old `max(10)` silently rejected every passkey approval.
   */
  totpCode: string;
}): Promise<ActionResult> {
  await requirePageAccess("/creator-rewards");
  const session = await requireAdmin();

  const parsed = z
    .object({
      claimId: z.string().uuid(),
      totpCode: z.string().trim().min(6).max(2048),
    })
    .safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  const claim = await getClaimWithProgram(parsed.data.claimId);
  if (!claim) return { success: false, error: "Claim not found" };
  let ledgerTxId: string | null = null;
  if (claim.status === "pending" && claim.reviewed_at) {
    // Recover a process that died after MAIN committed but before ADMIN could
    // record the ledger id. The immutable claim id makes the retry idempotent.
    ledgerTxId = await findCreatorRewardLedgerId(claim.id);
    if (!ledgerTxId) {
      const reservedAt = new Date(claim.reviewed_at).getTime();
      if (
        !Number.isFinite(reservedAt) ||
        Date.now() - reservedAt < 5 * 60 * 1000
      ) {
        return {
          success: false,
          error: "Claim approval is already in progress",
        };
      }
      // No ledger appeared within five minutes (well beyond the 30s database
      // statement timeout): the worker died before payment. Release only the
      // exact stale reservation we observed, then acquire it normally below.
      const released = await adminDrizzle
        .update(creator_reward_claims)
        .set({ reviewed_by: null, reviewed_at: null })
        .where(
          and(
            eq(creator_reward_claims.id, claim.id),
            eq(creator_reward_claims.status, "pending"),
            eq(creator_reward_claims.reviewed_at, claim.reviewed_at),
          ),
        )
        .returning({ id: creator_reward_claims.id });
      if (released.length !== 1) {
        return {
          success: false,
          error: "Claim approval is already in progress",
        };
      }

      // Audited because this forcibly clears ANOTHER admin's reservation. It is
      // the one mutation here that overrides a colleague, and without a record
      // the trail shows their name simply vanishing from a claim someone else
      // then approved. Written BEFORE the payment so it survives an
      // `adjustBalance` crash — the override happened either way.
      await createAdminAuditEvent({
        adminUserId: session.userId,
        eventType: "creator_reward_claim_reservation_released",
        targetUserId: claim.user_id,
        metadata: {
          claim_id: claim.id,
          program_id: claim.program_id,
          displaced_admin_id: claim.reviewed_by,
          reserved_at: claim.reviewed_at,
          stale_for_ms: Date.now() - reservedAt,
        },
      });
    }
  } else if (claim.status !== "pending") {
    return { success: false, error: `Claim is already ${claim.status}` };
  }

  const amountUsd = Number(claim.amount_usd);
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    return { success: false, error: "Claim has no payable amount" };
  }

  if (!ledgerTxId) {
    // Reserve in ADMIN before touching MAIN. Concurrent approvers can both
    // read "pending", but only one can win this compare-and-set.
    const reserved = await adminDrizzle
      .update(creator_reward_claims)
      .set({
        reviewed_by: session.userId,
        reviewed_at: new Date().toISOString(),
      })
      .where(
        and(
          eq(creator_reward_claims.id, claim.id),
          eq(creator_reward_claims.status, "pending"),
          isNull(creator_reward_claims.reviewed_at),
        ),
      )
      .returning({ id: creator_reward_claims.id });
    if (reserved.length !== 1) {
      return { success: false, error: "Claim approval is already in progress" };
    }

    let credit: Awaited<ReturnType<typeof adjustBalance>> | null = null;
    // The reason line on an immutable ledger row must describe the payment that
    // was actually made, so it is built from the CLAIM's frozen columns, never
    // from the program's current terms.
    //
    // Two ways the old `claim.program.reward_usd` version was wrong. It ignored
    // VIP uplift — a claim priced at the VIP rate recorded the standard one, so
    // `units × rate` didn't equal the amount paid on the same row. And now that
    // programs are editable, a rate changed after a claim was raised would have
    // rewritten the description of a payment made under the old terms.
    //
    // `applied_reward_usd` defaults to 0 on rows written before it existed;
    // those fall back to the program rate, which is what they were priced at.
    const appliedRate = Number(claim.applied_reward_usd);
    const payoutBasis =
      claim.leg === "ftd_lossback"
        ? `${Number(claim.ftd_loss_usd ?? 0).toFixed(2)} lost on first deposit`
        : `${claim.units} × $${(appliedRate > 0
            ? appliedRate
            : Number(claim.program.reward_usd)
          ).toFixed(2)}${claim.was_vip ? " (VIP rate)" : ""}`;
    try {
      credit = await adjustBalance({
        userId: claim.user_id,
        amount: amountUsd,
        category: "creator_vip_reward",
        reason: `Creator VIP reward — ${claim.program.name} (${payoutBasis})`,
        totpCode: parsed.data.totpCode,
        details: {
          creatorId: claim.program.creator_user_id,
          vipClaimId: claim.id,
          vipProgramId: claim.program_id,
          creatorCodes: claim.program.codes,
          creatorProgramName: claim.program.name,
          creatorRewardLeg: claim.leg,
        },
      });
    } catch (error) {
      // adjustBalance can throw after its MAIN transaction committed (for
      // example if the separate ADMIN audit write fails). Check the immutable
      // ledger before releasing the reservation, or a retry could double-pay.
      ledgerTxId = await findCreatorRewardLedgerId(claim.id);
      if (!ledgerTxId) {
        await adminDrizzle
          .update(creator_reward_claims)
          .set({ reviewed_by: null, reviewed_at: null })
          .where(
            and(
              eq(creator_reward_claims.id, claim.id),
              eq(creator_reward_claims.status, "pending"),
              eq(creator_reward_claims.reviewed_by, session.userId),
            ),
          );
        throw error;
      }
    }

    if (!ledgerTxId && credit && !credit.success) {
      await adminDrizzle
        .update(creator_reward_claims)
        .set({ status: "pending", reviewed_by: null, reviewed_at: null })
        .where(
          and(
            eq(creator_reward_claims.id, claim.id),
            eq(creator_reward_claims.status, "pending"),
            eq(creator_reward_claims.reviewed_by, session.userId),
          ),
        );
      return { success: false, error: credit.error };
    }
    if (!ledgerTxId && credit?.success) {
      ledgerTxId = credit.ledgerTxId;
    }
  }

  const finalized = await adminDrizzle
    .update(creator_reward_claims)
    .set({
      status: "approved",
      reviewed_by: session.userId,
      reviewed_at: new Date().toISOString(),
      // No approval note: the field was removed from the dialog (owner,
      // 2026-07-23). Rejection/reopen still require one — those take money
      // away or undo a decision, so the reason matters there.
      review_note: null,
      ledger_tx_id: ledgerTxId,
    })
    .where(
      and(
        eq(creator_reward_claims.id, claim.id),
        eq(creator_reward_claims.status, "pending"),
        isNotNull(creator_reward_claims.reviewed_at),
      ),
    )
    .returning({ id: creator_reward_claims.id });
  if (finalized.length !== 1) {
    return {
      success: false,
      error: "Claim was paid but could not be finalized; retry safely",
    };
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "creator_reward_claim_approved",
    targetUserId: claim.user_id,
    metadata: {
      claim_id: claim.id,
      program_id: claim.program_id,
      program_name: claim.program.name,
      creator_user_id: claim.program.creator_user_id,
      // The codes + leg that earned it, so the audit row alone answers "which
      // creator, under which code, for what" without opening the program.
      creator_codes: claim.program.codes,
      leg: claim.leg,
      units: claim.units,
      amount_usd: amountUsd,
      consumed_wager_usd: Number(claim.consumed_wager_usd),
      ledger_tx_id: ledgerTxId,
    },
  });

  // AFTER the money has actually moved — the DM says "has been credited",
  // which is only true once the ledger write above has succeeded.
  after(() =>
    notifyBotOfDecision({
      claimId: claim.id,
      decision: "approved",
      discordUserId: claim.discord_user_id,
      amountUsd,
      rewardName: claim.program.name,
    }),
  );

  // Log the approved claim (FTD lossback, wager milestone, ...) into the
  // creator's Discord logs channel, next to their sign-up/deposit activity.
  // Fire only on approval, never on request — a no-op if the creator has no
  // active setup, and idempotent per claim id.
  after(() =>
    enqueueCreatorRewardClaimNotification({
      claimId: claim.id,
      creatorUserId: claim.program.creator_user_id,
      referredUserId: claim.user_id,
      leg: claim.leg,
      programName: claim.program.name,
      amountUsd,
      units: claim.units,
      occurredAt: new Date().toISOString(),
    }).catch((err) => {
      console.error("[creator-rewards] reward claim log enqueue failed:", err);
    }),
  );

  revalidateCreatorRewards();
  return { success: true };
}

/** One claim's outcome inside a bulk approval pass. */
export type BulkApproveClaimResult = {
  claimId: string;
  ok: boolean;
  /** Verbatim from the single-claim action — never summarised or swallowed. */
  error?: string;
};

export type BulkApproveOutcome = {
  /** Every claim this pass actually ATTEMPTED, in order, with its outcome. */
  results: BulkApproveClaimResult[];
  /**
   * Selected claims this pass never touched, because the credential was spent.
   * They are completely untouched — no reservation, no ledger row — and the
   * caller re-submits them with a fresh credential.
   */
  remaining: string[];
  /** Whether the submitted credential could legitimately authorise more than one payment. */
  credentialReusable: boolean;
};

/**
 * Heuristic: did this failure spend/invalidate the credential rather than the
 * claim? PURELY a UX stop — it decides whether to keep firing calls that are
 * already doomed, never whether a payment is allowed. Every claim it declines
 * to attempt is reported as `remaining` and left byte-for-byte untouched.
 */
function looksLikeCredentialFailure(error: string): boolean {
  const e = error.toLowerCase();
  return (
    e.includes("2fa") ||
    e.includes("passkey") ||
    e.includes("verification") ||
    e.includes("already used")
  );
}

/**
 * Approve several pending claims with ONE submitted credential.
 *
 * ── WHY THIS CANNOT JUST LOOP N TIMES ─────────────────────────────────────
 * `require2FA` is single-use in BOTH of its normal modes. A TOTP code claims
 * its 30-second step in `admin_users.totp_last_step` and a replay is refused;
 * a passkey step-up proof burns its `jti` into `admin_stepup_used`. So one code
 * authorises exactly one `adjustBalance`, and pretending otherwise would mean
 * weakening a control that exists to stop double-submit money races.
 *
 * The ONE credential that is legitimately reusable is the admin/owner passkey
 * GRACE window (`PASSKEY_GRACE_CREDENTIAL`, a signed ten-minute HttpOnly
 * cookie) — an existing, deliberate mechanism, re-checked against the DB and
 * the cookie on every single call. When the operator holds one, the whole
 * selection goes through in one pass. When they typed a code instead, exactly
 * ONE claim is approved and the rest come back as `remaining` for a fresh
 * credential. No silent re-prompting, no weakened gate.
 *
 * ── SAFETY ────────────────────────────────────────────────────────────────
 * There is no bulk DB write here. Each claim goes through the unchanged
 * `approveCreatorRewardClaim` — same gates, same `adjustBalance`, same
 * per-claim reservation and idempotency — sequentially, never concurrently
 * (concurrent calls would contend on the same credential and the same balance
 * row). A failure anywhere is recorded and the pass continues; claims never
 * attempted stay pending.
 */
export async function bulkApproveCreatorRewardClaims(input: {
  claimIds: string[];
  totpCode: string;
}): Promise<ActionResult<BulkApproveOutcome>> {
  await requirePageAccess("/creator-rewards");
  await requireAdmin();

  const parsed = z
    .object({
      // Bounded: a serverless request has to finish, and each element costs a
      // full MAIN-DB balance transaction.
      claimIds: z.array(z.string().uuid()).min(1).max(50),
      totpCode: z.string().trim().min(6).max(2048),
    })
    .safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  const claimIds = [...new Set(parsed.data.claimIds)];
  const credential = parsed.data.totpCode;
  // The marker alone proves nothing — `require2FA` still verifies the signed
  // cookie AND re-reads the admin row on every call. This only decides how many
  // calls are worth making.
  const credentialReusable = credential === PASSKEY_GRACE_CREDENTIAL;

  const results: BulkApproveClaimResult[] = [];
  let remaining: string[] = [];

  for (let i = 0; i < claimIds.length; i++) {
    const claimId = claimIds[i];
    let outcome: ActionResult;
    try {
      outcome = await approveCreatorRewardClaim({ claimId, totpCode: credential });
    } catch (err) {
      // `approveCreatorRewardClaim` rethrows when `adjustBalance` throws and no
      // ledger row appeared — the claim is released and untouched. Contained
      // here so one bad row can't abort the rest of the batch as a 500.
      outcome = {
        success: false,
        error: err instanceof Error ? err.message : "Approval failed",
      };
    }

    results.push(
      outcome.success
        ? { claimId, ok: true }
        : { claimId, ok: false, error: outcome.error },
    );

    const credentialSpent =
      !credentialReusable ||
      (!outcome.success && looksLikeCredentialFailure(outcome.error));
    if (credentialSpent && i + 1 < claimIds.length) {
      remaining = claimIds.slice(i + 1);
      break;
    }
  }

  return {
    success: true,
    data: { results, remaining, credentialReusable },
  };
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

  const claim = await getClaimWithProgram(parsed.data.claimId);
  if (!claim) return { success: false, error: "Claim not found" };
  if (claim.status !== "pending") {
    return { success: false, error: `Claim is already ${claim.status}` };
  }

  const rejected = await adminDrizzle
    .update(creator_reward_claims)
    .set({
      status: "rejected",
      reviewed_by: session.userId,
      reviewed_at: new Date().toISOString(),
      review_note: parsed.data.note,
    })
    .where(
      and(
        eq(creator_reward_claims.id, claim.id),
        eq(creator_reward_claims.status, "pending"),
        isNull(creator_reward_claims.reviewed_at),
      ),
    )
    .returning({ id: creator_reward_claims.id });
  if (rejected.length !== 1) {
    return {
      success: false,
      error: "Claim approval is already in progress",
    };
  }

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

  after(() =>
    notifyBotOfDecision({
      claimId: claim.id,
      decision: "rejected",
      discordUserId: claim.discord_user_id,
      amountUsd: 0,
      rewardName: claim.program.name,
      reason: parsed.data.note,
    }),
  );

  revalidateCreatorRewards();
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
 * claim, the partial unique index refuses a second pending row. SQLSTATE 23505 is
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

  const claim = await getClaimWithProgram(parsed.data.claimId);
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

  let reinstated: { id: string }[];
  try {
    reinstated = await adminDrizzle
      .update(creator_reward_claims)
      .set({
        status: "pending",
        reinstated_at: new Date().toISOString(),
        reinstated_by: session.userId,
        // Cleared so the row reads as genuinely awaiting review again; who
        // rejected it, and why, is preserved in review_note + the audit trail.
        reviewed_by: null,
        reviewed_at: null,
      })
      // `status = 'rejected'` REPEATED IN THE WHERE, not just read above.
      // The read at the top of this function is a TOCTOU window: between it and
      // this write, another reviewer can approve the claim (approval is allowed
      // on a rejected-then-reinstated row) — and this update would then flip an
      // APPROVED, ALREADY PAID claim back to pending while leaving its
      // `ledger_tx_id` populated, making it approvable a second time. Every
      // sibling mutation here guards in the WHERE for exactly this reason;
      // this one didn't. A zero-row result now means someone got there first.
      .where(
        and(
          eq(creator_reward_claims.id, claim.id),
          eq(creator_reward_claims.status, "rejected"),
        ),
      )
      .returning({ id: creator_reward_claims.id });
  } catch (err) {
    if (isPostgresError(err, "23505")) {
      return {
        success: false,
        error:
          "This player already has a newer claim awaiting review — handle that one instead.",
      };
    }
    throw err;
  }
  if (reinstated.length !== 1) {
    return {
      success: false,
      error:
        "That claim was decided by someone else just now — reload the queue.",
    };
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

  revalidateCreatorRewards();
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

  revalidateCreatorRewards();
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

  const programRow = (
    await adminDrizzle
      .select()
      .from(creator_reward_programs)
      .where(eq(creator_reward_programs.id, parsed.data.programId))
      .limit(1)
  )[0];
  if (!programRow) return { success: false, error: "Program not found" };
  const program = normalizeProgram(programRow);

  // This preview is an EXACT lookup — the operator has already picked a person.
  // The wildcards are escaped because `ilike` treats `%` and `_` as patterns:
  // unescaped, a lone `%` matched an arbitrary account and the dialog then
  // rendered that stranger's entitlement as if it had been asked for.
  const q = parsed.data.query;
  const qLike = q.replace(/[\\%_]/g, "\\$&");
  const [matchedUser] = await getProdReadDrizzleDb()
    .select({ id: user.id, username: user.username, email: user.email })
    .from(user)
    .where(
      or(eq(user.id, q), ilike(user.username, qLike), ilike(user.email, qLike)),
    )
    .limit(1);
  if (!matchedUser) return { success: false, error: "No user matches that" };

  const offers = await computeProgramOffers(program, matchedUser.id);
  // The preview shows the leg with something payable; failing that, the
  // first configured one, so the operator still sees WHY nothing is due.
  const e = offers.find((o) => o.units > 0) ?? offers[0];
  if (!e) {
    return { success: false, error: "This program has no rewards configured" };
  }

  return {
    success: true,
    data: {
      userId: matchedUser.id,
      username: matchedUser.username ?? matchedUser.email ?? null,
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
 * ONLY `role = 'creator'` accounts come back (owner, 2026-07-23). That is the
 * same set `createCreatorRewardProgram` will accept, so everything listed can
 * actually be picked. The consequence is deliberate: a code owned by a plain
 * `user` (prod has plenty — PACKYGGG among them) resolves to nothing here.
 * Make the account a creator first, then it appears.
 *
 * Ordered by username. Read-only against MAIN; measured
 * 1.5 ms (EXPLAIN ANALYZE, prod 2026-07-23) — the union legs are index
 * searches, `affiliate_codes` is ~1k rows. Empty query lists creators so the
 * dialog opens with something to pick.
 */

/**
 * Resend the decision DM for a claim whose webhook failed.
 *
 * The retry budget inside `after()` is deliberately short (~36s — a serverless
 * request cannot back off for ten minutes), so a bot that was down longer than
 * that leaves a claim decided-but-unannounced. This is the recovery path.
 *
 * This is an explicit staff retry, so it sets `force: true`. A current bot
 * drops the cached event id and attempts the DM again. An older bot safely
 * ignores the additive flag; if it answers `duplicate`, that is surfaced as a
 * failure because no delivery was attempted.
 */
export async function resendClaimDecisionNotice(input: {
  claimId: string;
}): Promise<ActionResult> {
  await requirePageAccess("/creator-rewards");
  const session = await requireAdmin();

  const parsed = z.object({ claimId: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { success: false, error: "Invalid input" };

  if (!isBotWebhookConfigured()) {
    return {
      success: false,
      error: "The Discord bot webhook isn't configured on this deployment.",
    };
  }

  const claim = await getClaimWithProgram(parsed.data.claimId);
  if (!claim) return { success: false, error: "Claim not found" };
  if (claim.status === "pending") {
    return { success: false, error: "That claim hasn't been decided yet." };
  }
  if (!claim.discord_user_id) {
    return {
      success: false,
      error:
        "This claim was raised in the dashboard — there's no Discord user to notify.",
    };
  }

  const result = await notifyBotOfDecision({
    claimId: claim.id,
    decision: claim.status === "approved" ? "approved" : "rejected",
    discordUserId: claim.discord_user_id,
    amountUsd: Number(claim.amount_usd),
    rewardName: claim.program.name,
    reason: claim.review_note,
    force: true,
  });

  const delivered = result?.ok === true;
  const deliveryError =
    result && !result.ok
      ? result.error
      : "Delivery failed — try again shortly.";

  // Audited because it is an admin-triggered, player-facing send that also
  // mutates the claim's delivery state — without this, a DM the player disputes
  // has no record of who re-sent it or when.
  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "creator_reward_claim_notice_resent",
    targetUserId: claim.user_id,
    metadata: {
      claim_id: claim.id,
      program_id: claim.program_id,
      decision: claim.status,
      discord_user_id: claim.discord_user_id,
      delivered,
      error: delivered ? null : deliveryError,
    },
  });

  revalidateCreatorRewards();
  return delivered
    ? { success: true }
    : {
        success: false,
        error: deliveryError,
      };
}

/**
 * Check the Discord-bot webhook without messaging anyone.
 *
 * Sends a well-formed event of an unrecognised type. The bot verifies the
 * signature and parses the payload BEFORE it looks at `type`, so this
 * exercises reachability, the shared secret and the signing scheme, then stops
 * at `200 unsupported_type` instead of a DM.
 *
 * The returned message names the specific failure, because the three ways this
 * goes wrong look identical from the outside: a wrong secret (401), a bot that
 * is up but not yet connected to Discord (503), and a URL that resolves to
 * nothing (network error).
 */
export async function testBotWebhookConnection(): Promise<
  ActionResult<{ message: string }>
> {
  await requirePageAccess("/creator-rewards");
  const session = await requireAdmin();

  const status = botWebhookConfigStatus();
  if (!status.configured) {
    const missing = [
      !status.hasUrl && "DISCORD_BOT_WEBHOOK_URL",
      !status.hasSecret && "DISCORD_BOT_WEBHOOK_SECRET",
    ].filter(Boolean);
    return {
      success: false,
      error: `Not configured — missing ${missing.join(" and ")} on this deployment. Remember a redeploy is needed after adding them.`,
    };
  }
  if (status.secretTooShort) {
    return {
      success: false,
      error:
        "The secret is under 32 characters — the bot refuses to start with one that short. Regenerate with `openssl rand -hex 32`.",
    };
  }

  const result = await testBotWebhook();

  // Audited only from here down: the config pre-checks above send nothing, so
  // logging them would fill the trail with events that never left the building.
  // This is an admin-triggered OUTBOUND signed request, which is worth a record
  // even though it messages no one.
  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "creator_reward_bot_webhook_tested",
    metadata: { ok: result.ok, error: result.ok ? null : result.error },
  });

  if (result.ok) {
    return {
      success: true,
      data: { message: "Bot reachable, signature accepted." },
    };
  }

  // Translate the three failures that look the same from here.
  const e = result.error;
  const hint = e.includes("401")
    ? "The bot rejected the signature — the secret here and the bot's WEBHOOK_SECRET don't match."
    : e.includes("503")
      ? "The bot is up but not connected to Discord yet. Try again shortly."
      : e.includes("404") || e.includes("405")
        ? "Reached the host but not the webhook route — check the URL ends in /webhooks/packy."
        : "Couldn't reach the bot. Check the URL and that the Railway service has a public domain.";

  return { success: false, error: `${hint} (${e})` };
}

export async function searchCreatorsWithCodes(
  query: string,
): Promise<CreatorSearchResult[]> {
  await requirePageAccess("/creator-rewards");
  await requireAdmin();

  // Bounded before it reaches prod. The query is parameterized and LIKE-escaped
  // below, so this isn't an injection guard — it stops an unbounded operator
  // string being shipped to the MAIN database as a scan predicate.
  const parsedQuery = z.string().max(120).safeParse(query);
  if (!parsedQuery.success) return [];

  const q = parsedQuery.data.trim();
  const db = getProdReadDrizzleDb();

  type Row = {
    id: string;
    username: string | null;
    email: string | null;
    role: string;
    codes: string[];
  };

  const lower = q.toLowerCase().replace(/[\\%_]/g, "\\$&");
  const upper = q.toUpperCase().replace(/[\\%_]/g, "\\$&");
  const result = await db.execute<Row>(sql`
    SELECT u.id, u.username, u.email, u.role::text AS role,
           COALESCE(
             (SELECT array_agg(UPPER(ac.code) ORDER BY ac.code)
                FROM affiliate_codes ac WHERE ac.user_id = u.id),
             '{}'
           ) AS codes
      FROM "user" u
     WHERE u.role = 'creator'::user_role
       AND (
         ${q} = ''
         OR LOWER(u.username) LIKE ${`${lower}%`} ESCAPE '\'
         OR LOWER(u.display_username) LIKE ${`${lower}%`} ESCAPE '\'
         OR LOWER(u.email) LIKE ${`${lower}%`} ESCAPE '\'
         OR u.id = ${q}
         OR EXISTS (
           SELECT 1 FROM affiliate_codes ac
           WHERE ac.user_id = u.id
             AND UPPER(ac.code) LIKE ${`${upper}%`} ESCAPE '\'
         )
       )
     ORDER BY u.username ASC NULLS LAST
     LIMIT 20
  `);
  const rows = result.rows;

  return rows.map((r) => ({
    userId: r.id,
    username: r.username ?? r.email ?? null,
    role: r.role,
    codes: r.codes ?? [],
  }));
}
