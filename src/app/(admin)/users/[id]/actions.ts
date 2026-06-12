"use server";

import crypto from "crypto";
import { revalidatePath, revalidateTag, unstable_cache } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { adminDb } from "@/lib/admin-db";
import { requireAdmin, requirePageAccess } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { Prisma, user_role } from "@/generated/prisma/client";
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
import { COINS_PER_USD } from "@/lib/constants";
import {
  BALANCE_ADJUSTMENT_CATEGORY_KEYS,
  BUGS_ADJUSTMENT_MIN_REASON_CHARS,
  REMOVE_LOCKED_BALANCE_MIN_REASON_CHARS,
  FRAUD_ABUSE_MIN_REASON_CHARS,
  isBalanceAdjustmentCategory,
  isCreatorLinkedAdjustmentCategory,
  isRemovalOnlyAdjustmentCategory,
  type BalanceAdjustmentCategory,
} from "@/lib/balance-adjustment-categories";
import type { SessionPayload } from "@/lib/session";
import { ensureBalanceAdjustmentMetaSchema } from "@/lib/balance-adjustment-meta/ensure-schema";
import { isEverCreator } from "@/app/(admin)/creators/_queries/list-ex-creators";
import {
  canEditBalanceAdjustments,
  requireBalanceAdjustmentEditAdmin,
} from "@/lib/balance-adjustment-edit/motha-gate";

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
    // leaderboard — the linked creator (main-DB user id, better-auth
    // nanoid). Required + validated per-category below.
    creatorId: z.string().trim().min(1).max(64).optional(),
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
  /** Set only for `leaderboard` — the creator this removal is linked to. */
  creatorId: string | null;
  /** Set only for `giveaway` — drives the legacy /marketing/giveaway feed. */
  giveawaySource: { url: string; sourceType: "twitter" | "discord" | "other" } | null;
};

