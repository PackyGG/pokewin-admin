"use server";

import crypto from "crypto";
import { revalidatePath, unstable_cache } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { adminDb } from "@/lib/admin-db";
import { requireAdmin, requirePageAccess } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { user_role } from "@/generated/prisma/client";
import { getUserInventory, getUserTransactions, getCreatorReferralClicks, getCreatorCodeUsages, getCreatorWithdrawalLimits, getUserAttributionJourney, getProvablyFairResults, getSeedRotationHistory, getUserBalanceHistory } from "@/lib/queries/users";
import type { AttributionJourneyEntry } from "@/lib/queries/users";
import { safeQuery } from "@/lib/errors/safe-query";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { require2FA } from "@/lib/require-2fa";
import { checkBalanceAdjustmentLimit } from "@/lib/balance-limits";
import { creatorsApi, BackendApiError } from "@/lib/backend-api";
import {
  canUserAdjustBalance,
  hasCapability,
} from "@/app/(admin)/settings/roles/permissions-utils";
import { usdAmountSchema } from "@/lib/utils/money";
import {
  BALANCE_ADJUSTMENT_CATEGORY_KEYS,
  type BalanceAdjustmentCategory,
} from "@/lib/balance-adjustment-categories";
import { ensureBalanceAdjustmentMetaSchema } from "@/lib/balance-adjustment-meta/ensure-schema";

// Hosts we accept as a "Giveaway" source URL. Anything else is rejected
// at the action boundary so the giveaway log can't be polluted with
// random links. Twitter accepts both legacy twitter.com + the new x.com;
// Discord covers the web client (discord.com), the app deeplinks
// (canary/ptb), and the invite shortener (discord.gg).
const GIVEAWAY_SOURCE_HOSTS: Record<string, "twitter" | "discord"> = {
  "twitter.com": "twitter",
  "www.twitter.com": "twitter",
  "x.com": "twitter",
  "www.x.com": "twitter",
  "mobile.twitter.com": "twitter",
  "discord.com": "discord",
  "www.discord.com": "discord",
  "canary.discord.com": "discord",
  "ptb.discord.com": "discord",
  "discord.gg": "discord",
};

/**
 * Validate + classify a giveaway source URL. Returns the resolved
 * source-type (`twitter` / `discord` / `other`) or throws if the URL
 * is malformed. We use `other` as a soft escape hatch in case the
 * admin pastes something we don't know about — the row still lands,
 * just labelled neutrally. Throws only on outright unparseable input.
 */
function classifyGiveawaySourceUrl(rawUrl: string): {
  url: string;
  sourceType: "twitter" | "discord" | "other";
} {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Giveaway source URL is not a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Giveaway source URL must be http(s)");
  }
  const host = parsed.host.toLowerCase();
  const sourceType = GIVEAWAY_SOURCE_HOSTS[host] ?? "other";
  return { url: parsed.toString(), sourceType };
}

// ── Strict categorized balance adjustment ──────────────────────────
//
// Every adjustment now requires a CATEGORY and category-specific inputs
// (Zod-validated below). The chosen category key is stamped onto the
// MAIN-DB ledger row's `metadata` JSON (`metadata.adjustment_category`)
// so the GGR / NGR / cost queries (which read the main DB) can classify
// each adjustment with NO cross-DB join. The rich, admin-only inputs
// (coin type, tx hash, social link, exact reason, lossback %, 7d PnL,
// note) go to the admin-DB `admin_balance_adjustment_meta` table.
//
// Counting: every category EXCEPT `other` is COUNTED — lifted into the
// reward-cost / NGR side at the query layer. `other` stays RESIDUAL /
// EXCLUDED (mainly for content-creator bookkeeping). See
// `src/lib/balance-adjustment-categories.ts` (the single canonical set).

/** Per-category extra inputs the dialog collects. All optional at the */
/** schema level; required-ness is enforced per category in code below. */
const adjustmentDetailsSchema = z
  .object({
    // deposit_problem
    coinType: z.string().trim().min(1).max(64).optional(),
    txHash: z.string().trim().min(1).max(255).optional(),
    // giveaway — a Twitter OR Discord link
    socialLink: z.string().trim().min(1).max(2048).optional(),
    // bonus (exact reason, ≥20 chars) / lossback (optional note)
    reasonText: z.string().trim().max(5000).optional(),
    // lossback
    lossbackPercent: z.number().finite().optional(),
    pnl7dUsd: z.number().finite().optional(),
  })
  .optional();

const adjustBalanceSchema = z.object({
  userId: z.string(),
  // Finite, cent-precise amount (may be +/-). The server never trusts
  // the client's parse: a malformed number like 17.878 (3 decimals, the
  // old parseFloat-truncation symptom) is rejected here, not rounded.
  // Zero is a no-op (no ledger row) so it's rejected too.
  amount: usdAmountSchema().refine((n) => n !== 0, {
    message: "Amount can't be zero",
  }),
  // The strict category. Drives both the conditional inputs and whether
  // the adjustment is counted in GGR/NGR/cost.
  category: z.enum(BALANCE_ADJUSTMENT_CATEGORY_KEYS),
  // Human-readable description text. Kept so the existing
  // description-prefix classification ("Admin adjustment: <reason>") on
  // the insights-balance-adjustments surface + the adjustments-wipe flow
  // keep working unchanged. Derived from the category on the client.
  reason: z.string().trim().min(1).max(5000),
  // Category-specific inputs (validated per-category below).
  details: adjustmentDetailsSchema,
});

/**
 * Resolved, validated rich-metadata for the admin-DB row, plus the
 * giveaway-feed classification when the category is `giveaway`. Returned
 * by the per-category validator so the action can persist it after the
 * ledger write succeeds.
 */
type ResolvedAdjustmentMeta = {
  coinType: string | null;
  txHash: string | null;
  socialLink: string | null;
  reasonText: string | null;
  lossbackPercent: number | null;
  pnl7dUsd: number | null;
  /** Set only for `giveaway` — drives the legacy /marketing/giveaway feed. */
  giveawaySource: { url: string; sourceType: "twitter" | "discord" | "other" } | null;
};

/**
 * Enforce the per-category required inputs (the table in CLAUDE/spec):
 *   deposit_problem → coin type + tx hash
 *   giveaway        → a Twitter OR Discord link
 *   bonus           → exact reason, min 20 chars
 *   reload          → (no input)
 *   lossback        → 7d PnL value + % lossback + OPTIONAL explanation
 *   other           → free-text, min 20 chars (NOT counted)
 *
 * Returns either the resolved metadata or a human error string. This is
 * the SINGLE server-side source of truth — the dialog mirrors it for a
 * friendlier inline toast, but never replaces it.
 */
function validateAdjustmentCategory(
  category: BalanceAdjustmentCategory,
  details: z.infer<typeof adjustmentDetailsSchema>,
): { ok: true; meta: ResolvedAdjustmentMeta } | { ok: false; error: string } {
  const d = details ?? {};
  const base: ResolvedAdjustmentMeta = {
    coinType: null,
    txHash: null,
    socialLink: null,
    reasonText: null,
    lossbackPercent: null,
    pnl7dUsd: null,
    giveawaySource: null,
  };

  switch (category) {
    case "deposit_problem": {
      if (!d.coinType) return { ok: false, error: "Deposit problem requires a coin type" };
      if (!d.txHash) return { ok: false, error: "Deposit problem requires a transaction hash" };
      return { ok: true, meta: { ...base, coinType: d.coinType, txHash: d.txHash } };
    }
    case "giveaway": {
      if (!d.socialLink) {
        return {
          ok: false,
          error: "Giveaway requires a Twitter or Discord link",
        };
      }
      let giveawaySource: ResolvedAdjustmentMeta["giveawaySource"];
      try {
        giveawaySource = classifyGiveawaySourceUrl(d.socialLink);
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : "Invalid giveaway link",
        };
      }
      return {
        ok: true,
        meta: { ...base, socialLink: giveawaySource.url, giveawaySource },
      };
    }
    case "bonus": {
      const reasonText = (d.reasonText ?? "").trim();
      if (reasonText.length < 20) {
        return { ok: false, error: "Bonus requires an exact reason of at least 20 characters" };
      }
      return { ok: true, meta: { ...base, reasonText } };
    }
    case "reload": {
      // No required inputs.
      return { ok: true, meta: base };
    }
    case "lossback": {
      if (d.pnl7dUsd === undefined || !Number.isFinite(d.pnl7dUsd)) {
        return { ok: false, error: "Lossback requires a 7-day PnL value" };
      }
      if (d.lossbackPercent === undefined || !Number.isFinite(d.lossbackPercent)) {
        return { ok: false, error: "Lossback requires a lossback %" };
      }
      // Cap the lossback rate at 35% — the dialog offers 5/10/15/20 quick
      // picks plus a custom box that's also capped at 35. This is the
      // server-side source of truth; the client mirror is only a friendlier
      // inline toast.
      if (d.lossbackPercent < 0 || d.lossbackPercent > 35) {
        return { ok: false, error: "Lossback % must be between 0 and 35" };
      }
      const note = (d.reasonText ?? "").trim();
      return {
        ok: true,
        meta: {
          ...base,
          lossbackPercent: d.lossbackPercent,
          pnl7dUsd: d.pnl7dUsd,
          reasonText: note.length > 0 ? note : null,
        },
      };
    }
    case "other": {
      const reasonText = (d.reasonText ?? "").trim();
      if (reasonText.length < 20) {
        return { ok: false, error: "Other requires a reason of at least 20 characters" };
      }
      return { ok: true, meta: { ...base, reasonText } };
    }
  }
}

