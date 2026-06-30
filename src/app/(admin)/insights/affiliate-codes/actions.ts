"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/dal";
import { requireInsightsOwner } from "@/lib/insights/motha-gate";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { isMainOwnerUsername } from "@/lib/owners";
import { generateRandomAffiliateCode } from "@/lib/affiliate/generate-code";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import {
  getRecentAffiliateUsages,
  type AffiliateCodeUsageRow,
} from "@/lib/queries/affiliate-codes-lookup";

/**
 * Server actions for /insights/affiliate-codes.
 *
 * SCOPE: two sensitive money-adjacent operations on a single affiliate
 * code, modelled directly on the sanctioned affiliate writes in
 * `src/app/(admin)/users/[id]/actions.ts` (createAffiliateCode /
 * transferAffiliateCode).
 *
 * AUTH: the whole Insights tree is already owner-gated by the layout
 * (`requireInsightsOwner`). These actions ALSO independently gate
 * server-side — `requireAdmin()` (admin role) + a re-assert of
 * `requireInsightsOwner()` — because a server action is its own entry
 * point and must not trust that the page gate ran. Both ops are
 * admin-only (matching the sensitivity of affiliate-revenue writes).
 *
 * AUDIT: every mutation writes an `admin_audit_events` row via
 * `createAdminAuditEvent` (ADMIN DB — the CLAUDE.md convention). No extra
 * MAIN `audit_events` write is added.
 *
 * MAIN-WRITE NOTE: these perform a write against the MAIN (prod, game) DB.
 * They run in production only. They are deliberately NOT executed against
 * MAIN from a local read-only credential (the write would fail, as
 * expected) — build-verified only.
 */

const zeroBalanceSchema = z.object({
  codeId: z.string().uuid(),
  ownerUserId: z.string().min(1),
});

export type AffiliateCodeActionResult =
  | { success: true; message: string }
  | { success: false; error: string };

/**
 * Transfer result — like AffiliateCodeActionResult but additionally carries
 * the replacement code issued to the stripped previous owner so the UI can
 * surface it (matching the sanctioned `transferAffiliateCode` return shape,
 * which returns `replacementCode` + `previousOwnerId`).
 */
export type AffiliateCodeTransferResult =
  | {
      success: true;
      message: string;
      replacementCode: string;
      previousOwnerId: string;
    }
  | { success: false; error: string };

/**
 * ACTION 1 — Zero an affiliate code owner's claimable balance.
 *
 * Sets `affiliate_accounts.available_usd = 0` for the OWNER of the given
 * code. Leaves `total_earned_usd` / `total_paid_out_usd` / payout history
 * untouched — only the currently-claimable bucket is zeroed, so the audit
 * trail of what was ever earned/paid stays intact.
 *
 * The audit event records the OLD `available_usd` so the action is fully
 * reversible from the record if needed.
 */
export async function zeroAffiliateClaimBalance(
  input: z.infer<typeof zeroBalanceSchema>,
): Promise<AffiliateCodeActionResult> {
  const parsed = zeroBalanceSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { codeId, ownerUserId } = parsed.data;

  // Independent server-side auth (do not trust the page gate).
  const session = await requireAdmin();
  await requireInsightsOwner();

  const db = await getDb();

  // Re-read the code row to confirm it exists and still belongs to the
  // claimed owner (guards against a stale UI after a transfer).
  const codeRow = await db.affiliate_codes.findUnique({
    where: { id: codeId },
    select: { code: true, user_id: true },
  });
  if (!codeRow) {
    return { success: false, error: "That code no longer exists — refresh and try again." };
  }
  if (codeRow.user_id !== ownerUserId) {
    return {
      success: false,
      error: "This code's owner changed — refresh and try again.",
    };
  }

  const account = await db.affiliate_accounts.findUnique({
    where: { user_id: ownerUserId },
    select: { available_usd: true },
  });
  if (!account) {
    return {
      success: false,
      error: "This owner has no affiliate account row — nothing to zero.",
    };
  }

  const oldAvailable = Number(account.available_usd.toString());
  if (oldAvailable === 0) {
    return { success: false, error: "Claimable balance is already $0.00." };
  }

  // MAIN write — zero only the claimable bucket.
  await db.affiliate_accounts.update({
    where: { user_id: ownerUserId },
    data: { available_usd: 0, updated_at: new Date() },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "affiliate_claim_balance_zeroed",
    targetUserId: ownerUserId,
    metadata: {
      code: codeRow.code,
      codeId,
      oldAvailableUsd: oldAvailable,
      newAvailableUsd: 0,
      // total_earned_usd / total_paid_out_usd intentionally untouched.
    },
  });

  revalidatePath("/insights/affiliate-codes");
  return {
    success: true,
    message: `Zeroed $${oldAvailable.toFixed(2)} claimable from ${codeRow.code}.`,
  };
}

const transferSchema = z.object({
  codeId: z.string().uuid(),
  currentOwnerUserId: z.string().min(1),
});