/**
 * Enforce the per-category required inputs (the table in CLAUDE/spec):
 *   deposit_problem → coin type + tx hash
 *   giveaway        → a Twitter OR Discord link
 *   bonus           → exact reason, min 20 chars
 *   bugs            → explanation, min 30 chars
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
  amount: number,
): { ok: true; meta: ResolvedAdjustmentMeta } | { ok: false; error: string } {
  const d = details ?? {};
  const base: ResolvedAdjustmentMeta = {
    coinType: null,
    txHash: null,
    socialLink: null,
    reasonText: null,
    lossbackPercent: null,
    pnl7dUsd: null,
    creatorId: null,
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
    case "bugs": {
      const reasonText = (d.reasonText ?? "").trim();
      if (reasonText.length < BUGS_ADJUSTMENT_MIN_REASON_CHARS) {
        return {
          ok: false,
          error: `Bugs requires an explanation of at least ${BUGS_ADJUSTMENT_MIN_REASON_CHARS} characters`,
        };
      }
      return { ok: true, meta: { ...base, reasonText } };
    }
    case "reload": {
      // No required inputs.
      return { ok: true, meta: base };
    }
    case "deposit_bonus": {
      // Optional reason — the dialog auto-fills a descriptive reason when
      // the amount is calculated from selected deposits (e.g. "Deposit
      // bonus: 5% of $200 across 2 deposits"), but a bare amount is allowed.
      const reasonText = (d.reasonText ?? "").trim();
      return { ok: true, meta: { ...base, reasonText: reasonText || null } };
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
    case "leaderboard": {
      // Removal-only: the amount MUST remove balance (negative). A
      // positive (credit) leaderboard adjustment is rejected — this
      // category exists only for pulling balance off a user and linking
      // it to a creator. (The dialog only offers the option in the
      // remove direction; this is the authoritative server guard.)
      if (amount >= 0) {
        return {
          ok: false,
          error: "Leaderboard adjustments must remove balance (negative amount)",
        };
      }
      const creatorId = (d.creatorId ?? "").trim();
      if (!creatorId) {
        return { ok: false, error: "Leaderboard requires a linked creator" };
      }
      return { ok: true, meta: { ...base, creatorId } };
    }
    case "remove_locked_balance": {
      // Removal-only: decrements `balances.locked_balance` (vault), not
      // available_balance. Used to clear escrowed leaderboard deposits
      // or other locked funds without affecting GGR/NGR/P&L (netted out
      // at the query layer — see balance-adjustment-categories.ts).
      if (amount >= 0) {
        return {
          ok: false,
          error: "Remove locked balance must use a negative amount",
        };
      }
      const reasonText = (d.reasonText ?? "").trim();
      if (reasonText.length < REMOVE_LOCKED_BALANCE_MIN_REASON_CHARS) {
        return {
          ok: false,
          error: `Remove locked balance requires a reason of at least ${REMOVE_LOCKED_BALANCE_MIN_REASON_CHARS} characters`,
        };
      }
      return { ok: true, meta: { ...base, reasonText } };
    }
    case "fraud_abuse": {
      if (amount >= 0) {
        return {
          ok: false,
          error: "Fraud / abuse adjustments must remove balance (negative amount)",
        };
      }
      const reasonText = (d.reasonText ?? "").trim();
      if (reasonText.length < FRAUD_ABUSE_MIN_REASON_CHARS) {
        return {
          ok: false,
          error: `Fraud / abuse requires an explanation of at least ${FRAUD_ABUSE_MIN_REASON_CHARS} characters`,
        };
      }
      return { ok: true, meta: { ...base, reasonText } };
    }
    case "official_stream": {
      // Creator-linked, but NOT removal-only — both add (credit) and
      // remove (debit) are allowed, so there is NO sign check here. Only
      // a linked creator is required, mirroring `leaderboard`'s creator
      // requirement. NOT counted in GGR/NGR/cost (counted: false) — it
      // only persists the creator link cleanly; cost accounting is a
      // deliberate follow-up.
      const creatorId = (d.creatorId ?? "").trim();
      if (!creatorId) {
        return { ok: false, error: "Official stream requires a linked creator" };
      }
      return { ok: true, meta: { ...base, creatorId } };
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
    creatorId?: string;
  };
}): Promise<{ success: true } | { success: false; error: string }> {
  const db = await getDb();
  const session = await requirePageAccess("/users");

  const parseResult = adjustBalanceSchema.safeParse(data);
  if (!parseResult.success) {
    return { success: false, error: parseResult.error.issues[0]?.message ?? "Invalid input" };
  }
  const parsed = parseResult.data;

  // Per-category required-input validation (single source of truth). The
  // signed amount is passed so removal-only categories (leaderboard) can
  // assert the debit direction server-side.
  const categoryResult = validateAdjustmentCategory(
    parsed.category,
    parsed.details,
    parsed.amount,
  );
  if (!categoryResult.ok) {
    return { success: false, error: categoryResult.error };
  }
  const meta = categoryResult.meta;

  // Creator-linked adjustments (leaderboard, official_stream) link to a
  // creator — verify the linked id is a real creator on the main DB before
  // writing. `user.role === 'creator'` is the established creator marker
  // (same field `searchNonCreatorUsers` / `changeRole` use); no cross-DB
  // join, no guessed schema. Driven by the guard (not a hardcoded
  // `leaderboard` check) so a new creator-linked category is covered
  // automatically.
  if (isCreatorLinkedAdjustmentCategory(parsed.category)) {
    if (!meta.creatorId) {
      return { success: false, error: "This adjustment requires a linked creator" };
    }
    const linkedUser = await db.user.findUnique({
      where: { id: meta.creatorId },
      select: { id: true, role: true },
    });
    if (!linkedUser) {
      return { success: false, error: "Linked creator not found" };
    }
    // Accept either a CURRENT creator or a PAST / ex creator (their role
    // was since removed but they still have creator artifacts). Linking a
    // leaderboard adjustment to a retired creator is a legitimate
    // back-fill, so don't hard-require role === 'creator'.
    if (linkedUser.role !== "creator") {
      const everCreator = await isEverCreator(meta.creatorId);
      if (!everCreator) {
        return {
          success: false,
          error: "Linked user was never a creator",
        };
      }
    }
  }

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
  const affectsLockedBalance = parsed.category === "remove_locked_balance";
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

      if (affectsLockedBalance) {
        const lockedBefore = Number(b.locked_balance);
        const lockedAfter = lockedBefore + parsed.amount;
        if (lockedAfter < 0) {
          throw new Error("Resulting locked balance would be negative");
        }
        newBalance = currentBalance;

        const updated = await tx.balances.updateMany({
          where: { user_id: parsed.userId, version: b.version },
          data: {
            locked_balance: lockedAfter,
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
            // Ledger balance_before/after track available_balance (platform
            // convention). Locked-balance removals leave available unchanged.
            balance_before: currentBalance,
            balance_after: currentBalance,
            description: `Admin adjustment: ${parsed.reason}`,
            metadata: {
              adjustment_category: parsed.category,
              balance_target: "locked",
            },
            status: "completed",
          },
        });
        return;
      }

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
          //
          // For a creator-linked category (`leaderboard`,
          // `official_stream`) we also stamp the linked creator id
          // (`metadata->>'creator_id'`) so the row is cleanly attributable
          // to a creator with no schema migration. NOTE: wiring this into
          // the dashboard "Creators Costs" / leaderboard-spend accounting
          // is a deliberate follow-up — this only persists the link. Driven
          // by the guard so a new creator-linked category is covered.
          metadata:
            isCreatorLinkedAdjustmentCategory(parsed.category) && meta.creatorId
              ? {
                  adjustment_category: parsed.category,
                  creator_id: meta.creatorId,
                }
              : { adjustment_category: parsed.category },
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
      message === "Resulting locked balance would be negative" ||
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
    metadata: {
      amount: parsed.amount,
      reason: parsed.reason,
      category: parsed.category,
      // Linked creator for a creator-linked category (leaderboard,
      // official_stream); omitted for every other category.
      ...(isCreatorLinkedAdjustmentCategory(parsed.category) && meta.creatorId
        ? { creatorId: meta.creatorId }
        : {}),
    },
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
// Adjust sweepstakes COIN balance — separate from the USD adjustBalance flow
// ---------------------------------------------------------------------------

// Minimum free-text reason for a coin adjustment. Coins have no category
// machinery (lossback/GGR/etc. are USD-only concepts), so a short, mandatory
// reason is the whole justification.
const COIN_ADJUST_MIN_REASON_CHARS = 10;

const adjustCoinBalanceSchema = z.object({
  userId: z.string().min(1),
  // Signed amount in COIN units. Positive = grant, negative = remove.
  // Must be a whole number and a multiple of 100 because coin balances are
  // stored as coin-USD at cent precision ($0.01 == 100 coins).
  coins: z
    .number()
    .int("Coin amount must be a whole number")
    .refine((n) => n !== 0, "Coin amount can't be zero")
    .refine((n) => n % 100 === 0, "Coin amount must be a multiple of 100"),
  reason: z
    .string()
    .trim()
    .min(
      COIN_ADJUST_MIN_REASON_CHARS,
      `Reason must be at least ${COIN_ADJUST_MIN_REASON_CHARS} characters`,
    )
    .max(500),
  totpCode: z.string().min(1),
});

/**
 * Grant or remove sweepstakes coins for a user.
 *
 * Mirrors `adjustBalance`'s security shape (page access + __can_adjust_balance
 * capability + 2FA + admin audit event) but deliberately diverges where coins
 * differ from real cash:
 *   • Writes `balances.coin_available_balance` (coin-USD) and a
 *     `coin_transactions` audit row (type `coin_admin_adjustment`) — NOT the
 *     ledger_transactions table, so coins never touch real-money reporting.
 *   • Skips `checkBalanceAdjustmentLimit` — that limit caps real USD payouts;
 *     coins aren't withdrawable, so it doesn't apply.
 *
 * SCHEMA-DRIFT SAFE: the coin columns/table only exist on DBs with the
 * sweepstakes migration (dev now; prod later). All writes go through raw SQL,
 * and a missing-column/table error is surfaced as a friendly "not enabled
 * here" instead of a crash. The dialog also hides the Coins option on a DB
 * where `coinsEnabled` is false, so this is a defense-in-depth backstop.
 */