export async function adjustBalance(data: {
  userId: string;
  amount: number;
  category: BalanceAdjustmentCategory;
  reason: string;
  totpCode: string;
  details?: {
    coinType?: string;
    txHash?: string;
    socialLink?: string;
    reasonText?: string;
    lossbackPercent?: number;
    pnl7dUsd?: number;
  };
}): Promise<{ success: true } | { success: false; error: string }> {
  const db = await getDb();
  const session = await requirePageAccess("/users");

  const parseResult = adjustBalanceSchema.safeParse(data);
  if (!parseResult.success) {
    return { success: false, error: parseResult.error.issues[0]?.message ?? "Invalid input" };
  }
  const parsed = parseResult.data;

  // Per-category required-input validation (single source of truth).
  const categoryResult = validateAdjustmentCategory(parsed.category, parsed.details);
  if (!categoryResult.ok) {
    return { success: false, error: categoryResult.error };
  }
  const meta = categoryResult.meta;

  // Admins can always adjust; non-admins need the __can_adjust_balance capability
  if (session.role !== "admin") {
    const perms = await adminDb.admin_users.findUnique({
      where: { id: session.userId },
      select: { allowed_pages: true },
    });
    if (!perms || !canUserAdjustBalance(perms.allowed_pages)) {
      return { success: false, error: "You do not have permission to adjust balances" };
    }
  }

  try {
    await require2FA(session.userId, data.totpCode);
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "2FA verification failed" };
  }

  try {
    await checkBalanceAdjustmentLimit(session.userId, parsed.amount);
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Balance limit exceeded" };
  }

  // Optimistic-locking transaction. The previous (non-locking) version
  // could double-write if two admin actions on the same balance row
  // raced — both reading the same `currentBalance`, both computing
  // `currentBalance + delta`, both updating to the SAME value, second
  // ledger row reflects a balance_before that no longer matches reality.
  // We now read inside the tx, recompute, and update only when the
  // version still matches; on mismatch we abort + return a friendly retry.
  let currentBalance = 0;
  let newBalance = 0;
  // Capture the ledger row id so the admin-side metadata write below can
  // cross-reference it.
  const ledgerTxId = crypto.randomUUID();
  try {
    await db.$transaction(async (tx) => {
      const b = await tx.balances.findUnique({
        where: { user_id: parsed.userId },
      });
      if (!b) throw new Error("User balances not found");

      currentBalance = Number(b.available_balance);
      newBalance = currentBalance + parsed.amount;
      if (newBalance < 0) {
        throw new Error("Resulting balance would be negative");
      }

      const updated = await tx.balances.updateMany({
        where: { user_id: parsed.userId, version: b.version },
        data: {
          available_balance: newBalance,
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) {
        throw new Error("Balance changed concurrently — please retry");
      }

      await tx.ledger_transactions.create({
        data: {
          id: ledgerTxId,
          user_id: parsed.userId,
          type: "admin_balance_adjustment",
          amount: parsed.amount,
          balance_before: currentBalance,
          balance_after: newBalance,
          description: `Admin adjustment: ${parsed.reason}`,
          // Stamp the canonical category key onto the ledger row so the
          // GGR/NGR/cost queries can classify this adjustment with NO
          // cross-DB join. Counted categories (everything but `other`)
          // are lifted into the reward-cost side via this exact field
          // (`metadata->>'adjustment_category'`), mirroring the existing
          // manual-voucher carve-out (`metadata->>'origin'`).
          metadata: { adjustment_category: parsed.category },
          status: "completed",
        },
      });
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    // Surface known business errors verbatim; only generic crashes get
    // the "please try again" wrapper.
    if (
      message === "User balances not found" ||
      message === "Resulting balance would be negative" ||
      message.includes("concurrently")
    ) {
      return { success: false, error: message };
    }
    console.error("[adjustBalance] Transaction failed:", err);
    return { success: false, error: "Balance adjustment failed — please try again" };
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "balance_adjustment",
    targetUserId: parsed.userId,
    metadata: { amount: parsed.amount, reason: parsed.reason, category: parsed.category },
  });

  // Persist the RICH admin-side metadata (category-specific inputs) to the
  // admin DB. Best-effort — we already wrote the ledger row + the canonical
  // category onto it, so a metadata-row failure here shouldn't fail the
  // whole adjustment (the user got their balance, and the GGR/cost
  // classification reads the ledger metadata, not this table). A separate
  // console.error surfaces a row-write failure without blocking the toast.
  try {
    await ensureBalanceAdjustmentMetaSchema();
    await adminDb.admin_balance_adjustment_meta.create({
      data: {
        admin_user_id: session.userId,
        target_user_id: parsed.userId,
        ledger_tx_id: ledgerTxId,
        category: parsed.category,
        amount_usd: parsed.amount,
        coin_type: meta.coinType,
        tx_hash: meta.txHash,
        social_link: meta.socialLink,
        reason_text: meta.reasonText,
        lossback_pct: meta.lossbackPercent,
        pnl_7d_usd: meta.pnl7dUsd,
      },
    });
  } catch (err) {
    console.error(
      "[adjustBalance] meta-row write failed (ledger already committed):",
      err,
    );
  }

  // Keep the legacy giveaway-feed row so /marketing/giveaway keeps working
  // unchanged. Best-effort, same as above.
  if (parsed.category === "giveaway" && meta.giveawaySource) {
    try {
      await adminDb.admin_giveaway_actions.create({
        data: {
          admin_user_id: session.userId,
          target_user_id: parsed.userId,
          amount_usd: parsed.amount,
          source_url: meta.giveawaySource.url,
          source_type: meta.giveawaySource.sourceType,
          reason: parsed.reason,
          ledger_tx_id: ledgerTxId,
        },
      });
    } catch (err) {
      console.error(
        "[adjustBalance] giveaway-row write failed (ledger already committed):",
        err,
      );
    }
  }

  // Fire balance_fill webhooks (non-blocking)
  adminDb.creator_webhooks
    .findMany({
      where: { target_user_id: parsed.userId, type: "balance_fill", enabled: true },
    })
    .then((webhooks) => {
      for (const webhook of webhooks) {
        const isDiscord = webhook.url.includes("discord.com/api/webhooks/");
        const sign = parsed.amount >= 0 ? "+" : "";

        const body = isDiscord
          ? JSON.stringify({
              content: `💰 Balance adjusted on Pack.ygg — ${sign}$${parsed.amount.toFixed(2)} (new balance: $${newBalance.toFixed(2)}) — Reason: ${parsed.reason}`,
            })
          : JSON.stringify({
              event: "balance_fill",
              amount: parsed.amount,
              new_balance: newBalance,
              reason: parsed.reason,
              timestamp: new Date().toISOString(),
            });

        const signature = crypto
          .createHmac("sha256", webhook.secret)
          .update(body)
          .digest("hex");

        fetch(webhook.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Webhook-Signature": signature,
          },
          body,
          signal: AbortSignal.timeout(10000),
        }).catch((err) => {
          console.error(
            `[balance_fill_webhook] dispatch failed for ${webhook.url}:`,
            err instanceof Error ? err.message : err
          );
        });
      }
    })
    .catch((err) => {
      console.error(
        "[balance_fill_webhook] webhook query failed:",
        err instanceof Error ? err.message : err
      );
    });

  revalidatePath(`/users/${parsed.userId}`);
  return { success: true };
}

// ---------------------------------------------------------------------------
// Move whole balance → vault (instant, no unlock time)
// ---------------------------------------------------------------------------
//
// Vault on the platform = `balances.locked_balance` (the spendable balance
// is `balances.available_balance`). The platform already has `vault_lock` /
// `vault_unlock` ledger types for this movement; this action wraps that
// flow at the admin level so support can park a user's whole spendable
// balance instantly without going through the normal user-side flow.
//
// "Instant, no unlock time" => `unlock_at = null`. If the user already
// had locked balance with a future `unlock_at` set, that is overridden:
// the new pool of locked funds (old locked + the newly-moved available)
// becomes immediately unlockable. This matches the user-stated intent
// ("no unlock time, just instant") — admins want a one-click anti-tilt
// safety pause without committing the user to a fixed window.
//
// Total balance is unchanged. Reversible: admins can adjust back via
// the existing balance-adjust flow if needed.
export async function moveBalanceToVault(
  userId: string,
): Promise<
  | { success: true; movedAmount: number }
  | { success: false; error: string }
