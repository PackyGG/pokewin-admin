"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/dal";
import { requireInsightsOwner } from "@/lib/insights/motha-gate";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { isMainOwnerUsername } from "@/lib/owners";
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
 * Resolves @motha by username (read-only; requires EXACTLY one match — a
 * not-found / ambiguous result errors instead of guessing). Re-points
 * `affiliate_codes.user_id` to motha + bumps `updated_at`. MINIMAL by
 * design: only the code-ownership row moves. Historical
 * `affiliate_code_usages` rows (keyed on the original `affiliate_user_id`)
 * and all earnings are deliberately left in place.
 *
 * Mirrors the spirit of the sanctioned `transferAffiliateCode`
 * (users/[id]/actions.ts), minus the previous-owner replacement-code step
 * (owner asked to keep this transfer MINIMAL). NOTE downstream effects are
 * flagged in the agent report.
 */
export async function transferAffiliateCodeToMotha(
  input: z.infer<typeof transferSchema>,
): Promise<AffiliateCodeActionResult> {
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

  // MAIN write — re-point ownership only.
  await db.affiliate_codes.update({
    where: { id: codeId },
    data: { user_id: motha.id, updated_at: new Date() },
  });

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
    },
  });

  revalidatePath("/insights/affiliate-codes");
  return {
    success: true,
    message: `Transferred ${codeRow.code} to @${motha.username ?? "motha"}.`,
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