export async function adjustCoinBalance(data: {
  userId: string;
  coins: number;
  reason: string;
  totpCode: string;
}): Promise<{ success: true } | { success: false; error: string }> {
  const db = await getDb();
  const session = await requirePageAccess("/users");

  const parseResult = adjustCoinBalanceSchema.safeParse(data);
  if (!parseResult.success) {
    return {
      success: false,
      error: parseResult.error.issues[0]?.message ?? "Invalid input",
    };
  }
  const parsed = parseResult.data;

  // Admins can always adjust; non-admins need the __can_adjust_balance capability.
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
    await require2FA(session.userId, parsed.totpCode);
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "2FA verification failed",
    };
  }

  // Convert the admin-entered COIN amount to the stored coin-USD unit. The
  // multiple-of-100 guard above guarantees this lands cleanly on cents.
  const amountUsd = parsed.coins / COINS_PER_USD;

  let balanceBefore = 0;
  let balanceAfter = 0;
  try {
    await db.$transaction(async (tx) => {
      // Optimistic-locking read (mirrors adjustBalance): read coin balance +
      // version, recompute, update only if the version still matches.
      const rows = await tx.$queryRawUnsafe<
        Array<{ coin_available_balance: string | number; version: number }>
      >(
        `SELECT coin_available_balance, version FROM balances WHERE user_id = $1`,
        parsed.userId,
      );
      const row = rows[0];
      if (!row) throw new Error("User balances not found");

      balanceBefore = Number(row.coin_available_balance);
      balanceAfter = Math.round((balanceBefore + amountUsd) * 100) / 100;
      if (balanceAfter < 0) {
        throw new Error("Resulting coin balance would be negative");
      }

      const updated = await tx.$executeRawUnsafe(
        `UPDATE balances
            SET coin_available_balance = coin_available_balance::decimal + $1::decimal,
                version = version + 1
          WHERE user_id = $2 AND version = $3`,
        amountUsd,
        parsed.userId,
        row.version,
      );
      if (updated !== 1) {
        throw new Error("Balance changed concurrently — please retry");
      }

      await tx.$executeRawUnsafe(
        `INSERT INTO coin_transactions
            (user_id, type, amount, balance_before, balance_after, description, metadata)
         VALUES ($1, 'coin_admin_adjustment', $2::decimal, $3::decimal, $4::decimal, $5, $6::jsonb)`,
        parsed.userId,
        amountUsd,
        balanceBefore,
        balanceAfter,
        `Admin coin adjustment: ${parsed.reason}`,
        JSON.stringify({ admin: true, coins: parsed.coins }),
      );
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    if (
      message === "User balances not found" ||
      message === "Resulting coin balance would be negative" ||
      message.includes("concurrently")
    ) {
      return { success: false, error: message };
    }
    // Coin columns/table absent on this DB (e.g. prod before the sweepstakes
    // migration) — surface a clear message instead of a generic crash.
    if (
      /coin_available_balance|coin_transactions|does not exist|coin_admin_adjustment/i.test(
        message,
      )
    ) {
      return {
        success: false,
        error: "Coins are not enabled on this environment yet",
      };
    }
    console.error("[adjustCoinBalance] Transaction failed:", err);
    return { success: false, error: "Coin adjustment failed — please try again" };
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "coin_balance_adjustment",
    targetUserId: parsed.userId,
    metadata: {
      coins: parsed.coins,
      amountUsd,
      reason: parsed.reason,
    },
  });

  revalidatePath(`/users/${parsed.userId}`);
  return { success: true };
}

// ---------------------------------------------------------------------------
// Edit balance-adjustment tag (category) + description — motha-only
// ---------------------------------------------------------------------------

const ADMIN_ADJUSTMENT_PREFIX = "Admin adjustment: ";
const MANUAL_WITHDRAWAL_PREFIX = "Manual withdrawal: ";

/** Parse the editable reason from a ledger description string. */
function parseAdjustmentReason(description: string): {
  kind: "admin" | "manual" | "other";
  reason: string;
  manualSuffix: string | null;
} {
  if (description.startsWith(ADMIN_ADJUSTMENT_PREFIX)) {
    return {
      kind: "admin",
      reason: description.slice(ADMIN_ADJUSTMENT_PREFIX.length),
      manualSuffix: null,
    };
  }
  if (description.startsWith(MANUAL_WITHDRAWAL_PREFIX)) {
    const rest = description.slice(MANUAL_WITHDRAWAL_PREFIX.length);
    const suffixMatch = rest.match(/^(.*?)( \(total \$[\d.]+.*\))$/);
    if (suffixMatch) {
      return {
        kind: "manual",
        reason: suffixMatch[1]!.trim(),
        manualSuffix: suffixMatch[2]!,
      };
    }
    return { kind: "manual", reason: rest.trim(), manualSuffix: null };
  }
  return { kind: "other", reason: description, manualSuffix: null };
}

function rebuildAdjustmentDescription(
  kind: "admin" | "manual" | "other",
  reason: string,
  manualSuffix: string | null,
): string {
  const trimmed = reason.trim();
  if (kind === "admin") {
    return `${ADMIN_ADJUSTMENT_PREFIX}${trimmed}`;
  }
  if (kind === "manual") {
    return manualSuffix
      ? `${MANUAL_WITHDRAWAL_PREFIX}${trimmed}${manualSuffix}`
      : `${MANUAL_WITHDRAWAL_PREFIX}${trimmed}`;
  }
  return trimmed;
}

const updateBalanceAdjustmentSchema = z.object({
  ledgerTxId: z.string().min(1),
  targetUserId: z.string().min(1),
  category: z.enum(BALANCE_ADJUSTMENT_CATEGORY_KEYS).optional(),
  reason: z.string().trim().min(1).max(5000),
  totpCode: z.string().min(1),
});

export type BalanceAdjustmentEditPayload = {
  ledgerTxId: string;
  category: BalanceAdjustmentCategory | null;
  reason: string;
  kind: "admin" | "manual" | "other";
  amount: number;
  description: string;
  hasMetaRow: boolean;
};

export async function getBalanceAdjustmentForEdit(
  ledgerTxId: string,
  targetUserId: string,
): Promise<
  | { success: true; data: BalanceAdjustmentEditPayload }
  | { success: false; error: string }