> {
  const db = await getDb();
  const session = await requirePageAccess("/users");
  // Reuses the same gate as the adjust-balance action — anyone with
  // permission to manipulate a user's balance is permitted to park
  // it in the vault. Admins always pass; non-admins need the explicit
  // capability on their role.
  if (session.role !== "admin") {
    const perms = await adminDb.admin_users.findUnique({
      where: { id: session.userId },
      select: { allowed_pages: true },
    });
    if (!perms || !canUserAdjustBalance(perms.allowed_pages)) {
      return {
        success: false,
        error: "You do not have permission to move balances to vault",
      };
    }
  }

  // Optimistic-locking transaction. Reads balance + version inside the
  // tx and aborts the update if the version moved between read and
  // write — keeps two concurrent moves (or a move racing with a
  // wager / admin adjust) from double-spending the available pool.
  let available = 0;
  try {
    await db.$transaction(async (tx) => {
      const b = await tx.balances.findUnique({ where: { user_id: userId } });
      if (!b) throw new Error("User has no balance row");

      available = Number(b.available_balance);
      if (available <= 0) {
        throw new Error("Available balance is already 0 — nothing to move");
      }

      const locked = Number(b.locked_balance);
      const newLocked = locked + available;

      const updated = await tx.balances.updateMany({
        where: { user_id: userId, version: b.version },
        data: {
          available_balance: 0,
          locked_balance: newLocked,
          // Per user spec: "no unlock time, just instant". Override
          // any existing unlock_at on the row so the whole locked
          // pool is admin-/user-controlled rather than time-gated.
          unlock_at: null,
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) {
        throw new Error("Balance changed concurrently — please retry");
      }

      await tx.ledger_transactions.create({
        data: {
          id: crypto.randomUUID(),
          user_id: userId,
          type: "vault_lock",
          // Negative because available_balance dropped by `available`.
          // The ledger's balance_before/after track available_balance
          // (matches the convention in adjustBalance).
          amount: -available,
          balance_before: available,
          balance_after: 0,
          description: "Admin moved entire balance to vault (no unlock time)",
          status: "completed",
        },
      });
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    if (
      message === "User has no balance row" ||
      message === "Available balance is already 0 — nothing to move" ||
      message.includes("concurrently")
    ) {
      return { success: false, error: message };
    }
    console.error("[moveBalanceToVault] transaction failed:", err);
    return {
      success: false,
      error: "Failed to move balance to vault — please try again",
    };
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "balance_moved_to_vault",
    targetUserId: userId,
    metadata: { amount: available, instant: true },
  });

  revalidatePath(`/users/${userId}`);
  return { success: true, movedAmount: available };
}

// ---------------------------------------------------------------------------
// Manual withdrawal — admin records an off-platform payout
// ---------------------------------------------------------------------------
//
// Use case: admin paid a user out via crypto / bank / card / etc. outside the
// normal `card_withdrawal_requests` flow. Without this action the on-site
// balance still says the user has the money, so the P&L formula
//
//   pnl = deposits − withdrawals − onSiteBalance − inventoryValue − vouchers
//
// would treat that money as still-owed to the user → P&L undercounts house
// gains and the dashboard "Liabilities" / per-user PnL tile is wrong.
//
// What this action does atomically:
//   1. Decrements `available_balance` by the payout amount (the user no
//      longer has it on-site — they got paid).
//   2. Increments `total_withdrawn` by the payout amount (so the P&L
//      `withdrawals` term picks it up via balances.total_withdrawn).
//   3. Writes a `ledger_transactions` row with a negative amount + a
//      "Manual withdrawal:" description prefix, so the user's transaction
//      history shows it. We use the existing `admin_balance_adjustment`
//      type so we don't need a schema migration; the description prefix
//      + audit event are how we identify these later.
//   4. Audit-logs `manual_withdrawal_recorded` with the amount + reason.
//
// Gates: requirePageAccess("/users") + (admin OR
// __can_record_manual_withdrawal capability) + 2FA + the same per-admin
// balance limit that gates adjustBalance (manual withdrawals count
// against the cap because they move user money around just like a
// balance adjustment does).
const manualWithdrawalSchema = z.object({
  userId: z.string(),
  // Same robust money rule as adjustBalance: finite, cent-precise, > 0.
  // Guards against the parseFloat-truncation class of bug on the
  // withdrawal amount too (shared Adjust-Balance dialog file).
  amountUsd: usdAmountSchema({ positive: true }),
  reason: z.string().min(1, "Reason is required"),
});

export async function recordManualWithdrawal(data: {
  userId: string;
  amountUsd: number;
  reason: string;
  totpCode: string;
}): Promise<{ success: true } | { success: false; error: string }> {
  const db = await getDb();
  const session = await requirePageAccess("/users");

  const parseResult = manualWithdrawalSchema.safeParse(data);
  if (!parseResult.success) {
    return {
      success: false,
      error: parseResult.error.issues[0]?.message ?? "Invalid input",
    };
  }
  const parsed = parseResult.data;

  // Admins always pass; non-admins need the dedicated capability.
  if (session.role !== "admin") {
    const perms = await adminDb.admin_users.findUnique({
      where: { id: session.userId },
      select: { allowed_pages: true },
    });
    if (
      !perms ||
      !hasCapability(perms.allowed_pages, "__can_record_manual_withdrawal")
    ) {
      return {
        success: false,
        error: "You do not have permission to record manual withdrawals",
      };
    }
  }

  try {
    await require2FA(session.userId, data.totpCode);
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "2FA verification failed",
    };
  }

  // Same throttle as adjustBalance — a manual withdrawal moves the same
  // dollars and shouldn't bypass the per-admin cap.
  try {
    await checkBalanceAdjustmentLimit(session.userId, parsed.amountUsd);
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Balance limit exceeded",
    };
  }

  // Optimistic-locking transaction. Reading balance + computing the
  // deduction amount must happen INSIDE the tx because a concurrent
  // wager / adjust could shrink available_balance between our read
  // and write — without locking we'd deduct from a stale snapshot
  // and either overdraw the user or under-bump total_withdrawn.
  let currentBalance = 0;
  let newBalance = 0;
  let balanceDeducted = 0;
  let phantomPortion = 0;
  try {
    await db.$transaction(async (tx) => {
      const b = await tx.balances.findUnique({
        where: { user_id: parsed.userId },
      });
      if (!b) throw new Error("User balances not found");

      currentBalance = Number(b.available_balance);

      // Two flavors of manual withdrawal, and we support both:
      //
      //   1. Live payout — user has the money on-site. We deduct from
      //      `available_balance` AND bump `total_withdrawn`. The
      //      `ledger_transactions` row reflects the actual balance delta
      //      (so the invariant `amount = balance_after - balance_before`
      //      holds). Mirrors a normal withdrawal, just outside the
      //      card_withdrawal_requests flow.
      //
      //   2. Backfill / P&L correction — user already received the
      //      money off-platform AND their on-site balance is gone (zero
      //      or smaller than the payout). We deduct whatever is there
      //      (could be 0) and bump `total_withdrawn` by the FULL recorded
      //      amount so the canonical P&L formula
      //          pnl = deposits − withdrawals − onSiteBalance − inv − vouch
      //      counts the payout. The "phantom" portion (amount minus what
      //      was actually deducted) is recorded in the audit event and
      //      called out in the ledger description so the discrepancy is
      //      auditable.
      //
      // We never let `available_balance` go negative — that would
      // misrepresent the user's debt-vs-credit relationship with the
      // platform and break wager-balance checks elsewhere.
      balanceDeducted = Math.min(currentBalance, parsed.amountUsd);
      newBalance = currentBalance - balanceDeducted;
      const newTotalWithdrawn =
        Number(b.total_withdrawn) + parsed.amountUsd;
      phantomPortion = parsed.amountUsd - balanceDeducted;

      const updated = await tx.balances.updateMany({
        where: { user_id: parsed.userId, version: b.version },
        data: {
          available_balance: newBalance,
          total_withdrawn: newTotalWithdrawn,
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) {
        throw new Error("Balance changed concurrently — please retry");
      }

      // Only write a ledger row when something was actually deducted
      // from on-site balance. A pure-record case (balance was 0,
      // payout fully phantom) gets recorded via the audit event and
      // total_withdrawn — writing a ledger row with amount=0 would
      // pollute transaction listings without conveying anything.
      if (balanceDeducted > 0) {
        await tx.ledger_transactions.create({
          data: {
            id: crypto.randomUUID(),
            user_id: parsed.userId,
            // Reuse the existing type — we don't have schema-write
            // access on the main DB; the "Manual withdrawal:"
            // prefix + audit event keep these distinguishable.
            type: "admin_balance_adjustment",
            amount: -balanceDeducted,
            balance_before: currentBalance,
            balance_after: newBalance,
            description:
              phantomPortion > 0
                ? `Manual withdrawal: ${parsed.reason} (total $${parsed.amountUsd.toFixed(2)}, $${balanceDeducted.toFixed(2)} from on-site)`
                : `Manual withdrawal: ${parsed.reason}`,
            status: "completed",
          },
        });
      }
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    if (
      message === "User balances not found" ||
      message.includes("concurrently")
    ) {
      return { success: false, error: message };
    }
    console.error("[recordManualWithdrawal] Transaction failed:", err);
    return {
      success: false,
      error: "Failed to record manual withdrawal — please try again",
    };
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "manual_withdrawal_recorded",
    targetUserId: parsed.userId,
    metadata: {
      amountUsd: parsed.amountUsd,
      reason: parsed.reason,
      balanceDeducted,
      phantomPortion,
      onSiteBalanceBefore: currentBalance,
    },
  });

  revalidatePath(`/users/${parsed.userId}`);
  return { success: true };
}

export async function changeRole(userId: string, newRole: string, totpCode: string) {
  const db = await getDb();
  // Role changes remain admin-only (+ 2FA). The capability check is kept as
  // defence-in-depth so `__can_change_user_roles` is catalogued; admins pass
  // automatically.
  const session = await requireAdmin();
  await requireCapability(session, "__can_change_user_roles", "change user roles");

  await require2FA(session.userId, totpCode);

  if (!["user", "support", "admin", "creator"].includes(newRole)) {
    throw new Error("Invalid role");
  }

  await db.user.update({
    where: { id: userId },
    data: { role: newRole as user_role },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "role_changed",
    targetUserId: userId,
    metadata: { new_role: newRole },
  });

  revalidatePath(`/users/${userId}`);
}

/**
 * Force-demote a creator back to "user" via BOTH the backend's demote
 * endpoint AND a direct DB write. Solves the bug where the /users/[id]
 * "Reset to User Role" escape hatch only flipped `user.role` locally —
 * leaving every backend-managed side effect of the original promote
 * (creator-deal balance fills, cached aggregations, creator session
 * state, etc.) intact. The result was: user shows up as "user" again,
 * but their previous creator-period numbers never came back to the
 * dashboard P&L because the promote-time mutations were never undone.
 *
 * Order:
 *   1) Best-effort `creatorsApi.demote()` — backend cleans up its
 *      state. Errors are caught + logged but do not abort the flow,
 *      because the whole reason this escape hatch exists is for the
 *      case where the backend silently no-ops.
 *   2) Always run the direct `user.role = 'user'` write so the role
 *      is GUARANTEED flipped even if the backend was unreachable.
 *   3) Audit-log both attempts so the trail is honest about what
 *      ran vs failed.
 */
export async function forceResetCreatorToUser(
  userId: string,
  totpCode: string,
): Promise<
  | { success: true; backendDemoted: boolean; backendError: string | null }
  | { success: false; error: string }
> {
  const db = await getDb();
  const session = await requireAdmin();
  await requireCapability(session, "__can_change_user_roles", "change user roles");
  await require2FA(session.userId, totpCode);

  // Step 1: best-effort backend demote. Capture the error but don't
  // surface it as a hard failure — the local role flip below is the
  // user-visible "did the role change" signal, and it always runs.
  let backendDemoted = false;
  let backendError: string | null = null;
  try {
    await creatorsApi.demote(userId);
    backendDemoted = true;
  } catch (err) {
    if (err instanceof BackendApiError) {
      backendError = err.code ? `${err.message} (${err.code})` : err.message;
    } else if (err instanceof Error) {
      backendError = err.message;
    } else {
      backendError = "Unknown backend error";
    }
  }

  // Step 2: local role flip. Always runs.
  await db.user.update({
    where: { id: userId },
    data: { role: "user" as user_role },
  });

  // Step 3: single audit row capturing both attempts.
  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "creator_force_reset_to_user",
    targetUserId: userId,
    metadata: {
      backend_demoted: backendDemoted,
      backend_error: backendError,
      via: "users_detail_escape_hatch",
    },
  });

  revalidatePath(`/users/${userId}`);
  revalidatePath("/creators");
  return { success: true, backendDemoted, backendError };
}

export async function updateUserIdentity(
  userId: string,
  data: {
    email?: string;
    username?: string;
    displayUsername?: string;
  },
): Promise<{ success: true } | { success: false; error: string }> {
  const db = await getDb();
  const session = await requirePageAccess("/users");
  await requireCapability(session, "__can_edit_identity", "edit user identity");

  const updateData: Record<string, unknown> = {};
  const metadata: Record<string, unknown> = {};

  if (data.email !== undefined) {
    const email = data.email.trim().toLowerCase();
    if (!email) return { success: false, error: "Email cannot be empty" };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { success: false, error: "Invalid email format" };
    }
    // Check uniqueness
    const existing = await db.user.findFirst({
      where: { email, id: { not: userId } },
      select: { id: true },
    });
    if (existing) return { success: false, error: "Email is already in use" };
    updateData.email = email;
    updateData.email_verified = true;
    metadata.email = email;
  }

  if (data.username !== undefined) {
    const username = data.username.trim();
    if (!username) return { success: false, error: "Username cannot be empty" };
    if (username.length < 3 || username.length > 20) {
      return { success: false, error: "Username must be 3–20 characters" };
    }
    // Check uniqueness
    const existing = await db.user.findFirst({
      where: { username, id: { not: userId } },
      select: { id: true },
    });
    if (existing) return { success: false, error: "Username is already taken" };
    updateData.username = username;
    metadata.username = username;
  }

  if (data.displayUsername !== undefined) {
    const displayUsername = data.displayUsername.trim() || null;
    updateData.display_username = displayUsername;
    metadata.display_username = displayUsername;
  }

  if (Object.keys(updateData).length === 0) {
    return { success: false, error: "Nothing to update" };
  }

  updateData.updated_at = new Date();

  try {
    await db.user.update({
      where: { id: userId },
      data: updateData,
    });
  } catch (err) {
    console.error("[updateUserIdentity] DB update failed:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return { success: false, error: `Update failed: ${message}` };
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "user_identity_updated",
    targetUserId: userId,
    metadata,
  });

  revalidatePath(`/users/${userId}`);
  revalidatePath("/users");
  return { success: true };
}

export async function toggleFeatureLock(
  userId: string,
  feature: string,
  locked: boolean
) {
  const db = await getDb();
  const session = await requirePageAccess("/users");
  await requireCapability(session, "__can_toggle_feature_locks", "toggle feature locks");

  const validFeatures = [
    "locked_withdrawals_crypto",
    "locked_withdrawals_items",
    "locked_inventory_sales",
    "locked_exchanges",
    "locked_openings",
    "locked_vault",
  ];
  if (!validFeatures.includes(feature)) throw new Error("Invalid feature");

  // locked_withdrawals_crypto is a String[] (not Boolean) — use ["all"] / []
  const value = feature === "locked_withdrawals_crypto"
    ? (locked ? ["all"] : [])
    : locked;

  const updateData: Record<string, unknown> = {
    [feature]: value,
  };

  // Set timestamps only — admin identity is tracked via audit events
  const byField = feature.startsWith("locked_withdrawals")
    ? "locked_withdrawals"
    : feature;
  updateData[`${byField}_at`] = locked ? new Date() : null;

  await db.user_feature_locks.upsert({
    where: { user_id: userId },
    update: updateData,
    create: {
      id: crypto.randomUUID(),
      user_id: userId,
      ...updateData,
    },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: locked ? `${feature}_enabled` : `${feature}_disabled`,
    targetUserId: userId,
    metadata: { feature, locked },
  });

  revalidatePath(`/users/${userId}`);
}

export async function fetchInventory(
  userId: string,
  page: number,
  perPage: number,
  filters?: {
    rarity?: string;
    status?: string;
    search?: string;
    sort?: string;
    priceMin?: number;
    priceMax?: number;
  }
) {
  await requirePageAccess("/users");
  return getUserInventory(userId, page, perPage, filters);
}

export async function getGameSessionDetails(
  gameSessionId: string,
  userId: string,
) {
  const db = await getDb();
  await requirePageAccess("/users");

  const session = await db.game_sessions.findUnique({
    where: { id: gameSessionId },
    include: {
      provably_fair_results: {
        include: {
          user_inventory: true,
        },
      },
    },
  });

  // Ownership check — without this, anyone with access to /users could
  // join across users by passing any session id (which leaks the
  // session's server seed via provably_fair_results). We compare against
  // the URL's userId rather than session.user_id so a wrong-page click
  // returns "not found" rather than silently rendering another user's
  // session. Returning null (same as a missing row) avoids leaking the
  // existence of the session to admins viewing the wrong user.
  if (!session || session.user_id !== userId) return null;

  // Fetch pack details if it's a pack opening
  let pack: { id: string; name: string; imageUrl: string | null } | null = null;
  if (session.game_type === "pack" && session.game_id) {
    const directPack = await db.packs.findUnique({
      where: { id: session.game_id },
      select: { id: true, name: true, image_url: true },
    });
    if (directPack) {
      pack = { id: directPack.id, name: directPack.name, imageUrl: directPack.image_url };
    } else {
      const userPack = await db.user_packs.findUnique({
        where: { id: session.game_id },
        include: {
          packs: { select: { id: true, name: true, image_url: true } },
        },
      });
      if (userPack?.packs) {
        pack = {
          id: userPack.packs.id,
          name: userPack.packs.name,
          imageUrl: userPack.packs.image_url,
        };
      }
    }
  }

  const inventoryItems = session.provably_fair_results
    .filter((r) => r.user_inventory)
    .map((r) => r.user_inventory!);

  const cardIds = [...new Set(inventoryItems.map((i) => i.card_id))];
  const cards = cardIds.length > 0
    ? await db.cards.findMany({
        where: { id: { in: cardIds } },
        select: { id: true, name: true, image_url: true, rarity: true, price: true },
      })
    : [];
  const cardMap = new Map(cards.map((c) => [c.id, c]));

  const items = inventoryItems.map((inv) => {
    const card = cardMap.get(inv.card_id);
    return {
      id: inv.id,
      cardName: card?.name ?? "Unknown",
      imageUrl: card?.image_url ?? null,
      rarity: card?.rarity ?? null,
      priceUsd: Number(card?.price ?? 0),
      valueAtObtained: Number(inv.value_at_obtained),
    };
  });

  const pfResults = session.provably_fair_results.map((r) => ({
    id: r.id,
    clientSeed: r.client_seed,
    serverSeedHash: r.server_seed_hash,
    serverSeed: r.server_seed,
    nonce: r.nonce,
    cursor: r.cursor,
    ticket: r.ticket,
    resultHash: r.result_hash,
  }));

  return {
    id: session.id,
    gameType: session.game_type,
    result: session.result,
    betAmount: Number(session.bet_amount),
    pack,
    items,
    pfResults,
    createdAt: session.created_at.toISOString(),
  };
}

const withdrawalLimitsSchema = z.object({
  userId: z.string(),
  currencyLimitAmount: z.number().nullable(),
  currencyLimitStartDate: z.string().nullable(),
  currencyLimitResetDays: z.number().int().nullable(),
  percentageLimit: z.number().nullable(),
});

export async function updateWithdrawalLimits(data: {
  userId: string;
  currencyLimitAmount: number | null;
  currencyLimitStartDate: string | null;
  currencyLimitResetDays: number | null;
  percentageLimit: number | null;
}) {
  const db = await getDb();
  const session = await requireAdmin();
  await requireCapability(session, "__can_update_user_withdrawal_limits", "update user withdrawal limits");
  const parsed = withdrawalLimitsSchema.parse(data);

  await db.creator_withdrawal_limits.upsert({
    where: { user_id: parsed.userId },
    update: {
      currency_limit_amount: parsed.currencyLimitAmount,
      currency_limit_start_date: parsed.currencyLimitStartDate ? new Date(parsed.currencyLimitStartDate) : null,
      currency_limit_reset_days: parsed.currencyLimitResetDays,
      percentage_limit: parsed.percentageLimit,
      updated_at: new Date(),
    },
    create: {
      id: crypto.randomUUID(),
      user_id: parsed.userId,
      currency_limit_amount: parsed.currencyLimitAmount,
      currency_limit_start_date: parsed.currencyLimitStartDate ? new Date(parsed.currencyLimitStartDate) : null,
      currency_limit_reset_days: parsed.currencyLimitResetDays,
      percentage_limit: parsed.percentageLimit,
    },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "creator_withdrawal_limits_updated",
    targetUserId: parsed.userId,
    metadata: {
      currencyLimitAmount: parsed.currencyLimitAmount,
      currencyLimitStartDate: parsed.currencyLimitStartDate,
      currencyLimitResetDays: parsed.currencyLimitResetDays,
      percentageLimit: parsed.percentageLimit,
    },
  });

  revalidatePath(`/users/${parsed.userId}`);
}

export async function fetchCreatorClicks(
  affiliateCode: string,
  page: number,
  perPage: number
) {
  await requirePageAccess("/users");
  return getCreatorReferralClicks(affiliateCode, page, perPage);
}

export async function fetchCreatorCodeUsages(
  userId: string,
  page: number,
  perPage: number
) {
  await requirePageAccess("/users");
  return getCreatorCodeUsages(userId, page, perPage);
}

/**
 * Lazy fetch of a user's attribution journey (the affiliate/creator codes
 * they hopped through + per-code deposits & wager). Loaded on demand when
 * the affiliate tab mounts so it never burdens the always-rendered page
 * payload. `unstable_cache` keyed per user (60s) collapses repeat renders /
 * refreshes; `safeQuery` (4s) degrades a slow acu scan to an empty journey
 * + error flag instead of blocking the tab. Read-only Main-DB query.
 */
export async function fetchUserAttributionJourney(
  userId: string,
): Promise<{ data: AttributionJourneyEntry[]; error: string | null }> {
  await requirePageAccess("/users");
  return safeQuery(
    () =>
      unstable_cache(
        () => getUserAttributionJourney(userId),
        ["user-attribution-journey-v1", userId],
        { revalidate: 60, tags: [`user-attribution-${userId}`] },
      )(),
    [] as AttributionJourneyEntry[],
    `users.attribution-journey.${userId}`,
    4000,
  );
}

export async function assignAffiliateCode(userId: string, affiliateCode: string | null) {
  const db = await getDb();
  const session = await requirePageAccess("/users");
  await requireCapability(session, "__can_assign_affiliate", "assign affiliate codes");

  if (!affiliateCode || affiliateCode.trim() === "") {
    // Find current referrer to decrement their total_referred
    const currentUser = await db.user.findUnique({
      where: { id: userId },
      select: { referred_by: true },
    });

    await db.user.update({
      where: { id: userId },
      data: {
        referred_by: null,
        // Clearing reverts BOTH columns: drop the active code too so
        // wager income stops routing to the old owner, and leave no
        // lock behind.
        affiliate_code: null,
        affiliate_code_active: false,
        affiliate_code_expires_at: null,
      },
    });

    if (currentUser?.referred_by) {
      await db.affiliate_accounts.update({
        where: { user_id: currentUser.referred_by },
        data: { total_referred: { decrement: 1 } },
      });
    }

    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "affiliate_code_cleared",
      targetUserId: userId,
      metadata: {},
    });

    revalidatePath(`/users/${userId}`);
    if (currentUser?.referred_by) revalidatePath(`/users/${currentUser.referred_by}`);
    return { success: true };
  }

  const codeRecord = await db.affiliate_codes.findUnique({
    where: { code: affiliateCode.trim() },
  });

  if (!codeRecord) {
    throw new Error("Affiliate code not found");
  }

  if (codeRecord.user_id === userId) {
    throw new Error("Cannot assign a user to their own affiliate code");
  }

  await db.$transaction([
    db.user.update({
      where: { id: userId },
      data: {
        // Formal attribution — WHO referred this user in.
        referred_by: codeRecord.user_id,
        // The ACTIVE code the user is "on" right now. This is the field
        // the backend reads to route WAGER affiliate income to the
        // code's owner — setting referred_by alone does NOT move wager
        // income (referred_by is just the permanent attribution).
        // Store the canonical code string (exact case from the codes
        // table), not the raw admin input.
        affiliate_code: codeRecord.code,
        affiliate_code_active: true,
        // No frontend lock on an admin override: a null expiry leaves
        // the code active for attribution while letting the user change
        // it again on the site. (The 1h lock only applies to fresh
        // frontend entries; setting a code here REPLACES any pending
        // lock.)
        affiliate_code_expires_at: null,
      },
    }),
    db.affiliate_accounts.update({
      where: { user_id: codeRecord.user_id },
      data: { total_referred: { increment: 1 } },
    }),
    db.affiliate_code_usages.create({
      data: {
        affiliate_user_id: codeRecord.user_id,
        code: codeRecord.code,
        referred_user_id: userId,
        usage_type: "deposit",
      },
    }),
  ]);

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "affiliate_code_assigned",
    targetUserId: userId,
    metadata: { affiliateCode: affiliateCode.trim(), affiliateOwnerId: codeRecord.user_id },
  });

  revalidatePath(`/users/${userId}`);
  revalidatePath(`/users/${codeRecord.user_id}`);
  return { success: true };
}