/**
 * ACTION 2 — Transfer a code's ownership to @motha (the root owner).
 *
 * Upgraded to MATCH the sanctioned `transferAffiliateCode`
 * (src/app/(admin)/users/[id]/actions.ts) so the two flows behave
 * identically — it reuses the SAME shared generator
 * (`generateRandomAffiliateCode` from `@/lib/affiliate/generate-code`,
 * which the sanctioned action now also imports) and the SAME atomic
 * `$transaction` shape:
 *
 *   1. Re-point `affiliate_codes.user_id` to @motha (+ bump updated_at) —
 *      preserving the row's `created_at` / history.
 *   2. Create a fresh `affiliate_codes` row for the stripped previous owner
 *      with a unique random replacement code so they are never codeless.
 *   3. Upsert an `affiliate_accounts` row for BOTH @motha and the previous
 *      owner (`create: { user_id }`, `update: {}`) so future commissions
 *      from the code actually accrue to @motha (matching the sanctioned
 *      default field values — all other columns keep their schema defaults).
 *
 * All four writes run in ONE `db.$transaction([...])` (atomic). Resolves
 * @motha by exact unique username (errors if not found — never guesses).
 * Historical `affiliate_code_usages` rows (keyed on the original
 * `affiliate_user_id`) and all earnings stay attributed to the previous
 * owner. `user.affiliate_code` (the referral cookie) is deliberately
 * untouched on both sides — code ownership lives entirely in
 * `affiliate_codes`, exactly as the sanctioned transfer documents.
 */
export async function transferAffiliateCodeToMotha(
  input: z.infer<typeof transferSchema>,
): Promise<AffiliateCodeTransferResult> {
  const parsed = transferSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { codeId, currentOwnerUserId } = parsed.data;

  const session = await requireAdmin();
  await requireInsightsOwner();

  const db = await getDb();

  // Resolve @motha by username — read-only, must be exactly one. We accept
  // only the canonical root-owner username (guards a typo'd or
  // impersonating "motha"-ish account). `username` is unique-indexed so
  // this is a single point lookup.
  if (!isMainOwnerUsername("motha")) {
    // Defensive: keeps the canonical-owner assumption explicit.
    return { success: false, error: "Root owner username misconfigured." };
  }
  const motha = await db.user.findUnique({
    where: { username: "motha" },
    select: { id: true, username: true },
  });
  if (!motha) {
    return {
      success: false,
      error: "Could not resolve @motha — no user with that exact username.",
    };
  }

  const codeRow = await db.affiliate_codes.findUnique({
    where: { id: codeId },
    select: { code: true, user_id: true },
  });
  if (!codeRow) {
    return { success: false, error: "That code no longer exists — refresh and try again." };
  }
  if (codeRow.user_id !== currentOwnerUserId) {
    return {
      success: false,
      error: "This code's owner changed — refresh and try again.",
    };
  }
  if (codeRow.user_id === motha.id) {
    return { success: false, error: "@motha already owns this code." };
  }

  const previousOwnerId = codeRow.user_id;

  // Pre-generate the replacement code (read-only uniqueness check via the
  // shared helper) BEFORE the transaction so the $transaction array stays
  // a set of independent writes (matching the sanctioned mechanism).
  const replacementCode = await generateRandomAffiliateCode(db);

  // MAIN writes — atomic. Mirrors the sanctioned transferAffiliateCode:
  //   • move the code row to @motha,
  //   • give the previous owner the replacement code,
  //   • ensure BOTH sides have an affiliate_accounts row.
  await db.$transaction([
    db.affiliate_codes.update({
      where: { id: codeId },
      data: { user_id: motha.id, updated_at: new Date() },
    }),
    db.affiliate_codes.create({
      data: { user_id: previousOwnerId, code: replacementCode },
    }),
    db.affiliate_accounts.upsert({
      where: { user_id: motha.id },
      create: { user_id: motha.id },
      update: {},
    }),
    db.affiliate_accounts.upsert({
      where: { user_id: previousOwnerId },
      create: { user_id: previousOwnerId },
      update: {},
    }),
  ]);

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "affiliate_code_transferred_to_owner",
    targetUserId: motha.id,
    metadata: {
      code: codeRow.code,
      codeId,
      previousOwnerId,
      newOwnerId: motha.id,
      newOwnerUsername: motha.username,
      // Replacement code issued to the stripped previous owner so they are
      // never left codeless (matches the sanctioned transfer).
      replacementCode,
      // Both accounts rows were ensured (upserted) in the same transaction
      // so future commissions from the code accrue to @motha.
      affiliateAccountsUpserted: [motha.id, previousOwnerId],
    },
  });

  revalidatePath("/insights/affiliate-codes");
  return {
    success: true,
    message: `Transferred ${codeRow.code} to @${motha.username ?? "motha"}. Previous owner's replacement code: ${replacementCode}.`,
    replacementCode,
    previousOwnerId,
  };
}

/**
 * READ-ONLY server action backing the recent-usages disclosure on each
 * code card. Bounded (15 rows) + indexed via
 * `idx_affiliate_code_usages_affiliate_referred`. Owner-gated (the whole
 * Insights tree is owner-only); returns a serializable payload only.
 */
export async function loadRecentAffiliateUsages(
  affiliateUserId: string,
): Promise<AffiliateCodeUsageRow[]> {
  await requireInsightsOwner();
  const { data } = await safeQuery(
    () => getRecentAffiliateUsages(affiliateUserId, 15),
    [] as AffiliateCodeUsageRow[],
    "affiliate-codes.usages",
    REWARD_QUERY_TIMEOUT_MS,
  );
  return data;
}