> {
  try {
    await requireBalanceAdjustmentEditAdmin();
  } catch {
    return { success: false, error: "Not permitted." };
  }

  await requirePageAccess("/users");

  const db = await getDb();
  const row = await db.ledger_transactions.findFirst({
    where: { id: ledgerTxId, user_id: targetUserId },
    select: {
      id: true,
      type: true,
      amount: true,
      description: true,
      metadata: true,
    },
  });

  if (!row || row.type !== "admin_balance_adjustment") {
    return { success: false, error: "Balance adjustment not found" };
  }

  const parsed = parseAdjustmentReason(row.description);
  const metaObj = row.metadata as Record<string, unknown> | null;
  const categoryFromLedger = isBalanceAdjustmentCategory(
    metaObj?.adjustment_category,
  )
    ? metaObj.adjustment_category
    : null;

  let hasMetaRow = false;
  let reason = parsed.reason;

  try {
    await ensureBalanceAdjustmentMetaSchema();
    const metaRow = await adminDb.admin_balance_adjustment_meta.findFirst({
      where: { ledger_tx_id: ledgerTxId, target_user_id: targetUserId },
      select: { category: true, reason_text: true },
    });
    if (metaRow) {
      hasMetaRow = true;
      if (metaRow.reason_text?.trim()) {
        reason = metaRow.reason_text.trim();
      }
    }
  } catch (err) {
    console.error("[getBalanceAdjustmentForEdit] meta lookup failed:", err);
  }

  return {
    success: true,
    data: {
      ledgerTxId: row.id,
      category: categoryFromLedger,
      reason,
      kind: parsed.kind,
      amount: Number(row.amount),
      description: row.description,
      hasMetaRow,
    },
  };
}

export { canEditBalanceAdjustments };