/**
 * Result shape for createAffiliateCode. Returns a structured "conflict"
 * object when the code is already owned by someone else so the UI can
 * offer a transfer flow instead of just showing an error toast.
 */
export type CreateAffiliateCodeResult =
  | { success: true }
  | { success: false; error: string }
  | {
      success: false;
      conflict: {
        currentOwnerId: string;
        currentOwnerUsername: string | null;
        currentOwnerEmail: string | null;
        code: string;
      };
    };

export async function createAffiliateCode(
  userId: string,
  code: string,
): Promise<CreateAffiliateCodeResult> {
  const db = await getDb();
  const session = await requirePageAccess("/users");
  await requireCapability(session, "__can_assign_affiliate", "create affiliate codes");
  const trimmed = code.trim();
  if (!trimmed) return { success: false, error: "Code cannot be empty" };

  // SCHEMA NOTE (per src/lib/queries/creators-detail.ts:58):
  //   user.affiliate_code = the referral cookie this user is CARRYING
  //                          (i.e. the code they USED, set when they
  //                          clicked someone else's referral link)
  //   affiliate_codes      = the codes this user OWNS
  // Earlier versions of this action wrote `user.affiliate_code = trimmed`
  // when creating a new owned code — confusing the cookie field with
  // ownership. The result was /users/[id] showing the cookie ("twitter")
  // labeled as the user's own code while /creators/[id] correctly
  // showed the owned code from affiliate_codes ("wynn"). This action
  // now ONLY writes to affiliate_codes; user.affiliate_code stays
  // untouched (it belongs to the backend's referral-cookie machinery).
  //
  //   - taken by ANOTHER user → return a structured conflict so the
  //     UI can prompt for a transfer
  //   - already owned by THIS user → no-op success (the row already
  //     exists; nothing to do)
  const existingCode = await db.affiliate_codes.findUnique({
    where: { code: trimmed },
    select: { user_id: true },
  });
  if (existingCode) {
    if (existingCode.user_id === userId) {
      return { success: true };
    }
    const owner = await db.user.findUnique({
      where: { id: existingCode.user_id },
      select: { id: true, username: true, email: true },
    });
    return {
      success: false,
      conflict: {
        currentOwnerId: existingCode.user_id,
        currentOwnerUsername: owner?.username ?? null,
        currentOwnerEmail: owner?.email ?? null,
        code: trimmed,
      },
    };
  }

  await db.$transaction([
    db.affiliate_accounts.upsert({
      where: { user_id: userId },
      create: { user_id: userId },
      update: {},
    }),
    db.affiliate_codes.create({
      data: {
        user_id: userId,
        code: trimmed,
      },
    }),
  ]);

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "affiliate_code_created",
    targetUserId: userId,
    metadata: { code: trimmed },
  });

  revalidatePath(`/users/${userId}`);
  revalidatePath(`/creators/${userId}`);
  return { success: true };
}