export async function updateBalanceAdjustmentMeta(data: {
  ledgerTxId: string;
  targetUserId: string;
  category?: BalanceAdjustmentCategory;
  reason: string;
  totpCode: string;
}): Promise<{ success: true } | { success: false; error: string }> {
  let session: SessionPayload & { username: string };
  try {
    session = await requireBalanceAdjustmentEditAdmin();
  } catch {
    return { success: false, error: "Not permitted." };
  }

  await requirePageAccess("/users");

  const parseResult = updateBalanceAdjustmentSchema.safeParse(data);
  if (!parseResult.success) {
    return {
      success: false,
      error: parseResult.error.issues[0]?.message ?? "Invalid input",
    };
  }
  const parsed = parseResult.data;

  try {
    await require2FA(session.userId, parsed.totpCode);
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "2FA verification failed",
    };
  }

  const db = await getDb();
  const row = await db.ledger_transactions.findFirst({
    where: { id: parsed.ledgerTxId, user_id: parsed.targetUserId },
    select: {
      id: true,
      type: true,
      amount: true,
      description: true,
      metadata: true,
    },
  });

  if (!row || row.type !== "admin_balance_adjustment") {
    return { success: false, error: "Balance adjustment not found" };
  }

  const existing = parseAdjustmentReason(row.description);
  const metaObj = (row.metadata as Record<string, unknown> | null) ?? {};
  const previousCategory = isBalanceAdjustmentCategory(
    metaObj.adjustment_category,
  )
    ? metaObj.adjustment_category
    : null;

  const nextCategory =
    existing.kind === "admin"
      ? (parsed.category ?? previousCategory)
      : previousCategory;

  if (existing.kind === "admin" && !nextCategory) {
    return { success: false, error: "Category is required" };
  }

  if (nextCategory && isRemovalOnlyAdjustmentCategory(nextCategory)) {
    if (Number(row.amount) > 0) {
      return {
        success: false,
        error: "Removal-only categories require a negative adjustment amount",
      };
    }
  }

  if (
    nextCategory &&
    isCreatorLinkedAdjustmentCategory(nextCategory) &&
    typeof metaObj.creator_id !== "string"
  ) {
    return {
      success: false,
      error:
        "This adjustment has no linked creator — pick a non-creator category",
    };
  }

  const newDescription = rebuildAdjustmentDescription(
    existing.kind,
    parsed.reason,
    existing.manualSuffix,
  );

  const nextMetadata: Record<string, unknown> = { ...metaObj };
  if (existing.kind === "admin" && nextCategory) {
    nextMetadata.adjustment_category = nextCategory;
    if (
      !isCreatorLinkedAdjustmentCategory(nextCategory) &&
      "creator_id" in nextMetadata
    ) {
      delete nextMetadata.creator_id;
    }
  }

  const previousReason = existing.reason;
  const previousDescription = row.description;

  try {
    await db.ledger_transactions.update({
      where: { id: parsed.ledgerTxId },
      data: {
        description: newDescription,
        metadata: nextMetadata as Prisma.InputJsonValue,
      },
    });
  } catch (err) {
    console.error("[updateBalanceAdjustmentMeta] ledger update failed:", err);
    return { success: false, error: "Failed to update adjustment" };
  }

  if (nextCategory) {
    try {
      await ensureBalanceAdjustmentMetaSchema();
      const metaUpdate = {
        category: nextCategory,
        reason_text: parsed.reason.trim(),
      };
      const updated = await adminDb.admin_balance_adjustment_meta.updateMany({
        where: {
          ledger_tx_id: parsed.ledgerTxId,
          target_user_id: parsed.targetUserId,
        },
        data: metaUpdate,
      });
      if (updated.count === 0) {
        await adminDb.admin_balance_adjustment_meta.create({
          data: {
            admin_user_id: session.userId,
            target_user_id: parsed.targetUserId,
            ledger_tx_id: parsed.ledgerTxId,
            category: nextCategory,
            amount_usd: Number(row.amount),
            reason_text: parsed.reason.trim(),
          },
        });
      }
    } catch (err) {
      console.error(
        "[updateBalanceAdjustmentMeta] admin meta update failed (ledger already committed):",
        err,
      );
    }

    if (nextCategory === "giveaway") {
      try {
        await adminDb.admin_giveaway_actions.updateMany({
          where: { ledger_tx_id: parsed.ledgerTxId },
          data: { reason: parsed.reason.trim() },
        });
      } catch (err) {
        console.error(
          "[updateBalanceAdjustmentMeta] giveaway row update failed:",
          err,
        );
      }
    }
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "balance_adjustment_meta_updated",
    targetUserId: parsed.targetUserId,
    metadata: {
      ledgerTxId: parsed.ledgerTxId,
      previousCategory,
      nextCategory,
      previousReason,
      nextReason: parsed.reason.trim(),
      previousDescription,
      nextDescription: newDescription,
    },
  });

  revalidatePath(`/users/${parsed.targetUserId}`);
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

  // Read the prior role BEFORE the update so the audit row records the full
  // before→after transition (not just the new role). This is what lets the
  // /creators changelog detect a creator-removal (prev_role === 'creator',
  // new_role !== 'creator') from a generic role change — otherwise firing a
  // creator via this dropdown is indistinguishable from any other role edit.
  const before = await db.user.findUnique({
    where: { id: userId },
    select: { role: true },
  });
  const prevRole = before?.role ?? null;

  await db.user.update({
    where: { id: userId },
    data: { role: newRole as user_role },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "role_changed",
    targetUserId: userId,
    metadata: { prev_role: prevRole, new_role: newRole },
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
  // revalidatePath does NOT drop unstable_cache entries — flush the
  // /users list caches so the renamed identity shows there immediately.
  revalidateTag("users-list");
  revalidateTag("users-list-stats");
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

export type UserDepositRow = {
  id: string;
  amount: number;
  createdAt: string;
};

/**
 * A user's recent completed deposits — powers the OPTIONAL "calculate a
 * deposit bonus from selected deposits" picker in the Adjust Balance
 * dialog. Newest first, capped to a screenful.
 */
export async function getUserDeposits(
  userId: string,
): Promise<UserDepositRow[]> {
  await requirePageAccess("/users");
  const db = await getDb();
  const rows = await db.ledger_transactions.findMany({
    where: {
      user_id: userId,
      type: "deposit",
      status: "completed",
    },
    select: { id: true, amount: true, created_at: true },
    orderBy: { created_at: "desc" },
    take: 50,
  });
  return rows.map((r) => ({
    id: r.id,
    amount: Math.abs(Number(r.amount)),
    createdAt: r.created_at.toISOString(),
  }));
}

export type JoinedBattleRow = {
  battleId: string;
  gameSessionId: string;
  at: string;
  result: "win" | "lose" | "pending";
  winnings: number;
  betAmount: number;
  sponsorshipPercentage: number;
};

/**
 * Battles the user JOINED as a participant that have NO `battle_bet` ledger
 * row — overwhelmingly fully-sponsored / free-entry joins ($0 stake books no
 * ledger row). These are invisible in the normal gaming history (which reads
 * only `ledger_transactions`) even though the user got `battle_participants`
 * + won cards in `user_inventory`. This surfaces them so the "unexplained"
 * inventory/balance changes are accounted for. Newest first, capped.
 */
export async function getUserJoinedSponsoredBattles(
  userId: string,
): Promise<JoinedBattleRow[]> {
  await requirePageAccess("/users");
  const db = await getDb();
  const rows = await db.$queryRawUnsafe<
    {
      battle_id: string;
      game_session_id: string;
      team_number: number;
      winner_team: number | null;
      status: string;
      bet_amount: string;
      sponsorship_percentage: number;
      created_at: Date;
      winnings: string;
    }[]
  >(
    `SELECT bp.battle_id,
            bp.game_session_id,
            bp.team_number,
            b.winner_team,
            b.status::text AS status,
            b.bet_amount::text AS bet_amount,
            b.sponsorship_percentage,
            gs.created_at,
            COALESCE((
              SELECT SUM(ui.value_at_obtained::numeric)
              FROM user_inventory ui
              WHERE ui.user_id = bp.user_id
                AND ui.source_type::text = 'battle'
                AND ui.source_id = bp.game_session_id
            ), 0)::text AS winnings
       FROM battle_participants bp
       JOIN battles b ON b.id = bp.battle_id
       JOIN game_sessions gs ON gs.id = bp.game_session_id
      WHERE bp.user_id = $1
        AND bp.bot_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM ledger_transactions lt
           WHERE lt.type::text = 'battle_bet'
             AND lt.game_session_id = bp.game_session_id
             AND lt.user_id = bp.user_id
        )
      ORDER BY gs.created_at DESC
      LIMIT 100`,
    userId,
  );

  return rows.map((r) => {
    let result: JoinedBattleRow["result"] = "pending";
    if (r.status === "completed" && r.winner_team != null) {
      result = r.team_number === r.winner_team ? "win" : "lose";
    }
    return {
      battleId: r.battle_id,
      gameSessionId: r.game_session_id,
      at: r.created_at.toISOString(),
      result,
      winnings: Number(r.winnings),
      betAmount: Number(r.bet_amount),
      sponsorshipPercentage: r.sponsorship_percentage,
    };
  });
}

export type InventorySaleBatch = {
  /** First ledger-row id in the batch (stable React key). */
  id: string;
  at: string;
  count: number;
  total: number;
  /** Card names in the batch (capped for display). */
  cards: { name: string; value: number }[];
};

/**
 * The user's card SALES grouped into batches — cards sold together (same-
 * second `sold_at`) collapse into one entry. Sourced DIRECTLY from
 * `user_inventory` (rows with `sold_at` set) — the SAME source as the
 * "Sold & Exchanged" inventory tab — NOT from `card_sale` ledger rows
 * (which don't always exist). This guarantees every sold card the inventory
 * tab shows also appears here. Newest batch first.
 */
export async function getUserInventorySaleBatches(
  userId: string,
): Promise<InventorySaleBatch[]> {
  await requirePageAccess("/users");
  const db = await getDb();
  const rows = await db.user_inventory.findMany({
    where: { user_id: userId, sold_at: { not: null } },
    select: { id: true, card_id: true, value_at_obtained: true, sold_at: true },
    orderBy: { sold_at: "desc" },
    take: 500,
  });
  if (rows.length === 0) return [];

  const cardIds = [...new Set(rows.map((r) => r.card_id))];
  const cards =
    cardIds.length > 0
      ? await db.cards.findMany({
          where: { id: { in: cardIds } },
          select: { id: true, name: true },
        })
      : [];
  const cardName = new Map(cards.map((c) => [c.id, c.name]));

  // Group by second-truncated sold_at — a multi-card "sell" sets sold_at on
  // all rows at the same instant. `rows` is desc, so the Map preserves
  // newest-first batch order.
  const batches = new Map<string, InventorySaleBatch>();
  for (const r of rows) {
    if (!r.sold_at) continue;
    const key = r.sold_at.toISOString().slice(0, 19);
    let b = batches.get(key);
    if (!b) {
      b = { id: r.id, at: r.sold_at.toISOString(), count: 0, total: 0, cards: [] };
      batches.set(key, b);
    }
    const value = Number(r.value_at_obtained);
    b.count += 1;
    b.total += value;
    if (b.cards.length < 30) {
      b.cards.push({ name: cardName.get(r.card_id) ?? "Card", value });
    }
  }
  return [...batches.values()];
}

export type UserVoucherRow = {
  id: string;
  value: number;
  origin: string;
  description: string | null;
  createdAt: string;
};

const deleteVoucherSchema = z.object({
  userId: z.string().min(1),
  voucherId: z.string().uuid(),
  reason: z
    .string()
    .trim()
    .min(20, { message: "Reason must be at least 20 characters" })
    .max(5000),
  totpCode: z.string().trim().min(1, { message: "2FA code is required" }),
});

/**
 * Remove (sell off) an unclaimed voucher from a user. Same gate as inventory
 * removal (admin or __can_adjust_balance, + 2FA). Deletes the voucher row
 * and writes a VISIBLE `admin_balance_adjustment` record (balance unchanged)
 * so the removal shows in the transactions box like a balance adjustment.
 */
export async function deleteUserVoucher(data: {
  userId: string;
  voucherId: string;
  reason: string;
  totpCode: string;
}): Promise<{ success: true } | { success: false; error: string }> {
  const db = await getDb();
  const session = await requirePageAccess("/users");

  const parsed = deleteVoucherSchema.safeParse(data);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  if (session.role !== "admin") {
    const perms = await adminDb.admin_users.findUnique({
      where: { id: session.userId },
      select: { allowed_pages: true },
    });
    if (!perms || !canUserAdjustBalance(perms.allowed_pages)) {
      return {
        success: false,
        error: "You do not have permission to remove vouchers",
      };
    }
  }

  try {
    await require2FA(session.userId, parsed.data.totpCode);
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "2FA verification failed",
    };
  }

  const voucher = await db.vouchers.findFirst({
    where: { id: parsed.data.voucherId, user_id: parsed.data.userId },
    select: { id: true, value: true, origin: true, claimed_at: true },
  });
  if (!voucher) {
    return { success: false, error: "Voucher not found for this user" };
  }
  if (voucher.claimed_at) {
    return {
      success: false,
      error: "This voucher was already claimed — only open vouchers can be removed",
    };
  }

  const value = Number(voucher.value);

  try {
    await db.$transaction(async (tx) => {
      const bal = await tx.balances.findUnique({
        where: { user_id: parsed.data.userId },
        select: { available_balance: true },
      });
      const currentAvailable = bal ? Number(bal.available_balance) : 0;

      const removedAt = new Date();
      const updated = await tx.vouchers.updateMany({
        where: {
          id: parsed.data.voucherId,
          user_id: parsed.data.userId,
          claimed_at: null,
        },
        data: { claimed_at: removedAt },
      });
      if (updated.count !== 1) {
        throw new Error("Voucher changed since you opened this dialog");
      }

      await tx.ledger_transactions.create({
        data: {
          id: crypto.randomUUID(),
          user_id: parsed.data.userId,
          type: "admin_balance_adjustment",
          amount: -Math.abs(value),
          balance_before: currentAvailable,
          balance_after: currentAvailable,
          description: `Voucher removed: $${value.toFixed(2)} (${String(voucher.origin)}) — ${parsed.data.reason}`,
          metadata: {
            kind: "voucher_removal",
            voucher_id: parsed.data.voucherId,
            origin: String(voucher.origin),
            value,
          },
          status: "completed",
        },
      });
    });
  } catch (err) {
    console.error("[deleteUserVoucher] delete failed:", err);
    return {
      success: false,
      error:
        err instanceof Error
          ? `Failed to remove voucher: ${err.message}`
          : "Failed to remove voucher",
    };
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "voucher_removed",
    targetUserId: parsed.data.userId,
    metadata: {
      voucherId: parsed.data.voucherId,
      origin: String(voucher.origin),
      value,
      reason: parsed.data.reason,
    },
  });

  revalidatePath(`/users/${parsed.data.userId}`);
  return { success: true };
}