/**
 * Generate a unique random replacement affiliate code. Used by
 * `transferAffiliateCode` to give the previous owner a non-empty code
 * so they're never left without one. Uses confusable-free alphabet
 * (no I/L/O/0/1) and retries on the (extremely unlikely) collision.
 */
async function generateRandomAffiliateCode(
  db: Awaited<ReturnType<typeof getDb>>,
): Promise<string> {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const length = 10;
  for (let attempt = 0; attempt < 8; attempt++) {
    let code = "";
    for (let i = 0; i < length; i++) {
      code += alphabet[crypto.randomInt(0, alphabet.length)];
    }
    const exists = await db.affiliate_codes.findUnique({
      where: { code },
      select: { user_id: true },
    });
    if (!exists) return code;
  }
  throw new Error("Could not generate a unique replacement affiliate code");
}

/**
 * Transfer ownership of an affiliate code from its current owner to
 * a target user. The previous owner gets a random replacement code
 * (so they're never codeless), the target user adopts the code as
 * their current `affiliate_code`.
 *
 * Per the user's spec: this transfers the CODE STRING only, not the
 * historical earnings/usage data. `affiliate_code_usages` rows still
 * point at the original `affiliate_user_id` so previous referrals stay
 * attributed to the previous owner. `affiliate_clicks` rows are keyed
 * by code string only, so click history WILL appear under the new
 * owner — there's no per-click `user_id` snapshot to preserve.
 *
 * Operations (single transaction):
 *   1. Re-point the existing affiliate_codes row's user_id to the new
 *      target — preserves the row's `created_at` and history.
 *   2. Create a fresh affiliate_codes row for the previous owner with
 *      a random replacement code.
 *   3. Ensure both users have an affiliate_accounts row.
 *   4. Set new owner's user.affiliate_code = transferred code.
 *   5. Set previous owner's user.affiliate_code = random replacement.
 */