/**
 * The user's UNCLAIMED vouchers — held value shown alongside cards in the
 * Current Inventory section. Claimed vouchers are excluded (they've already
 * converted to balance). Newest first; capped so a pathological account
 * can't flood the panel.
 */
export async function getUserVouchers(
  userId: string,
): Promise<UserVoucherRow[]> {
  await requirePageAccess("/users");
  const db = await getDb();
  const rows = await db.vouchers.findMany({
    where: { user_id: userId, claimed_at: null },
    select: {
      id: true,
      value: true,
      origin: true,
      description: true,
      created_at: true,
    },
    orderBy: { created_at: "desc" },
    take: 200,
  });
  return rows.map((v) => ({
    id: v.id,
    value: Number(v.value),
    origin: String(v.origin),
    description: v.description,
    createdAt: v.created_at.toISOString(),
  }));
}

/** Minimum explanation when an admin removes an open inventory item. */
const INVENTORY_DELETE_MIN_REASON_CHARS = 20;

const deleteInventoryItemSchema = z.object({
  userId: z.string().min(1),
  inventoryItemId: z.string().uuid(),
  reason: z
    .string()
    .trim()
    .min(INVENTORY_DELETE_MIN_REASON_CHARS, {
      message: `Reason must be at least ${INVENTORY_DELETE_MIN_REASON_CHARS} characters`,
    })
    .max(5000),
  totpCode: z.string().trim().min(1, { message: "2FA code is required" }),
});

const OPEN_WITHDRAWAL_STATUSES = [
  "pending",
  "processing",
  "shipped",
] as const;