export async function transferAffiliateCode(args: {
  toUserId: string;
  code: string;
  totpCode: string;
}): Promise<
  | { success: true; replacementCode: string; previousOwnerId: string }
  | { success: false; error: string }
> {
  const db = await getDb();
  const session = await requirePageAccess("/users");
  await requireCapability(session, "__can_assign_affiliate", "transfer affiliate codes");

  // 2FA gate — transferring an affiliate code reassigns the future
  // referral revenue stream of the code, so we lift it to the same
  // protection tier as a balance adjustment / role change.
  try {
    await require2FA(session.userId, args.totpCode);
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "2FA verification failed",
    };
  }

  const code = args.code.trim();
  if (!code) return { success: false, error: "Code cannot be empty" };
  if (!z.string().uuid().or(z.string().min(8)).safeParse(args.toUserId).success) {
    return { success: false, error: "Invalid target user id" };
  }

  // Verify current ownership and target user exist + are different.
  const codeRow = await db.affiliate_codes.findUnique({
    where: { code },
    select: { id: true, user_id: true },
  });
  if (!codeRow) {
    return {
      success: false,
      error: "That code doesn't exist anymore — refresh and try again",
    };
  }
  if (codeRow.user_id === args.toUserId) {
    return { success: false, error: "Target user already owns that code" };
  }
  const target = await db.user.findUnique({
    where: { id: args.toUserId },
    select: { id: true },
  });
  if (!target) return { success: false, error: "Target user not found" };

  const previousOwnerId = codeRow.user_id;
  const replacementCode = await generateRandomAffiliateCode(db);

  await db.$transaction(async (tx) => {
    // Move the code row to the target user.
    await tx.affiliate_codes.update({
      where: { id: codeRow.id },
      data: { user_id: args.toUserId, updated_at: new Date() },
    });
    // Give the previous owner a random replacement code.
    await tx.affiliate_codes.create({
      data: { user_id: previousOwnerId, code: replacementCode },
    });
    // Make sure both sides have an affiliate_accounts row.
    await tx.affiliate_accounts.upsert({
      where: { user_id: args.toUserId },
      create: { user_id: args.toUserId },
      update: {},
    });
    await tx.affiliate_accounts.upsert({
      where: { user_id: previousOwnerId },
      create: { user_id: previousOwnerId },
      update: {},
    });
    // Note: deliberately NOT touching user.affiliate_code on either
    // side. user.affiliate_code is the referral cookie this user is
    // CARRYING (set by the backend when they click someone's link),
    // not an indicator of which code they own. Code ownership lives
    // entirely in affiliate_codes — moving the row + creating the
    // replacement is the full transfer.
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "affiliate_code_transferred",
    targetUserId: args.toUserId,
    metadata: {
      code,
      previousOwnerId,
      replacementCode,
      // Note that 2FA was used to authorise this transfer — useful when
      // reading the trail later because we can distinguish 2FA-gated
      // actions from older transfers that bypassed the check.
      two_factor_verified: true,
    },
  });

  revalidatePath(`/users/${args.toUserId}`);
  revalidatePath(`/users/${previousOwnerId}`);
  return { success: true, replacementCode, previousOwnerId };
}

const adjustXpSchema = z.object({
  userId: z.string(),
  amount: z.number(),
  reason: z.string().min(1),
});

export async function adjustXp(data: {
  userId: string;
  amount: number;
  reason: string;
}) {
  const db = await getDb();
  const session = await requirePageAccess("/users");
  await requireCapability(session, "__can_adjust_xp", "adjust user XP");
  const parsed = adjustXpSchema.parse(data);

  const stats = await db.user_statistics.findUnique({
    where: { user_id: parsed.userId },
  });
  if (!stats) throw new Error("User statistics not found");

  const currentXp = Number(stats.xp);
  const newXp = Math.max(0, currentXp + parsed.amount);

  await db.user_statistics.update({
    where: { user_id: parsed.userId },
    data: { xp: newXp },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "xp_adjustment",
    targetUserId: parsed.userId,
    metadata: { amount: parsed.amount, previousXp: currentXp, newXp, reason: parsed.reason },
  });

  revalidatePath(`/users/${parsed.userId}`);
}

export async function fetchUserTransactions(
  userId: string,
  page: number,
  perPage: number,
  filters?: { type?: string; types?: string[]; status?: string; dateFrom?: string; dateTo?: string }
) {
  await requirePageAccess("/users");
  return getUserTransactions(userId, page, perPage, filters);
}

export async function fetchProvablyFairResults(
  userId: string,
  page: number,
  perPage: number,
  filters?: { search?: string; gameType?: string }
) {
  await requirePageAccess("/users");
  return getProvablyFairResults(userId, page, perPage, filters);
}

export async function fetchSeedRotationHistory(
  userId: string,
  page: number,
  perPage: number
) {
  await requirePageAccess("/users");
  return getSeedRotationHistory(userId, page, perPage);
}

export async function fetchBalanceHistory(userId: string) {
  await requirePageAccess("/users");
  return getUserBalanceHistory(userId);
}

export async function fetchCreatorWithdrawalLimits(userId: string) {
  await requirePageAccess("/users");
  return getCreatorWithdrawalLimits(userId);
}

// ---------------------------------------------------------------------------
// Per-user battle limit overrides (highroller / VIP support)
// ---------------------------------------------------------------------------
//
// Each field is independently nullable: null means "fall back to site_config
// default" (`battle_max_value_usd` / `battle_base_bet_limit_usd`). The
// backend resolution lives in CreationService.createBattle and applies the
// override-or-default per column at battle creation time.
//
// Admin-only — battle limits move real money exposure (the backend uses them
// to gate `total_cost > maxBattleValueUsd` checks), so we keep them behind
// `requireAdmin()` rather than a softer page-access gate.

const userBattleLimitsSchema = z.object({
  userId: z.string().min(1),
  maxValueUsd: z.number().positive().nullable(),
  baseBetLimitUsd: z.number().positive().nullable(),
});

export async function updateUserBattleLimits(data: {
  userId: string;
  maxValueUsd: number | null;
  baseBetLimitUsd: number | null;
}): Promise<{ success: true } | { success: false; error: string }> {
  const db = await getDb();
  const session = await requireAdmin();

  const parseResult = userBattleLimitsSchema.safeParse(data);
  if (!parseResult.success) {
    return {
      success: false,
      error: parseResult.error.issues[0]?.message ?? "Invalid input",
    };
  }
  const parsed = parseResult.data;

  try {
    await db.user_battle_limits.upsert({
      where: { user_id: parsed.userId },
      update: {
        max_value_usd: parsed.maxValueUsd,
        base_bet_limit_usd: parsed.baseBetLimitUsd,
        updated_at: new Date(),
      },
      create: {
        id: crypto.randomUUID(),
        user_id: parsed.userId,
        max_value_usd: parsed.maxValueUsd,
        base_bet_limit_usd: parsed.baseBetLimitUsd,
      },
    });
  } catch (err) {
    console.error("[updateUserBattleLimits] upsert failed:", err);
    return { success: false, error: "Failed to update battle limits" };
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "user_battle_limits_updated",
    targetUserId: parsed.userId,
    metadata: {
      maxValueUsd: parsed.maxValueUsd,
      baseBetLimitUsd: parsed.baseBetLimitUsd,
    },
  });

  revalidatePath(`/users/${parsed.userId}`);
  return { success: true };
}

export async function clearUserBattleLimits(
  userId: string,
): Promise<{ success: true } | { success: false; error: string }> {
  const db = await getDb();
  const session = await requireAdmin();

  if (!userId || typeof userId !== "string") {
    return { success: false, error: "Invalid user id" };
  }

  try {
    // deleteMany is idempotent — count: 0 when no row exists, no throw.
    // Matches the removeUserTag pattern so a double-click on "Clear"
    // can't crash the page.
    await db.user_battle_limits.deleteMany({ where: { user_id: userId } });
  } catch (err) {
    console.error("[clearUserBattleLimits] delete failed:", err);
    return { success: false, error: "Failed to clear battle limits" };
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "user_battle_limits_cleared",
    targetUserId: userId,
    metadata: {},
  });

  revalidatePath(`/users/${userId}`);
  return { success: true };
}

// ---------------------------------------------------------------------------
// Wipe Account Data — Alt Account Cleanup
// ---------------------------------------------------------------------------
// Permanently deletes ALL user activity data while keeping the User row and
// account (OAuth) rows intact. Designed for alt account cleanup where the
// admin wants to nuke everything so the alt cannot benefit from existing
// data. Ledger transactions are included in the wipe.
//
// Deletion order is dictated by FK constraints — see the plan file for the
// full dependency graph. Everything runs inside a single interactive
// $transaction so it's all-or-nothing.
// ---------------------------------------------------------------------------

// Validate the userId at the boundary — the wipe is destructive so we
// don't want a malformed string sneaking past the dialog's confirmation
// flow and matching some other unintended row by accident.
const wipeUserAccountSchema = z.object({
  userId: z.string().uuid(),
  totpCode: z.string().min(1),
  displayName: z.string().min(1, "Display name confirmation required"),
});