export async function deleteUserInventoryItem(data: {
  userId: string;
  inventoryItemId: string;
  reason: string;
  totpCode: string;
}): Promise<{ success: true } | { success: false; error: string }> {
  const db = await getDb();
  const session = await requirePageAccess("/users");

  const parsed = deleteInventoryItemSchema.safeParse(data);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  if (session.role !== "admin") {
    const perms = await adminDb.admin_users.findUnique({
      where: { id: session.userId },
      select: { allowed_pages: true },
    });
    if (!perms || !canUserAdjustBalance(perms.allowed_pages)) {
      return {
        success: false,
        error: "You do not have permission to remove inventory items",
      };
    }
  }

  try {
    await require2FA(session.userId, parsed.data.totpCode);
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "2FA verification failed",
    };
  }

  const result = await removeOneInventoryItem(
    db,
    session.userId,
    parsed.data.userId,
    parsed.data.inventoryItemId,
    parsed.data.reason,
  );
  if (!result.ok) {
    return { success: false, error: result.error };
  }

  revalidatePath(`/users/${parsed.data.userId}`);
  return { success: true };
}

type RemoveInventoryItemResult = { ok: true } | { ok: false; error: string };

/**
 * Core per-item inventory removal: validates the item is removable, deletes
 * it (with its dependent provably-fair rows), and writes a VISIBLE
 * `admin_balance_adjustment` ledger row so the removal shows up in the
 * user's Deposits & Withdrawals / Admin balance adjustments box — exactly
 * like a balance adjustment. The ledger row leaves `balance_before ==
 * balance_after` (removing a card doesn't change cash), so PnL /
 * onSiteBalance are untouched; the signed `amount` (− item value) and the
 * description carry the removed value for display only. NOT tagged with an
 * `adjustment_category`, so it's never counted as a balance-adjustment
 * credit/debit in GGR/cost.
 *
 * Auth + 2FA are the CALLER's responsibility (so the bulk path verifies
 * once). Returns ok/error per item so the bulk path can skip-and-continue.
 */
async function removeOneInventoryItem(
  db: Awaited<ReturnType<typeof getDb>>,
  adminUserId: string,
  userId: string,
  inventoryItemId: string,
  reason: string,
): Promise<RemoveInventoryItemResult> {
  const item = await db.user_inventory.findFirst({
    where: { id: inventoryItemId, user_id: userId },
    select: {
      id: true,
      card_id: true,
      value_at_obtained: true,
      sold_at: true,
      exchanged_at: true,
      withdrawal_locked_at: true,
    },
  });

  if (!item) {
    return { ok: false, error: "Inventory item not found for this user" };
  }
  if (item.sold_at || item.exchanged_at) {
    return {
      ok: false,
      error: "Only open items can be removed — this one was already sold or exchanged",
    };
  }
  if (item.withdrawal_locked_at) {
    return {
      ok: false,
      error: "This item is withdrawal-locked — unlock or cancel the withdrawal first",
    };
  }

  const openWithdrawal = await db.card_withdrawal_requests.findFirst({
    where: {
      user_id: userId,
      status: { in: [...OPEN_WITHDRAWAL_STATUSES] },
      inventory_item_ids: { has: inventoryItemId },
    },
    select: { id: true },
  });
  if (openWithdrawal) {
    return {
      ok: false,
      error: "This item is tied to an open card withdrawal — cancel or complete it first",
    };
  }

  const card = await db.cards.findUnique({
    where: { id: item.card_id },
    select: { name: true },
  });
  const value = Number(item.value_at_obtained);
  const cardName = card?.name ?? "Unknown item";

  let deletedCount = 0;
  try {
    deletedCount = await db.$transaction(async (tx) => {
      const bal = await tx.balances.findUnique({
        where: { user_id: userId },
        select: { available_balance: true },
      });
      const currentAvailable = bal ? Number(bal.available_balance) : 0;

      // Stamp sold_at so windowed P&L counts the disposal (open-inventory
      // queries filter sold_at IS NULL). Keep the row for audit; do not
      // hard-delete — hard-deletes were invisible to calculateWindowedPnl.
      await tx.provably_fair_results.deleteMany({
        where: { inventory_item_id: inventoryItemId },
      });
      const removedAt = new Date();
      const updated = await tx.user_inventory.updateMany({
        where: {
          id: inventoryItemId,
          user_id: userId,
          sold_at: null,
          exchanged_at: null,
        },
        data: { sold_at: removedAt },
      });

      if (updated.count === 1) {
        // Visible record in the transactions box. Balance UNCHANGED.
        await tx.ledger_transactions.create({
          data: {
            id: crypto.randomUUID(),
            user_id: userId,
            type: "admin_balance_adjustment",
            amount: -Math.abs(value),
            balance_before: currentAvailable,
            balance_after: currentAvailable,
            description: `Inventory removed: ${cardName} ($${value.toFixed(2)}) — ${reason}`,
            metadata: {
              kind: "inventory_removal",
              inventory_item_id: inventoryItemId,
              card_id: item.card_id,
              card_name: cardName,
              value_at_obtained: value,
            },
            status: "completed",
          },
        });
      }
      return updated.count;
    });
  } catch (err) {
    console.error("[removeOneInventoryItem] delete failed:", err);
    return {
      ok: false,
      error:
        err instanceof Error
          ? `Failed to remove item: ${err.message}`
          : "Failed to remove inventory item",
    };
  }

  if (deletedCount !== 1) {
    return {
      ok: false,
      error: "Could not remove item — it may have changed since you opened this dialog",
    };
  }

  await createAdminAuditEvent({
    adminUserId,
    eventType: "inventory_item_deleted",
    targetUserId: userId,
    metadata: {
      inventoryItemId: item.id,
      cardId: item.card_id,
      cardName,
      valueAtObtained: value,
      reason,
    },
  });

  return { ok: true };
}

const bulkDeleteInventorySchema = z.object({
  userId: z.string().min(1),
  inventoryItemIds: z
    .array(z.string().uuid())
    .min(1, { message: "Select at least one item" })
    .max(200, { message: "Remove at most 200 items at once" }),
  reason: z
    .string()
    .trim()
    .min(INVENTORY_DELETE_MIN_REASON_CHARS, {
      message: `Reason must be at least ${INVENTORY_DELETE_MIN_REASON_CHARS} characters`,
    })
    .max(5000),
  totpCode: z.string().trim().min(1, { message: "2FA code is required" }),
});