export async function wipeUserAccount(
  userId: string,
  totpCode: string,
  displayName: string,
): Promise<{ success: true } | { success: false; error: string }> {
  const db = await getDb();
  const session = await requireAdmin();
  await requireCapability(session, "__can_wipe_accounts", "wipe user account data");

  // Boundary validation — UUID userId, non-empty totp + displayName.
  const parseResult = wipeUserAccountSchema.safeParse({
    userId,
    totpCode,
    displayName,
  });
  if (!parseResult.success) {
    return {
      success: false,
      error: parseResult.error.issues[0]?.message ?? "Invalid input",
    };
  }
  const parsed = parseResult.data;

  // 2FA gate — verify the calling admin's TOTP code BEFORE doing anything
  // destructive. Mirrors the pattern used by deleteUser / changeRole.
  try {
    await require2FA(session.userId, parsed.totpCode);
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Invalid 2FA code",
    };
  }

  // Verify the user exists. Pull display_username so the server-side
  // displayName check matches the resolution order the WipeAccountButton
  // uses on the client (display_username → username → email → id).
  const user = await db.user.findUnique({
    where: { id: parsed.userId },
    select: {
      id: true,
      username: true,
      display_username: true,
      email: true,
    },
  });
  if (!user) return { success: false, error: "User not found" };

  // Server-side displayName confirmation — exact-match (after trim) on
  // the same fallback chain the client renders. This guards against the
  // case where someone calls the action programmatically without going
  // through the dialog's type-to-confirm gate.
  const expectedDisplayName =
    user.display_username ?? user.username ?? user.email ?? user.id;
  if (parsed.displayName.trim() !== expectedDisplayName) {
    return {
      success: false,
      error: "Display name confirmation does not match",
    };
  }

  // Audit BEFORE the wipe — if the transaction fails, the attempt is still logged
  try {
    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "user_account_wiped",
      targetUserId: parsed.userId,
      metadata: {
        username: user.username,
        display_username: user.display_username,
        email: user.email,
        confirmed_display_name: expectedDisplayName,
      },
    });
  } catch (err) {
    console.error("[wipeUserAccount] Failed to create audit event:", err);
    return { success: false, error: "Failed to create audit event" };
  }

  try {
    await db.$transaction(async (tx) => {
      // ── Phase 1: Null out references in shared/other-user tables ──────
      await tx.raffles.updateMany({
        where: { winner_user_id: userId },
        data: { winner_user_id: null },
      });
      await tx.rains.updateMany({
        where: { winner_user_id: userId },
        data: { winner_user_id: null },
      });
      await tx.gift_cards.updateMany({
        where: { redeemed_by_user_id: userId },
        data: { redeemed_by_user_id: null, ledger_tx_id: null },
      });
      await tx.audit_events.updateMany({
        where: { user_id: userId },
        data: { user_id: null },
      });
      await tx.fingerprints.updateMany({
        where: { user_id: userId },
        data: { user_id: null },
      });
      await tx.chat_messages.updateMany({
        where: { deleted_by: userId },
        data: { deleted_by: null },
      });
      // card_withdrawal_requests — null out admin actor refs
      await tx.card_withdrawal_requests.updateMany({
        where: { confirmed_by: userId },
        data: { confirmed_by: null },
      });
      await tx.card_withdrawal_requests.updateMany({
        where: { processed_by: userId },
        data: { processed_by: null },
      });
      await tx.card_withdrawal_requests.updateMany({
        where: { shipped_by: userId },
        data: { shipped_by: null },
      });
      // user_feature_locks — null out admin actor refs on OTHER users' locks
      await tx.user_feature_locks.updateMany({
        where: { locked_deposits_by: userId },
        data: { locked_deposits_by: null },
      });
      await tx.user_feature_locks.updateMany({
        where: { locked_exchanges_by: userId },
        data: { locked_exchanges_by: null },
      });
      await tx.user_feature_locks.updateMany({
        where: { locked_inventory_sales_by: userId },
        data: { locked_inventory_sales_by: null },
      });
      await tx.user_feature_locks.updateMany({
        where: { locked_openings_by: userId },
        data: { locked_openings_by: null },
      });
      await tx.user_feature_locks.updateMany({
        where: { locked_vault_by: userId },
        data: { locked_vault_by: null },
      });
      await tx.user_feature_locks.updateMany({
        where: { locked_withdrawals_by: userId },
        data: { locked_withdrawals_by: null },
      });
      await tx.user_mutes.updateMany({
        where: { unmuted_by: userId },
        data: { unmuted_by: null },
      });

      // ── Phase 2: Delete leaf tables (reference other user tables) ─────
      await tx.provably_fair_results.deleteMany({
        where: {
          OR: [
            { game_sessions: { user_id: userId } },
            { battles: { user_id: userId } },
            { user_inventory: { user_id: userId } },
          ],
        },
      });
      await tx.battle_participants.deleteMany({
        where: {
          OR: [
            { user_id: userId },
            { battles: { user_id: userId } },
          ],
        },
      });
      await tx.affiliate_code_usages.deleteMany({
        where: {
          OR: [
            { affiliate_user_id: userId },
            { referred_user_id: userId },
          ],
        },
      });
      await tx.race_claims.deleteMany({ where: { user_id: userId } });
      await tx.rakeback_claims.deleteMany({ where: { user_id: userId } });
      await tx.promo_code_redemptions.deleteMany({ where: { user_id: userId } });
      await tx.pinned_chat_messages.deleteMany({ where: { pinned_by: userId } });

      // ── Phase 3: Zero balances + clear ledger FK, then delete game_sessions
      // Balances row is KEPT (zeroed) — deleting it would break the backend
      // ("Balance not found" errors). We null out last_transaction_id first
      // so the ledger_transactions delete in Phase 4 doesn't hit FK constraints.
      await tx.balances.updateMany({
        where: { user_id: userId },
        data: {
          available_balance: 0,
          locked_balance: 0,
          total_deposited: 0,
          total_withdrawn: 0,
          total_wagered: 0,
          total_won: 0,
          bonus_points: 0,
          last_transaction_id: null,
          unlock_at: null,
          version: 1,
          updated_at: new Date(),
        },
      });
      await tx.game_sessions.deleteMany({ where: { user_id: userId } });

      // ── Phase 4: Delete ledger_transactions ───────────────────────────
      await tx.ledger_transactions.deleteMany({ where: { user_id: userId } });

      // ── Phase 5: Delete remaining parent tables ───────────────────────
      // Vaults + deposit_addresses are KEPT (crypto infra must survive).
      await tx.battles.deleteMany({ where: { user_id: userId } });
      await tx.user_inventory.deleteMany({ where: { user_id: userId } });
      await tx.chat_messages.deleteMany({ where: { user_id: userId } });

      // ── Phase 6: Delete all standalone tables ─────────────────────────
      await tx.raffle_entries.deleteMany({ where: { user_id: userId } });
      await tx.rain_entries.deleteMany({ where: { user_id: userId } });
      await tx.rain_tips.deleteMany({ where: { user_id: userId } });
      await tx.user_rewards.deleteMany({ where: { user_id: userId } });
      await tx.wager_period_snapshots.deleteMany({ where: { user_id: userId } });
      await tx.race_leaderboard_snapshots.deleteMany({ where: { user_id: userId } });
      // user_statistics — KEPT (zeroed) to avoid "stats not found" errors
      await tx.user_statistics.updateMany({
        where: { user_id: userId },
        data: {
          opened_packs_count: 0,
          battles_played: 0,
          xp: 0,
          level: 0,
          current_day_wagered_usd: 0,
          current_week_wagered_usd: 0,
          current_month_wagered_usd: 0,
          last_wagered_at: null,
          weekly_wager_count: 0,
          updated_at: new Date(),
        },
      });
      await tx.pack_favorites.deleteMany({ where: { user_id: userId } });
      await tx.seed_rotation_history.deleteMany({ where: { user_id: userId } });
      await tx.user_packs.deleteMany({ where: { user_id: userId } });
      await tx.user_mutes.deleteMany({
        where: { OR: [{ user_id: userId }, { muted_by: userId }] },
      });
      // user_feature_locks (user's own) — KEPT per admin request
      await tx.card_withdrawal_requests.deleteMany({ where: { user_id: userId } });
      await tx.shipping_addresses.deleteMany({ where: { user_id: userId } });
      // deposit_addresses — KEPT (crypto infra)
      await tx.vouchers.deleteMany({ where: { user_id: userId } });
      await tx.affiliate_accounts.deleteMany({ where: { user_id: userId } });
      await tx.affiliate_codes.deleteMany({ where: { user_id: userId } });
      await tx.affiliate_code_queue.deleteMany({ where: { user_id: userId } });
      await tx.affiliate_payouts.deleteMany({ where: { affiliate_user_id: userId } });
      await tx.session.deleteMany({ where: { userId } });
      // two_factor + active_seeds — KEPT (auth/provably-fair infra)
      await tx.creator_withdrawal_limits.deleteMany({ where: { user_id: userId } });

      // ── Phase 7: Reset User row ──────────────────────────────────────
      await tx.user.update({
        where: { id: userId },
        data: {
          affiliate_code: null,
          affiliate_code_expires_at: null,
          affiliate_code_active: false,
          affiliate_bonus_opted_in: false,
          referred_by: null,
          is_locked: false,
          locked_reason: null,
          locked_at: null,
          locked_until: null,
          locked_by: null,
          is_banned: false,
          banned_reason: null,
          banned_at: null,
          banned_by: null,
          is_suspected_alt: false,
          suspected_alt_at: null,
          updated_at: new Date(),
        },
      });
    }, { timeout: 60_000 });
  } catch (err) {
    console.error("[wipeUserAccount] Transaction failed:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return { success: false, error: `Wipe failed: ${message}` };
  }

  revalidatePath(`/users/${userId}`);
  revalidatePath("/users");
  return { success: true };
}

// ---------------------------------------------------------------------------
// VIP Tags — admin-CRM metadata on packy.gg users
// ---------------------------------------------------------------------------
// Two-tag system today (Contacted VIP / Confirmed VIP). Stored in the
// admin DB only — no main-DB write. The full set lives in the
// `admin_user_tags` table; this action only knows about the allow-listed
// tag values. Adding a new tag = update both the Zod enum here AND the
// CHECK constraint in
// prisma/admin/migrations/20260513000000_admin_user_tags/migration.sql.

const USER_TAG_VALUES = ["contacted_vip", "confirmed_vip"] as const;
export type UserTagValue = (typeof USER_TAG_VALUES)[number];

const userTagSchema = z.object({
  userId: z.string().min(1),
  tag: z.enum(USER_TAG_VALUES),
});

/**
 * Idempotent tag-set. Upserts the (user, tag) pair — re-tagging the
 * same user is a no-op at the DB level (unique index handles it).
 * Audit-logs the assignment with the admin who set it.
 */
export async function setUserTag(
  userId: string,
  tag: UserTagValue,
): Promise<{ success: true } | { success: false; error: string }> {
  const session = await requirePageAccess("/users");
  await requireCapability(
    session,
    "__can_manage_user_tags",
    "manage user tags",
  );

  const parsed = userTagSchema.safeParse({ userId, tag });
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  try {
    await adminDb.admin_user_tags.upsert({
      where: {
        target_user_id_tag: {
          target_user_id: parsed.data.userId,
          tag: parsed.data.tag,
        },
      },
      update: {},
      create: {
        target_user_id: parsed.data.userId,
        tag: parsed.data.tag,
        set_by_admin_id: session.userId,
      },
    });
  } catch (err) {
    console.error("[setUserTag] upsert failed:", err);
    return { success: false, error: "Failed to set tag" };
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "user_tag_set",
    targetUserId: parsed.data.userId,
    metadata: { tag: parsed.data.tag },
  });

  revalidatePath(`/users/${parsed.data.userId}`);
  return { success: true };
}

/**
 * Remove a single (user, tag) pair. Idempotent — `deleteMany` returns
 * `{ count: 0 }` instead of throwing P2025 when the row is already
 * gone, so a double-click on the toggle can't crash the page.
 */
export async function removeUserTag(
  userId: string,
  tag: UserTagValue,
): Promise<{ success: true } | { success: false; error: string }> {
  const session = await requirePageAccess("/users");
  await requireCapability(
    session,
    "__can_manage_user_tags",
    "manage user tags",
  );

  const parsed = userTagSchema.safeParse({ userId, tag });
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  try {
    const result = await adminDb.admin_user_tags.deleteMany({
      where: {
        target_user_id: parsed.data.userId,
        tag: parsed.data.tag,
      },
    });

    if (result.count > 0) {
      await createAdminAuditEvent({
        adminUserId: session.userId,
        eventType: "user_tag_removed",
        targetUserId: parsed.data.userId,
        metadata: { tag: parsed.data.tag },
      });
    }
  } catch (err) {
    console.error("[removeUserTag] delete failed:", err);
    return { success: false, error: "Failed to remove tag" };
  }

  revalidatePath(`/users/${parsed.data.userId}`);
  return { success: true };
}