/**
 * Remove MANY inventory items in one go (the multi-select flow). Verifies
 * permission + 2FA ONCE, then removes each selected item independently —
 * invalid ones (sold / locked / tied to a withdrawal) are skipped and
 * counted rather than failing the whole batch. Each successful removal
 * writes its own visible ledger record + audit event.
 */
export async function bulkDeleteUserInventoryItems(data: {
  userId: string;
  inventoryItemIds: string[];
  reason: string;
  totpCode: string;
}): Promise<
  | { success: true; deleted: number; skipped: number; firstError?: string }
  | { success: false; error: string }
> {
  const db = await getDb();
  const session = await requirePageAccess("/users");

  const parsed = bulkDeleteInventorySchema.safeParse(data);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  if (session.role !== "admin") {
    const perms = await adminDb.admin_users.findUnique({
      where: { id: session.userId },
      select: { allowed_pages: true },
    });
    if (!perms || !canUserAdjustBalance(perms.allowed_pages)) {
      return {
        success: false,
        error: "You do not have permission to remove inventory items",
      };
    }
  }

  try {
    await require2FA(session.userId, parsed.data.totpCode);
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "2FA verification failed",
    };
  }

  // De-dupe ids so a doubled selection can't double-count.
  const ids = [...new Set(parsed.data.inventoryItemIds)];
  let deleted = 0;
  let skipped = 0;
  let firstError: string | undefined;
  for (const id of ids) {
    const r = await removeOneInventoryItem(
      db,
      session.userId,
      parsed.data.userId,
      id,
      parsed.data.reason,
    );
    if (r.ok) {
      deleted += 1;
    } else {
      skipped += 1;
      if (!firstError) firstError = r.error;
    }
  }

  revalidatePath(`/users/${parsed.data.userId}`);

  if (deleted === 0) {
    return {
      success: false,
      error: firstError ?? "No items could be removed",
    };
  }
  return { success: true, deleted, skipped, firstError };
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
    const currentUser = await db.user.findUnique({
      where: { id: userId },
      select: { referred_by: true, affiliate_code: true },
    });

    await db.$transaction([
      db.user.update({
        where: { id: userId },
        data: {
          referred_by: null,
          // Drop the active code so FUTURE wager affiliate income stops
          // routing to the old owner. Historical affiliate_code_usages
          // rows are kept as audit (see dialog copy).
          affiliate_code: null,
          affiliate_code_active: false,
          affiliate_code_expires_at: null,
        },
      }),
      // Pending frontend lock / cookie queue — drop so the site can't
      // re-apply the old code from a stale queue row.
      db.affiliate_code_queue.deleteMany({ where: { user_id: userId } }),
    ]);

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
      metadata: {
        previousReferrerId: currentUser?.referred_by ?? null,
        clearedCode: currentUser?.affiliate_code ?? null,
      },
    });

    revalidatePath(`/users/${userId}`);
    revalidateTag(`user-attribution-${userId}`);
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
  // 2FA is required to mutate user XP — matches the BalanceAdjustDialog
  // pattern. The TOTP secret is verified server-side against the calling
  // admin's `admin_users` row via `require2FA` before any write.
  totpCode: z.string().min(1, "2FA code is required"),
});

export async function adjustXp(data: {
  userId: string;
  amount: number;
  reason: string;
  totpCode: string;
}) {
  const db = await getDb();
  const session = await requirePageAccess("/users");
  await requireCapability(session, "__can_adjust_xp", "adjust user XP");
  const parsed = adjustXpSchema.parse(data);

  // 2FA gate — must run BEFORE the user_statistics write so a missing /
  // invalid TOTP code can't slip an XP mutation through. `require2FA`
  // throws on missing / invalid codes; the client surfaces the message
  // via the existing try/catch + toast pattern.
  await require2FA(session.userId, parsed.totpCode);

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

// The rows-per-page values the transactions table's selector offers. The
// server clamps the requested `perPage` to this set so a client can't drive
// an unbounded `take` (a hand-crafted call asking for 1e6 rows would scan +
// serialize the user's whole ledger). 100 is the largest real option, so it
// doubles as the cap.
const TX_PER_PAGE_OPTIONS = [10, 20, 50, 100] as const;
const TX_PER_PAGE_DEFAULT = 10;
const TX_PER_PAGE_MAX = Math.max(...TX_PER_PAGE_OPTIONS);

export async function fetchUserTransactions(
  userId: string,
  page: number,
  perPage: number,
  filters?: { type?: string; types?: string[]; status?: string; dateFrom?: string; dateTo?: string }
) {
  await requirePageAccess("/users");
  // Sanitize pagination args at the action boundary (never trust the client):
  //  - page  → integer ≥ 1 (a bad value lands on page 1, not past the end).
  //  - perPage → one of the real selector options; anything else (incl. an
  //    unbounded huge value) falls back to the default 10. This keeps the
  //    server `take` bounded by TX_PER_PAGE_MAX.
  const safePage =
    Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1;
  const safePerPage = (TX_PER_PAGE_OPTIONS as readonly number[]).includes(
    perPage,
  )
    ? perPage
    : Math.min(
        TX_PER_PAGE_MAX,
        Number.isFinite(perPage) && perPage >= 1
          ? Math.floor(perPage)
          : TX_PER_PAGE_DEFAULT,
      );
  return getUserTransactions(userId, safePage, safePerPage, filters);
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
// VIP Tags — admin-CRM metadata on packy.gg users
// ---------------------------------------------------------------------------
// Admin-CRM tag system (Contacted VIP / Confirmed VIP / Wager Abuser).
// Stored in the
// admin DB only — no main-DB write. The full set lives in the
// `admin_user_tags` table; this action only knows about the allow-listed
// tag values. Adding a new tag = update both the Zod enum here AND the
// CHECK constraint in
// prisma/admin/migrations/20260513000000_admin_user_tags/migration.sql.

const USER_TAG_VALUES = [
  "contacted_vip",
  "confirmed_vip",
  "wager_abuser",
  "fraud_abuser",
] as const;
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
  revalidatePath("/creator-hub/wager-abusers");
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
  revalidatePath("/creator-hub/wager-abusers");
  return { success: true };
}
