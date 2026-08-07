"use server";

import { pgArrayParam } from "@/lib/drizzle-array-param";
import crypto from "crypto";
import { revalidatePath, revalidateTag, unstable_cache } from "next/cache";
import { z } from "zod";
import {
  getPrimaryDrizzleDb,
  getReadDrizzleDb,
  type MainDrizzleDb,
} from "@/lib/db";
import { adminDrizzle, sql } from "@/lib/drizzle";
import { requireAdmin, requirePageAccess } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { getUserInventory, getUserTransactions, getCreatorReferralClicks, getCreatorCodeUsages, getCreatorWithdrawalLimits, getUserAttributionJourney, getProvablyFairResults, getSeedRotationHistory, getUserBalanceHistory } from "@/lib/queries/users";
import type { AttributionJourneyEntry } from "@/lib/queries/users";
import { safeQuery } from "@/lib/errors/safe-query";
import {
  createAdminAuditEvent,
  createAdminAuditEventDurable,
} from "@/lib/admin-audit";
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
  BUGS_ADJUSTMENT_MIN_REASON_CHARS,
  REMOVE_LOCKED_BALANCE_MIN_REASON_CHARS,
  FRAUD_ABUSE_MIN_REASON_CHARS,
  isBalanceAdjustmentCategory,
  isCreatorLinkedAdjustmentCategory,
  isRemovalOnlyAdjustmentCategory,
  type BalanceAdjustmentCategory,
} from "@/lib/balance-adjustment-categories";
import type { SessionPayload } from "@/lib/session";
import { isEverCreator } from "@/app/(admin)/creators/_queries/list-ex-creators";
import {
  canEditBalanceAdjustments,
  requireBalanceAdjustmentEditAdmin,
} from "@/lib/balance-adjustment-edit/motha-gate";
import { generateRandomAffiliateCode } from "@/lib/affiliate/generate-code";
import {
  isSiteRole,
  pickPrimaryRole,
  writeUserWithRoles,
  type SiteRole,
} from "@/lib/user-site-roles";
import { isSafeWebhookUrl } from "@/lib/security/webhook-url";
import { postgresTimestamp, postgresTimestampIso } from "@/lib/postgres-runtime";
import type { KenoGameDetails } from "./user-tabs-types";

/**
 * Bust BOTH the route segment AND the per-user `unstable_cache` entries for
 * a /users/[id] write. `revalidatePath` alone does NOT drop unstable_cache
 * entries (it only invalidates the Next.js route segment / RSC response),
 * so without this helper a mutation leaves the cached `getUserDetailCached`
 * / `getUserPnlBreakdownCached` / financial-tx / xp / reward-
 * pack-open entries serving stale numbers until their TTL expires (25–60s).
 *
 * Every per-user cache in `users-detail-cache.ts` / `users-xp-purchases.ts`
 * / `users-reward-pack-opens.ts` carries the `users-detail-${userId}` tag,
 * so this single call invalidates them all atomically — without touching
 * unrelated users' cached entries (no global `users-detail` flush).
 */
function invalidateUserCaches(userId: string): void {
  revalidatePath(`/users/${userId}`);
  revalidateTag(`users-detail-${userId}`);
}

/**
 * Map an unexpected balance-adjustment exception to a SAFE, category-
 * distinguishing client message. The real exception (with stack, query
 * text, and any embedded connection detail) is logged server-side by the
 * caller — this returns ONLY a coarse, non-sensitive category so an admin
 * can tell a schema/DB fault from a generic crash, instead of the old
 * opaque "please try again" black box.
 *
 * Critically this names the schema-drift case (raw 42703 "column does
 * not exist" / raw 42703) that caused the original incident — a stale
 * `balances` schema mirror requesting a column the live game DB had
 * renamed. If it ever recurs, the toast itself says "database schema
 * mismatch" so it's diagnosable without log access. No secrets, no query
 * text, no stack ever reach the client.
 */
function classifyAdjustBalanceError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as Error & { code?: string }).code;
    if (code === "42703") {
      return "Balance adjustment failed — database schema mismatch (a column the admin expects is missing on the live DB). This needs a code/schema fix, not a retry.";
    }
    if (code) {
      return `Balance adjustment failed — database error (${code}). Please report this; a retry alone may not help.`;
    }
  }
  return "Balance adjustment failed — please try again";
}

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
    // creator_vip_reward — the admin-DB `creator_reward_claims` row (and its
    // program) that authorized this payout. Stamped onto the ledger metadata
    // so the prod row is self-describing: you can go from a credit straight
    // back to the claim + program without a cross-DB hunt. Supplied ONLY by
    // `approveCreatorRewardClaim`, never by the dialog.
    vipClaimId: z.string().uuid().optional(),
    vipProgramId: z.string().uuid().optional(),
    // creator_vip_reward — TRACE fields. The affiliate codes the program
    // accrued under, its name, and which leg paid. Stamped so a ledger row
    // answers "which creator, under which code, for what" on its own; the
    // creator-spend reporting reads these instead of re-joining the admin DB
    // per row. Supplied ONLY by `approveCreatorRewardClaim`.
    creatorCodes: z.array(z.string().trim().min(1).max(64)).max(25).optional(),
    creatorProgramName: z.string().trim().max(120).optional(),
    creatorRewardLeg: z.string().trim().max(32).optional(),
    // chat_raffle — the admin-DB round + prize place this payout settles.
    // Stamped onto the ledger metadata so a prod row is self-describing: from
    // the credit you can reach the exact draw that authorized it. Supplied
    // ONLY by `payChatRafflePrize`, never by the dialog (the category is not
    // in SELECTABLE_ADJUSTMENT_CATEGORY_KEYS).
    chatRaffleRoundId: z.string().uuid().optional(),
    chatRafflePosition: z.number().int().min(1).max(100).optional(),
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
  /** Set only for `creator_vip_reward` — the claim + program that authorized it. */
  vipClaimId: string | null;
  vipProgramId: string | null;
  /**
   * Set only for `creator_vip_reward` — the codes/program/leg the accrual ran
   * under, so creator spend is traceable per CODE and not just per creator id.
   */
  creatorCodes: string[] | null;
  creatorProgramName: string | null;
  creatorRewardLeg: string | null;
  /** Set only for `chat_raffle` — the round + place this payout settles. */
  chatRaffleRoundId: string | null;
  chatRafflePosition: number | null;
};

/**
 * Enforce the per-category required inputs (the table in CLAUDE/spec):
 *   deposit_problem → coin type + tx hash
 *   giveaway        → a Twitter OR Discord link
 *   bonus           → exact reason, min 20 chars
 *   bugs            → explanation, min 30 chars
 *   reload          → (no input)
 *   trivia          → (no input)
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
    vipClaimId: null,
    vipProgramId: null,
    creatorCodes: null,
    creatorProgramName: null,
    creatorRewardLeg: null,
    chatRaffleRoundId: null,
    chatRafflePosition: null,
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
    case "trivia": {
      // No required inputs.
      return { ok: true, meta: base };
    }
    case "chat_raffle": {
      // Not hand-pickable (excluded from SELECTABLE_ADJUSTMENT_CATEGORY_KEYS):
      // the only writer is `payChatRafflePrize`, which always supplies the
      // drawn round + place. Require them, so a hypothetical future caller
      // can't mint an untraceable "chat raffle" credit.
      if (!d.chatRaffleRoundId || d.chatRafflePosition === undefined) {
        return {
          ok: false,
          error: "Chat-raffle payouts must reference a drawn round and place",
        };
      }
      return {
        ok: true,
        meta: {
          ...base,
          chatRaffleRoundId: d.chatRaffleRoundId,
          chatRafflePosition: d.chatRafflePosition,
        },
      };
    }
    case "withdrawal_failed": {
      // Optional note — the operator usually pastes the failed withdrawal id
      // (or a short reference), but no minimum length is enforced: picking
      // the category itself is the signal, the note is just context.
      const reasonText = (d.reasonText ?? "").trim();
      return { ok: true, meta: { ...base, reasonText: reasonText || null } };
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
    case "creator_vip_reward": {
      // Creator-linked CREDIT only — this category pays a user out for a
      // wager milestone reached under a creator's code, so a debit makes no
      // sense and would silently corrupt the consumed-wager accounting that
      // `creator_reward_claims` keeps on the admin side.
      //
      // NOT admin-selectable (see SELECTABLE_ADJUSTMENT_CATEGORY_KEYS): the
      // only caller is `approveCreatorRewardClaim`, which supplies the
      // creator id from the program row. Reaching here from anywhere else
      // means the invariant has already been broken, so the guards below are
      // deliberately absolute rather than friendly.
      if (amount <= 0) {
        return {
          ok: false,
          error: "Creator VIP rewards must credit balance (positive amount)",
        };
      }
      const creatorId = (d.creatorId ?? "").trim();
      if (!creatorId) {
        return {
          ok: false,
          error: "Creator VIP reward requires a linked creator",
        };
      }
      if (!d.vipClaimId || !d.vipProgramId) {
        return {
          ok: false,
          error: "Creator VIP reward requires the authorizing claim",
        };
      }
      return {
        ok: true,
        meta: {
          ...base,
          creatorId,
          vipClaimId: d.vipClaimId,
          vipProgramId: d.vipProgramId,
          creatorCodes:
            d.creatorCodes && d.creatorCodes.length > 0 ? d.creatorCodes : null,
          creatorProgramName: d.creatorProgramName ?? null,
          creatorRewardLeg: d.creatorRewardLeg ?? null,
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
    creatorId?: string;
    vipClaimId?: string;
    vipProgramId?: string;
    /** Creator-spend trace — see `adjustmentDetailsSchema`. */
    creatorCodes?: string[];
    creatorProgramName?: string;
    creatorRewardLeg?: string;
    /** Chat-raffle payout trace — see `adjustmentDetailsSchema`. */
    chatRaffleRoundId?: string;
    chatRafflePosition?: number;
  };
}): Promise<
  { success: true; ledgerTxId: string } | { success: false; error: string }
> {
  const db = await getPrimaryDrizzleDb();
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

  // BACKSTOP for the removal-only (debit) invariant, driven by the
  // `REMOVAL_ONLY_ADJUSTMENT_CATEGORY_KEYS` set rather than a per-category
  // `case` arm. Every removal-only category in `validateAdjustmentCategory`
  // above already rejects `amount >= 0` with its own specific message (which
  // still wins, because this runs after), so this changes nothing today —
  // it exists so a category ADDED to the removal-only set later cannot reach
  // the ledger write as a CREDIT just because its `case` arm forgot the sign
  // check. That would be silent: `countedAdjustmentSqlPredicate`
  // (`balance-adjustment-categories.ts`) pins `amount > 0` AND excludes the
  // removal-only keys, so a positive removal-only row is invisible to the
  // whole reward-cost model. Mirrors the edit path's guard verbatim.
  if (isRemovalOnlyAdjustmentCategory(parsed.category) && parsed.amount > 0) {
    return {
      success: false,
      error: "Removal-only categories require a negative adjustment amount",
    };
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
    const linkedUser = (await db.execute<{ id: string; role: string }>(sql`
      SELECT id, role::text AS role FROM "user"
      WHERE id = ${meta.creatorId} LIMIT 1
    `)).rows[0];
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

    // PER-CODE attribution for the categories that don't supply their own
    // codes (leaderboard / official_stream come from the dialog, which only
    // picks a creator). Resolve the codes that creator owned AT PAYMENT TIME
    // and stamp them, so creator spend can be split per code straight off the
    // ledger row instead of re-deriving it from whatever the creator owns
    // today — codes get added and removed, and a historic payout must keep
    // reading the way it was made. `creator_vip_reward` already passes the
    // program's own codes, which are narrower, so it is left as-is.
    //
    // Index-served: EXPLAIN ANALYZE on prod (2026-07-23) gives an Index Scan
    // on `idx_affiliate_codes_user_created_at` (user_id), 0.24 ms. NOTE that
    // index is not represented in the Drizzle schema — it exists on the live
    // DB only, so don't "fix" the schema by assuming it's missing.
    if (!meta.creatorCodes) {
      const ownedCodes = (await db.execute<{ code: string }>(sql`
        SELECT code FROM affiliate_codes WHERE user_id = ${meta.creatorId}
        ORDER BY code ASC LIMIT 25
      `)).rows;
      if (ownedCodes.length > 0) {
        meta.creatorCodes = ownedCodes.map((c) => c.code.toUpperCase());
      }
    }
  }

  // Admins can always adjust; non-admins need the __can_adjust_balance capability
  if (session.role !== "admin") {
    const perms = (await adminDrizzle.execute<{ allowed_pages: string[] }>(sql`
      SELECT allowed_pages FROM admin_users
      WHERE id = ${session.userId}::uuid LIMIT 1
    `)).rows[0];
    if (!perms || !canUserAdjustBalance(perms.allowed_pages ?? [])) {
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
  let currentBalanceText = "0";
  let newBalanceText = "0";
  const affectsLockedBalance = parsed.category === "remove_locked_balance";
  // Capture the ledger row id so the admin-side metadata write below can
  // cross-reference it.
  let ledgerTxId: string = crypto.randomUUID();
  let reusedCreatorRewardLedger = false;

  // Resolve the admin-adjustment wager requirement (FROZEN per credit, exactly
  // the model deposits/bonuses use on the backend). Read the global site_config
  // knob first, then check for a per-user override in user_wager_requirements —
  // matching resolveSourceWagerBps() on the backend. Per-user wins if set.
  // Missing/invalid → 1× (10000). Only positive credits to AVAILABLE balance
  // accrue debt; removals and locked-balance ops never do.
  let adminAdjustmentWagerBps = 10_000;
  try {
    const cfg = (await db.execute<{ value: unknown }>(sql`
      SELECT value FROM site_config
      WHERE key = 'withdrawal_admin_adjustment_wager_requirement_bps' LIMIT 1
    `)).rows[0];
    if (cfg) {
      const n = Number(cfg.value);
      if (Number.isFinite(n) && n >= 0) {
        adminAdjustmentWagerBps = Math.round(n);
      }
    }
  } catch {
    // Keep the 1× default if the config row can't be read.
  }
  // Per-user override: admin_adjustment_wager_requirement_bps in
  // user_wager_requirements takes precedence over the global config.
  try {
    const rows = (await db.execute<{ admin_adjustment_wager_requirement_bps: number | null }>(sql`
      SELECT admin_adjustment_wager_requirement_bps
      FROM user_wager_requirements
      WHERE user_id = ${parsed.userId}
      LIMIT 1`)).rows;
    const override = rows[0]?.admin_adjustment_wager_requirement_bps;
    if (override !== null && override !== undefined && Number.isFinite(override) && override >= 0) {
      adminAdjustmentWagerBps = Math.round(override);
    }
  } catch {
    // If user_wager_requirements doesn't have this column yet (pre-migration),
    // fall back to the global bps already resolved above.
  }
  const accruesWagerDebt =
    !affectsLockedBalance && parsed.amount > 0 && adminAdjustmentWagerBps > 0;
  try {
    await db.transaction(async (tx) => {
      if (meta.vipClaimId) {
        // A claim approval spans ADMIN and MAIN, so there is no cross-database
        // unique constraint available. Serialize on the immutable claim id and
        // check the MAIN ledger while holding that lock. This closes the last
        // crash/retry race: even if two workers both reach the money path, only
        // the first may change the balance.
        await tx.execute(sql`
          SELECT pg_advisory_xact_lock(hashtextextended(${meta.vipClaimId}, 0))
        `);
        const existing = (
          await tx.execute<{ id: string }>(sql`
            SELECT id
            FROM ledger_transactions
            WHERE user_id = ${parsed.userId}
              AND type::text = 'admin_balance_adjustment'
              AND status::text = 'completed'
              AND metadata->>'vip_claim_id' = ${meta.vipClaimId}
            ORDER BY created_at DESC
            LIMIT 1
          `)
        ).rows[0];
        if (existing) {
          ledgerTxId = existing.id;
          reusedCreatorRewardLedger = true;
          return;
        }
      }

      const balance = (await tx.execute<{
        id: string; available_balance: string; locked_balance: string;
      }>(sql`
        SELECT id, available_balance::text, locked_balance::text
        FROM balances WHERE user_id = ${parsed.userId} FOR UPDATE
      `)).rows[0];
      if (!balance) throw new Error("User balances not found");

      currentBalanceText = balance.available_balance;
      currentBalance = Number(currentBalanceText);
      let ledgerMetadata: Record<string, unknown>;
      if (affectsLockedBalance) {
        const updated = await tx.execute<{ locked_balance: string }>(sql`
          UPDATE balances
          SET locked_balance = locked_balance::numeric + ${parsed.amount}::numeric,
              version = version + 1, updated_at = NOW()
          WHERE id = ${balance.id}::uuid
            AND locked_balance::numeric + ${parsed.amount}::numeric >= 0
          RETURNING locked_balance::text
        `);
        if (updated.rows.length === 0) {
          throw new Error("Resulting locked balance would be negative");
        }
        newBalance = currentBalance;
        newBalanceText = currentBalanceText;
        ledgerMetadata = {
          adjustment_category: parsed.category,
          balance_target: "locked",
        };
      } else {
        const updated = await tx.execute<{ available_balance: string }>(sql`
          UPDATE balances
          SET available_balance = available_balance::numeric + ${parsed.amount}::numeric,
              version = version + 1,
              wager_requirement_remaining =
                COALESCE(wager_requirement_remaining, 0)::numeric +
                CASE WHEN ${accruesWagerDebt}
                  THEN ${parsed.amount}::numeric * ${adminAdjustmentWagerBps}::numeric / 10000
                  ELSE 0 END,
              updated_at = NOW()
          WHERE id = ${balance.id}::uuid
            AND available_balance::numeric + ${parsed.amount}::numeric >= 0
          RETURNING available_balance::text
        `);
        if (updated.rows.length === 0) {
          throw new Error("Resulting balance would be negative");
        }
        newBalanceText = updated.rows[0]!.available_balance;
        newBalance = Number(newBalanceText);
        ledgerMetadata = {
          adjustment_category: parsed.category,
          ...(isCreatorLinkedAdjustmentCategory(parsed.category) && meta.creatorId
            ? { creator_id: meta.creatorId, creator_spend: true } : {}),
          ...(accruesWagerDebt ? { wager_requirement_bps: adminAdjustmentWagerBps } : {}),
          ...(meta.vipClaimId && meta.vipProgramId
            ? { vip_claim_id: meta.vipClaimId, vip_program_id: meta.vipProgramId } : {}),
          ...(meta.creatorCodes ? { creator_codes: meta.creatorCodes } : {}),
          ...(meta.creatorProgramName ? { creator_program_name: meta.creatorProgramName } : {}),
          ...(meta.creatorRewardLeg ? { creator_reward_leg: meta.creatorRewardLeg } : {}),
          ...(meta.chatRaffleRoundId && meta.chatRafflePosition !== null
            ? { chat_raffle_round_id: meta.chatRaffleRoundId,
                chat_raffle_position: meta.chatRafflePosition } : {}),
        };
      }
      await tx.execute(sql`
        INSERT INTO ledger_transactions (
          id, user_id, type, amount, balance_before, balance_after,
          description, metadata, status
        ) VALUES (
          ${ledgerTxId}::uuid, ${parsed.userId}, 'admin_balance_adjustment',
          ${parsed.amount}, ${currentBalanceText}::numeric, ${newBalanceText}::numeric,
          ${`Admin adjustment: ${parsed.reason}`},
          ${JSON.stringify(ledgerMetadata)}::jsonb, 'completed'
        )
      `);
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
    // ALWAYS log the real exception server-side so this is never again a
    // black box (the prior incident was a swallowed 42703 schema-drift
    // error — `SELECT ... bonus_points` on a DB that had renamed the
    // column to `shards`). The classifier below turns the opaque "please
    // try again" into a SAFE, category-distinguishing client message
    // (db-schema vs db vs unknown) WITHOUT leaking the connection string,
    // query text, or stack — those stay in the server log only.
    console.error("[adjustBalance] Transaction failed:", err);
    return { success: false, error: classifyAdjustBalanceError(err) };
  }

  if (reusedCreatorRewardLedger) {
    return { success: true, ledgerTxId };
  }

  // DURABLE audit write. The MAIN-DB money transaction has ALREADY committed
  // by this line. The plain `createAdminAuditEvent` THREW on any ADMIN-DB
  // hiccup, and that throw escaped the action: the client saw a generic
  // failure with the dialog still filled in, the operator retried, and the
  // balance moved a SECOND time. `createAdminAuditEventDurable` retries,
  // falls back to `admin_audit_write_failures`, alerts, and never throws — a
  // lost audit row can no longer turn one credit into two. (The
  // less-important `admin_balance_adjustment_meta` insert below was already
  // try/caught for exactly this reason.)
  const auditOutcome = await createAdminAuditEventDurable({
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
      // The wager requirement frozen onto this credit (bps of the amount),
      // recorded for the audit trail. Omitted when no debt was accrued.
      ...(accruesWagerDebt
        ? { wagerRequirementBps: adminAdjustmentWagerBps }
        : {}),
    },
  });
  if (auditOutcome.status !== "recorded") {
    console.error(
      "[adjustBalance] audit event did not reach admin_audit_events (ledger already committed):",
      { status: auditOutcome.status, ledgerTxId },
    );
  }

  // Persist the RICH admin-side metadata (category-specific inputs) to the
  // admin DB. Best-effort — we already wrote the ledger row + the canonical
  // category onto it, so a metadata-row failure here shouldn't fail the
  // whole adjustment (the user got their balance, and the GGR/cost
  // classification reads the ledger metadata, not this table). A separate
  // console.error surfaces a row-write failure without blocking the toast.
  try {
    await adminDrizzle.execute(sql`
      INSERT INTO admin_balance_adjustment_meta (
        admin_user_id, target_user_id, ledger_tx_id, category, amount_usd,
        coin_type, tx_hash, social_link, reason_text, lossback_pct, pnl_7d_usd
      ) VALUES (
        ${session.userId}, ${parsed.userId}, ${ledgerTxId}, ${parsed.category},
        ${parsed.amount}, ${meta.coinType ?? null}, ${meta.txHash ?? null},
        ${meta.socialLink ?? null}, ${meta.reasonText ?? null},
        ${meta.lossbackPercent ?? null}, ${meta.pnl7dUsd ?? null}
      )
    `);
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
      await adminDrizzle.execute(sql`
        INSERT INTO admin_giveaway_actions (
          admin_user_id, target_user_id, amount_usd, source_url,
          source_type, reason, ledger_tx_id
        ) VALUES (
          ${session.userId}::uuid, ${parsed.userId}, ${parsed.amount},
          ${meta.giveawaySource.url}, ${meta.giveawaySource.sourceType},
          ${parsed.reason}, ${ledgerTxId}
        )
      `);
    } catch (err) {
      console.error(
        "[adjustBalance] giveaway-row write failed (ledger already committed):",
        err,
      );
    }
  }

  // Fire balance_fill webhooks (non-blocking)
  adminDrizzle
    .execute<{ url: string; secret: string }>(sql`
      SELECT url, secret FROM creator_webhooks
      WHERE target_user_id = ${parsed.userId}
        AND type = 'balance_fill' AND enabled = TRUE
    `)
    .then(({ rows: webhooks }) => {
      for (const webhook of webhooks) {
        if (!isSafeWebhookUrl(webhook.url)) continue;
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

  invalidateUserCaches(parsed.userId);
  // `ledgerTxId` is returned so a programmatic caller can persist the link to
  // the row it just created (see `approveCreatorRewardClaim`, which stores it
  // on the claim). Purely additive — the dialog ignores it.
  return { success: true, ledgerTxId };
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

  const db = await getPrimaryDrizzleDb();
  const row = (await db.execute<{
    id: string; type: string; amount: string; description: string; metadata: unknown;
  }>(sql`
    SELECT id, type::text, amount::text, description, metadata
    FROM ledger_transactions
    WHERE id = ${ledgerTxId}::uuid AND user_id = ${targetUserId}
    LIMIT 1
  `)).rows[0];

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
    const metaRow = (await adminDrizzle.execute<{
      category: string; reason_text: string | null;
    }>(sql`
      SELECT category, reason_text FROM admin_balance_adjustment_meta
      WHERE ledger_tx_id = ${ledgerTxId} AND target_user_id = ${targetUserId}
      LIMIT 1
    `)).rows[0];
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

  const db = await getPrimaryDrizzleDb();
  const row = (await db.execute<{
    id: string; type: string; amount: string; description: string; metadata: unknown;
  }>(sql`
    SELECT id, type::text, amount::text, description, metadata
    FROM ledger_transactions
    WHERE id = ${parsed.ledgerTxId}::uuid AND user_id = ${parsed.targetUserId}
    LIMIT 1
  `)).rows[0];

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
    const updated = await db.execute(sql`
      UPDATE ledger_transactions
      SET description = ${newDescription},
          metadata = ${JSON.stringify(nextMetadata)}::jsonb,
          updated_at = NOW()
      WHERE id = ${parsed.ledgerTxId}::uuid AND user_id = ${parsed.targetUserId}
      RETURNING id
    `);
    if (updated.rows.length === 0) throw new Error("Adjustment not found");
  } catch (err) {
    console.error("[updateBalanceAdjustmentMeta] ledger update failed:", err);
    return { success: false, error: "Failed to update adjustment" };
  }

  if (nextCategory) {
    try {
      await adminDrizzle.execute(sql`
        WITH changed AS (
          UPDATE admin_balance_adjustment_meta
          SET category = ${nextCategory}, reason_text = ${parsed.reason.trim()}
          WHERE ledger_tx_id = ${parsed.ledgerTxId}
            AND target_user_id = ${parsed.targetUserId}
          RETURNING 1
        )
        INSERT INTO admin_balance_adjustment_meta (
          admin_user_id, target_user_id, ledger_tx_id, category,
          amount_usd, reason_text
        )
        SELECT ${session.userId}, ${parsed.targetUserId}, ${parsed.ledgerTxId},
               ${nextCategory}, ${Number(row.amount)}, ${parsed.reason.trim()}
        WHERE NOT EXISTS (SELECT 1 FROM changed)
      `);
    } catch (err) {
      console.error(
        "[updateBalanceAdjustmentMeta] admin meta update failed (ledger already committed):",
        err,
      );
    }

    if (nextCategory === "giveaway") {
      try {
        await adminDrizzle.execute(sql`
          UPDATE admin_giveaway_actions SET reason = ${parsed.reason.trim()}
          WHERE ledger_tx_id = ${parsed.ledgerTxId}
        `);
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

  invalidateUserCaches(parsed.targetUserId);
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
// "Instant, no unlock time" applies to a user who has NO lock: `unlock_at`
// stays NULL and the parked funds are immediately unlockable, which is the
// one-click anti-tilt pause this action exists for.
//
// An EXISTING `unlock_at` is now PRESERVED, not cleared. The old version
// wrote `unlock_at = NULL` unconditionally, so parking $1 in the vault
// silently voided a live time-lock — releasing funds that `extendVaultLock`
// (the neighbouring action that only pushes the SAME timestamp forward)
// gates behind `__can_force_vault_unlock` + a 2FA code. Adding to the vault
// must never be a way to unlock it, so the timer is left alone here and
// loosening it stays exclusively on the gated actions.
//
// Total balance is unchanged. Reversible: admins can adjust back via
// the existing balance-adjust flow if needed.
export async function moveBalanceToVault(
  userId: string,
): Promise<
  | { success: true; movedAmount: number }
  | { success: false; error: string }
> {
  const db = await getPrimaryDrizzleDb();
  const session = await requirePageAccess("/users");
  // Reuses the same gate as the adjust-balance action — anyone with
  // permission to manipulate a user's balance is permitted to park
  // it in the vault. Admins always pass; non-admins need the explicit
  // capability on their role.
  if (session.role !== "admin") {
    const perms = (await adminDrizzle.execute<{ allowed_pages: string[] }>(sql`
      SELECT allowed_pages FROM admin_users
      WHERE id = ${session.userId}::uuid LIMIT 1
    `)).rows[0];
    if (!perms || !canUserAdjustBalance(perms.allowed_pages ?? [])) {
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
  let availableText = "0";
  let preservedUnlockAt: string | null = null;
  try {
    await db.transaction(async (tx) => {
      const b = (await tx.execute<{
        id: string; available_balance: string; locked_balance: string;
        unlock_at: Date | string | null;
      }>(sql`
        SELECT id, available_balance::text, locked_balance::text, unlock_at
        FROM balances WHERE user_id = ${userId} FOR UPDATE
      `)).rows[0];
      if (!b) throw new Error("User has no balance row");

      // Recorded in the audit trail so it is visible that a pre-existing
      // time-lock was carried over rather than dropped.
      preservedUnlockAt = b.unlock_at
        ? postgresTimestampIso(
            postgresTimestamp(b.unlock_at, "moveBalanceToVault.unlock_at"),
            "moveBalanceToVault.unlock_at",
          )
        : null;

      availableText = b.available_balance;
      available = Number(availableText);
      if (available <= 0) {
        throw new Error("Available balance is already 0 — nothing to move");
      }

      // `unlock_at` is deliberately NOT touched. The previous version set it
      // to NULL, which VOIDED an existing vault time-lock — the same
      // timestamp that `extendVaultLock` requires `__can_force_vault_unlock`
      // + a 2FA code merely to push FORWARD. Parking more balance in the
      // vault must never be a back door for releasing what is already locked,
      // so an existing lock survives untouched and a user with no lock stays
      // at NULL (the "instant, no unlock time" default this action was built
      // for). Loosening a lock stays exclusively on the gated actions.
      await tx.execute(sql`
        UPDATE balances SET available_balance = 0,
          locked_balance = locked_balance::numeric + ${availableText}::numeric,
          version = version + 1, updated_at = NOW()
        WHERE id = ${b.id}::uuid
      `);
      await tx.execute(sql`
        INSERT INTO ledger_transactions (
          id, user_id, type, amount, balance_before, balance_after,
          description, status
        ) VALUES (
          ${crypto.randomUUID()}::uuid, ${userId}, 'vault_lock',
          ${`-${availableText}`}::numeric, ${availableText}::numeric, 0,
          'Admin moved entire balance to vault (no unlock time)', 'completed'
        )
      `);
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
    metadata: {
      amount: available,
      instant: preservedUnlockAt === null,
      preserved_unlock_at: preservedUnlockAt,
    },
  });

  invalidateUserCaches(userId);
  return { success: true, movedAmount: available };
}

// ---------------------------------------------------------------------------
// Extend vault lock — operator-controlled "soft remove" (no money moves)
// ---------------------------------------------------------------------------
//
// What it does: pushes `balances.unlock_at` to NOW + 10 years on a single
// MAIN-DB UPDATE. Money stays put — `locked_balance` and `available_balance`
// are NOT touched. The vault pool is effectively frozen (user can't withdraw
// it until 2036) without writing a ledger row, because no balance moved.
//
// Owner-authorized MAIN write — same precedent as `moveBalanceToVault`
// (legacy pre-policy code). Gated by capability + TOTP + admin audit.
//
// Returns the new ISO unlock timestamp + the locked amount at the moment of
// the freeze so the dialog can show "Vault locked until <date>".
export async function extendVaultLock(
  userId: string,
  totpCode: string,
  reason?: string,
): Promise<
  | { success: true; new_unlock_at: string; locked_amount_usd: string }
  | { success: false; error: string }
> {
  const db = await getPrimaryDrizzleDb();
  const session = await requirePageAccess("/users");
  // Capability gate — admins / owner bypass automatically inside
  // requireCapability. Non-admins need the explicit
  // `__can_force_vault_unlock` key on their role.
  await requireCapability(
    session,
    "__can_force_vault_unlock",
    "freeze vault balance",
  );
  await require2FA(session.userId, totpCode);

  let previousUnlockAt: Date | null = null;
  let newUnlockAt: Date | null = null;
  let lockedAmount = 0;

  try {
    await db.transaction(async (tx) => {
      const b = (await tx.execute<{
        id: string; locked_balance: string; unlock_at: Date | string | null;
      }>(sql`
        SELECT id, locked_balance::text, unlock_at
        FROM balances WHERE user_id = ${userId} FOR UPDATE
      `)).rows[0];
      if (!b) throw new Error("User has no balance row");

      lockedAmount = Number(b.locked_balance);
      if (lockedAmount <= 0) {
        throw new Error("No vault balance to freeze");
      }

      previousUnlockAt = b.unlock_at
        ? postgresTimestamp(b.unlock_at, "extendVaultLock.unlock_at")
        : null;
      // NOW + 10 years computed server-side (clock-skew safe against the
      // client — the action is the source of truth for the timestamp the
      // admin_audit metadata records).
      const stamp = new Date();
      stamp.setUTCFullYear(stamp.getUTCFullYear() + 10);
      newUnlockAt = stamp;

      // Optimistic concurrency — bail if the row moved between read and
      // write (e.g. a concurrent admin adjust / wager). Money columns are
      // intentionally untouched: this action ONLY changes the timer.
      await tx.execute(sql`
        UPDATE balances SET unlock_at = ${stamp}, version = version + 1,
          updated_at = NOW()
        WHERE id = ${b.id}::uuid
      `);
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    if (
      message === "User has no balance row" ||
      message === "No vault balance to freeze" ||
      message.includes("concurrently")
    ) {
      return { success: false, error: message };
    }
    console.error("[extendVaultLock] transaction failed:", err);
    return {
      success: false,
      error: "Failed to freeze vault balance — please try again",
    };
  }

  if (!newUnlockAt) {
    // Defence: the tx returned without throwing but never set the stamp.
    return { success: false, error: "Internal error — no unlock timestamp set" };
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "vault_lock_extended",
    targetUserId: userId,
    metadata: {
      user_id: userId,
      locked_balance_at_time: lockedAmount,
      previous_unlock_at: previousUnlockAt
        ? postgresTimestampIso(previousUnlockAt, "extendVaultLock.previousUnlockAt")
        : null,
      new_unlock_at: postgresTimestampIso(newUnlockAt, "extendVaultLock.newUnlockAt"),
      reason: reason?.trim() || null,
    },
  });

  invalidateUserCaches(userId);
  return {
    success: true,
    new_unlock_at: postgresTimestampIso(newUnlockAt, "extendVaultLock.newUnlockAt"),
    locked_amount_usd: lockedAmount.toFixed(2),
  };
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
  const db = await getPrimaryDrizzleDb();
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
    const perms = (await adminDrizzle.execute<{ allowed_pages: string[] }>(sql`
      SELECT allowed_pages FROM admin_users
      WHERE id = ${session.userId}::uuid LIMIT 1
    `)).rows[0];
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
  let balanceDeducted = 0;
  let phantomPortion = 0;
  let currentBalanceText = "0";
  let newBalanceText = "0";
  try {
    await db.transaction(async (tx) => {
      const b = (await tx.execute<{
        id: string; available_balance: string; total_withdrawn: string;
      }>(sql`
        SELECT id, available_balance::text, total_withdrawn::text
        FROM balances WHERE user_id = ${parsed.userId} FOR UPDATE
      `)).rows[0];
      if (!b) throw new Error("User balances not found");

      currentBalanceText = b.available_balance;
      currentBalance = Number(currentBalanceText);

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
      const updated = await tx.execute<{
        available_balance: string;
        balance_deducted: string;
        phantom_portion: string;
      }>(sql`
        WITH changed AS (
          UPDATE balances
          SET available_balance =
                GREATEST(available_balance::numeric - ${parsed.amountUsd}::numeric, 0),
              total_withdrawn =
                total_withdrawn::numeric + ${parsed.amountUsd}::numeric,
              version = version + 1,
              updated_at = NOW()
          WHERE id = ${b.id}::uuid
          RETURNING available_balance
        )
        SELECT available_balance::text,
               LEAST(${currentBalanceText}::numeric, ${parsed.amountUsd}::numeric)::text
                 AS balance_deducted,
               GREATEST(${parsed.amountUsd}::numeric - ${currentBalanceText}::numeric, 0)::text
                 AS phantom_portion
        FROM changed
      `);
      newBalanceText = updated.rows[0]!.available_balance;
      balanceDeducted = Number(updated.rows[0]!.balance_deducted);
      phantomPortion = Number(updated.rows[0]!.phantom_portion);

      if (balanceDeducted > 0) {
        const description =
          phantomPortion > 0
            ? `Manual withdrawal: ${parsed.reason} (total $${parsed.amountUsd.toFixed(2)}, $${balanceDeducted.toFixed(2)} from on-site)`
            : `Manual withdrawal: ${parsed.reason}`;
        await tx.execute(sql`
          INSERT INTO ledger_transactions (
            id, user_id, type, amount, balance_before, balance_after,
            description, status
          ) VALUES (
            ${crypto.randomUUID()}::uuid, ${parsed.userId},
            'admin_balance_adjustment',
            ${newBalanceText}::numeric - ${currentBalanceText}::numeric,
            ${currentBalanceText}::numeric, ${newBalanceText}::numeric,
            ${description}, 'completed'
          )
        `);
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

  // DURABLE (same reasoning as `adjustBalance`): the balance deduction +
  // `total_withdrawn` bump have already committed on MAIN. A throwing audit
  // write here would surface as a generic failure and invite a retry that
  // records the SAME payout twice.
  const auditOutcome = await createAdminAuditEventDurable({
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
  if (auditOutcome.status !== "recorded") {
    console.error(
      "[recordManualWithdrawal] audit event did not reach admin_audit_events (withdrawal already committed):",
      { status: auditOutcome.status, userId: parsed.userId },
    );
  }

  invalidateUserCaches(parsed.userId);
  return { success: true };
}

/**
 * Multi-role Site Role setter (game platform / packy.gg role, NOT the
 * admin-panel role). Accepts the full desired role set; every entry is
 * validated via {@link isSiteRole} and an empty set is rejected. The
 * singular `role` column is kept in sync as the highest-privilege member
 * ({@link pickPrimaryRole}) so every legacy single-role read path
 * (dashboards, filters, `ROLE_COLORS` badges, etc.) keeps working
 * unchanged.
 *
 * Resilient to the un-applied MAIN-DB `users.roles` migration: the owner
 * runs `ALTER TABLE users ADD COLUMN IF NOT EXISTS roles user_role[] ...`
 * against read-only-to-us prod on their own timeline. Until then,
 * {@link writeUserWithRoles} catches the missing-column error and retries
 * the SAME update with only `{ role: primary }`, so the role change still
 * takes effect (collapsed to the legacy single-role write) instead of
 * throwing. The returned `rolesColumnExists` flag tells the caller whether
 * the multi-role part of the write actually persisted, so the UI can show
 * an honest notice rather than silently pretending it did.
 */
export async function changeRole(
  userId: string,
  roles: string[],
  totpCode: string,
): Promise<{ rolesColumnExists: boolean }> {
  const db = await getPrimaryDrizzleDb();
  // Role changes remain admin-only (+ 2FA). The capability check is kept as
  // defence-in-depth so `__can_change_user_roles` is catalogued; admins pass
  // automatically.
  const session = await requireAdmin();
  await requireCapability(session, "__can_change_user_roles", "change user roles");

  await require2FA(session.userId, totpCode);

  if (roles.length === 0) {
    throw new Error("Pick at least one role");
  }
  if (!roles.every(isSiteRole)) {
    throw new Error("Invalid role");
  }
  const dedupedRoles = [...new Set(roles)] as SiteRole[];
  const primary = pickPrimaryRole(dedupedRoles);

  // Read the prior role BEFORE the update so the audit row records the full
  // before→after transition (not just the new role). This is what lets the
  // /creators changelog detect a creator-removal (prev_role === 'creator',
  // new_role !== 'creator') from a generic role change — otherwise firing a
  // creator via this dropdown is indistinguishable from any other role edit.
  const before = await db.execute<{ role: string }>(sql`
    SELECT role::text AS role FROM "user" WHERE id = ${userId}
  `);
  const prevRole = before.rows[0]?.role ?? null;

  const { rolesColumnExists } = await writeUserWithRoles(
    () =>
      db.execute(sql`
        UPDATE "user"
        SET role = ${primary}::user_role,
            roles = ${pgArrayParam(dedupedRoles)}::user_role[],
            updated_at = NOW()
        WHERE id = ${userId}
        RETURNING id
      `),
    () =>
      db.execute(sql`
        UPDATE "user"
        SET role = ${primary}::user_role, updated_at = NOW()
        WHERE id = ${userId}
        RETURNING id
      `),
  );

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "role_changed",
    targetUserId: userId,
    metadata: { prev_role: prevRole, new_role: primary, new_roles: dedupedRoles },
  });

  invalidateUserCaches(userId);

  return { rolesColumnExists };
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
  const db = await getPrimaryDrizzleDb();
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
  const updated = await db.execute(sql`
    UPDATE "user"
    SET role = 'user'::user_role, updated_at = NOW()
    WHERE id = ${userId}
    RETURNING id
  `);
  if (updated.rows.length === 0) {
    return { success: false, error: "User not found" };
  }

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

  invalidateUserCaches(userId);
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
  const db = await getPrimaryDrizzleDb();
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

  try {
    const email = typeof updateData.email === "string" ? updateData.email : null;
    const username =
      typeof updateData.username === "string" ? updateData.username : null;
    const conflicts = await db.execute<{
      email_conflict: boolean;
      username_conflict: boolean;
    }>(sql`
      SELECT
        EXISTS(
          SELECT 1 FROM "user"
          WHERE id <> ${userId} AND ${email}::text IS NOT NULL AND email = ${email}
        ) AS email_conflict,
        EXISTS(
          SELECT 1 FROM "user"
          WHERE id <> ${userId} AND ${username}::text IS NOT NULL
            AND username = ${username}
        ) AS username_conflict
    `);
    if (conflicts.rows[0]?.email_conflict) {
      return { success: false, error: "Email is already in use" };
    }
    if (conflicts.rows[0]?.username_conflict) {
      return { success: false, error: "Username is already taken" };
    }

    const updated = await db.execute(sql`
      UPDATE "user"
      SET email = CASE WHEN ${data.email !== undefined} THEN ${email} ELSE email END,
          email_verified = CASE
            WHEN ${data.email !== undefined} THEN TRUE ELSE email_verified
          END,
          username = CASE
            WHEN ${data.username !== undefined} THEN ${username} ELSE username
          END,
          display_username = CASE
            WHEN ${data.displayUsername !== undefined}
              THEN ${updateData.display_username as string | null}
            ELSE display_username
          END,
          updated_at = NOW()
      WHERE id = ${userId}
      RETURNING id
    `);
    if (updated.rows.length === 0) {
      return { success: false, error: "User not found" };
    }
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

  invalidateUserCaches(userId);
  revalidatePath("/users");
  // revalidatePath does NOT drop unstable_cache entries — flush the
  // /users list caches so the renamed identity shows there immediately.
  // (`invalidateUserCaches` already busts the per-user `users-detail-*`
  // tag for this user — these two are list-scoped.)
  revalidateTag("users-list");
  revalidateTag("users-list-stats");
  return { success: true };
}

export async function toggleFeatureLock(
  userId: string,
  feature: string,
  locked: boolean
) {
  const db = await getPrimaryDrizzleDb();
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

  // Set timestamps only — admin identity is tracked via audit events
  const byField = feature.startsWith("locked_withdrawals")
    ? "locked_withdrawals"
    : feature;
  const featureColumn = sql.identifier(feature);
  const atColumn = sql.identifier(`${byField}_at`);
  await db.execute(sql`
    INSERT INTO user_feature_locks (id, user_id, ${featureColumn}, ${atColumn})
    VALUES (${crypto.randomUUID()}, ${userId}, ${sql.param(value)}, ${locked ? new Date() : null})
    ON CONFLICT (user_id) DO UPDATE SET
      ${featureColumn} = EXCLUDED.${featureColumn},
      ${atColumn} = EXCLUDED.${atColumn}
  `);

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: locked ? `${feature}_enabled` : `${feature}_disabled`,
    targetUserId: userId,
    metadata: { feature, locked },
  });

  // NOTE: intentionally NO revalidatePath here. revalidatePath inside a
  // Server Action makes Next.js re-render the whole /users/[id] route as
  // part of the action response, which re-runs the ~30s getUserDetail
  // aggregate just to flip one boolean. The client toggles optimistically
  // and the 60s AutoRefresh tick reconciles the lock state from the DB.
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
  bonusPaid: number;
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
  const db = await getPrimaryDrizzleDb();
  const rows = (
    await db.execute<{
      id: string;
      amount: string;
      created_at: Date | string;
      bonus_paid: string;
    }>(sql`
      WITH deposits AS (
        SELECT id, amount, created_at, fireblocks_tx_id
        FROM ledger_transactions
        WHERE user_id = ${userId}
          AND type = 'deposit'
          AND status = 'completed'
        ORDER BY created_at DESC
        LIMIT 50
      ),
      bonuses AS (
        SELECT metadata->>'fireblocks_tx_id' AS fireblocks_tx_id,
               SUM(ABS(amount)) AS bonus_paid
        FROM ledger_transactions
        WHERE user_id = ${userId}
          AND type = 'deposit_bonus'
          AND status = 'completed'
          AND metadata->>'fireblocks_tx_id' IS NOT NULL
        GROUP BY metadata->>'fireblocks_tx_id'
      )
      SELECT d.id, d.amount::text, d.created_at,
             COALESCE(b.bonus_paid, 0)::text AS bonus_paid
      FROM deposits d
      LEFT JOIN bonuses b ON b.fireblocks_tx_id = d.fireblocks_tx_id
      ORDER BY d.created_at DESC
    `)
  ).rows;

  return rows.map((r) => ({
    id: r.id,
    amount: Math.abs(Number(r.amount)),
    createdAt: postgresTimestampIso(r.created_at, "deposit.created_at"),
    bonusPaid: Math.round(Number(r.bonus_paid) * 100) / 100,
  }));
}

export type JoinedBattleRow = {
  battleId: string;
  gameSessionId: string;
  creatorUserId: string;
  creatorUsername: string | null;
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
  const db = await getReadDrizzleDb();
  const rows = (
    await db.execute<
    {
      battle_id: string;
      game_session_id: string;
      creator_user_id: string;
      creator_username: string | null;
      team_number: number;
      winner_team: number | null;
      status: string;
      bet_amount: string;
      sponsorship_percentage: number;
      created_at: Date | string;
      winnings: string;
    }
  >(
    // Winnings per Voucher=Card invariant: kept cards (user_inventory) PLUS the
    // paired battle_excess_to_voucher voucher leg (vouchers.origin_id = the
    // battle's game_session_id). Same fix pattern as commit a87aae37 applied to
    // getUserTransactions — without the voucher leg, a sponsored battle that
    // paid out mostly as a voucher reads as a near-zero win.
    sql`SELECT bp.battle_id,
            bp.game_session_id,
            b.user_id AS creator_user_id,
            COALESCE(
              NULLIF(BTRIM(creator.display_username), ''),
              NULLIF(BTRIM(creator.username), ''),
              NULLIF(BTRIM(creator.name), '')
            ) AS creator_username,
            bp.team_number,
            b.winner_team,
            b.status::text AS status,
            b.bet_amount::text AS bet_amount,
            b.sponsorship_percentage,
            gs.created_at,
            (
              COALESCE((
                SELECT SUM(ui.value_at_obtained::numeric)
                FROM user_inventory ui
                WHERE ui.user_id = bp.user_id
                  AND ui.source_type::text = 'battle'
                  AND ui.source_id = bp.game_session_id
              ), 0)
              + COALESCE((
                SELECT SUM(v.value::numeric)
                FROM vouchers v
                WHERE v.user_id = bp.user_id
                  AND v.origin::text = 'battle_excess_to_voucher'
                  AND v.origin_id = bp.game_session_id
              ), 0)
            )::text AS winnings
       FROM battle_participants bp
       JOIN battles b ON b.id = bp.battle_id
       JOIN game_sessions gs ON gs.id = bp.game_session_id
       LEFT JOIN "user" creator ON creator.id = b.user_id
      WHERE bp.user_id = ${userId}
        AND bp.bot_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM ledger_transactions lt
           WHERE lt.type::text = 'battle_bet'
             AND lt.game_session_id = bp.game_session_id
             AND lt.user_id = bp.user_id
        )
      ORDER BY gs.created_at DESC
      LIMIT 100`,
    )
  ).rows;

  return rows.map((r) => {
    let result: JoinedBattleRow["result"] = "pending";
    if (r.status === "completed" && r.winner_team != null) {
      result = r.team_number === r.winner_team ? "win" : "lose";
    }
    return {
      battleId: r.battle_id,
      gameSessionId: r.game_session_id,
      creatorUserId: r.creator_user_id,
      creatorUsername: r.creator_username,
      at: postgresTimestampIso(r.created_at, "battle.created_at"),
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
  const db = await getPrimaryDrizzleDb();
  const rows = (
    await db.execute<{
      id: string;
      card_id: string;
      card_name: string | null;
      value_at_obtained: string;
      sold_at: Date | string;
    }>(sql`
      SELECT ui.id, ui.card_id, c.name AS card_name,
             ui.value_at_obtained::text, ui.sold_at
      FROM user_inventory ui
      LEFT JOIN cards c ON c.id = ui.card_id
      WHERE ui.user_id = ${userId} AND ui.sold_at IS NOT NULL
      ORDER BY ui.sold_at DESC
      LIMIT 500
    `)
  ).rows;
  if (rows.length === 0) return [];

  // Group by second-truncated sold_at — a multi-card "sell" sets sold_at on
  // all rows at the same instant. `rows` is desc, so the Map preserves
  // newest-first batch order.
  const batches = new Map<string, InventorySaleBatch>();
  for (const r of rows) {
    if (!r.sold_at) continue;
    const soldAt = postgresTimestampIso(r.sold_at, "inventory.sold_at");
    const key = soldAt.slice(0, 19);
    let b = batches.get(key);
    if (!b) {
      b = { id: r.id, at: soldAt, count: 0, total: 0, cards: [] };
      batches.set(key, b);
    }
    const value = Number(r.value_at_obtained);
    b.count += 1;
    b.total += value;
    if (b.cards.length < 30) {
      b.cards.push({ name: r.card_name ?? "Card", value });
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
  const db = await getPrimaryDrizzleDb();
  const session = await requirePageAccess("/users");

  const parsed = deleteVoucherSchema.safeParse(data);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  if (session.role !== "admin") {
    const perms = (await adminDrizzle.execute<{ allowed_pages: string[] }>(sql`
      SELECT allowed_pages FROM admin_users
      WHERE id = ${session.userId}::uuid LIMIT 1
    `)).rows[0];
    if (!perms || !canUserAdjustBalance(perms.allowed_pages ?? [])) {
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

  const voucher = (await db.execute<{
    id: string; value: string; origin: string; claimed_at: Date | string | null;
  }>(sql`
    SELECT id, value::text, origin::text, claimed_at FROM vouchers
    WHERE id = ${parsed.data.voucherId}::uuid
      AND user_id = ${parsed.data.userId}
    LIMIT 1
  `)).rows[0];
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
    await db.transaction(async (tx) => {
      const bal = (await tx.execute<{ available_balance: string }>(sql`
        SELECT available_balance::text FROM balances
        WHERE user_id = ${parsed.data.userId} FOR UPDATE
      `)).rows[0];
      const currentAvailable = bal?.available_balance ?? "0";

      const removedAt = new Date();
      const updated = await tx.execute(sql`
        UPDATE vouchers SET claimed_at = ${removedAt}, updated_at = NOW()
        WHERE id = ${parsed.data.voucherId}::uuid
          AND user_id = ${parsed.data.userId} AND claimed_at IS NULL
        RETURNING id
      `);
      if (updated.rows.length !== 1) {
        throw new Error("Voucher changed since you opened this dialog");
      }

      await tx.execute(sql`
        INSERT INTO ledger_transactions (
          id, user_id, type, amount, balance_before, balance_after,
          description, metadata, status
        ) VALUES (
          ${crypto.randomUUID()}::uuid, ${parsed.data.userId},
          'admin_balance_adjustment', -ABS(${voucher.value}::numeric),
          ${currentAvailable}::numeric, ${currentAvailable}::numeric,
          ${`Voucher removed: $${value.toFixed(2)} (${voucher.origin}) — ${parsed.data.reason}`},
          ${JSON.stringify({
            kind: "voucher_removal",
            voucher_id: parsed.data.voucherId,
            origin: voucher.origin,
            value,
          })}::jsonb,
          'completed'
        )
      `);
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

  // TAG-ONLY — the vouchers panel re-fetches its own list client-side, so a
  // current-route `revalidatePath('/users/[id]')` would only re-render +
  // re-suspend the page and lose scroll. Busting the per-user cache tag keeps
  // the cached getUserDetail holdings fresh for the next render / AutoRefresh.
  revalidateTag(`users-detail-${parsed.data.userId}`);
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
  const db = await getPrimaryDrizzleDb();
  const rows = (
    await db.execute<{
      id: string;
      value: string;
      origin: string;
      description: string | null;
      created_at: Date | string;
    }>(sql`
      SELECT id, value::text, origin::text, description, created_at
      FROM vouchers
      WHERE user_id = ${userId} AND claimed_at IS NULL
      ORDER BY created_at DESC
      LIMIT 200
    `)
  ).rows;
  return rows.map((v) => ({
    id: v.id,
    value: Number(v.value),
    origin: String(v.origin),
    description: v.description,
    createdAt: postgresTimestampIso(v.created_at, "voucher.created_at"),
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
  const db = await getPrimaryDrizzleDb();
  const session = await requirePageAccess("/users");

  const parsed = deleteInventoryItemSchema.safeParse(data);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  if (session.role !== "admin") {
    const perms = (
      await adminDrizzle.execute<{ allowed_pages: string[] | null }>(sql`
        SELECT allowed_pages FROM admin_users WHERE id = ${session.userId}::uuid
      `)
    ).rows[0];
    if (!perms || !canUserAdjustBalance(perms.allowed_pages ?? [])) {
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

  invalidateUserCaches(parsed.data.userId);
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
  db: MainDrizzleDb,
  adminUserId: string,
  userId: string,
  inventoryItemId: string,
  reason: string,
): Promise<RemoveInventoryItemResult> {
  type ItemRow = {
    id: string;
    card_id: string;
    value_at_obtained: string;
      sold_at: Date | string | null;
      exchanged_at: Date | string | null;
      withdrawal_locked_at: Date | string | null;
    card_name: string | null;
    has_open_withdrawal: boolean;
  };

  try {
    const outcome = await db.transaction(async (tx) => {
      const item = (
        await tx.execute<ItemRow>(sql`
          SELECT ui.id, ui.card_id,
                 ui.value_at_obtained::text AS value_at_obtained,
                 ui.sold_at, ui.exchanged_at, ui.withdrawal_locked_at,
                 c.name AS card_name,
                 EXISTS (
                   SELECT 1
                   FROM card_withdrawal_requests cwr
                   WHERE cwr.user_id = ${userId}
                     AND cwr.status::text = ANY(${pgArrayParam([...OPEN_WITHDRAWAL_STATUSES])}::text[])
                     AND cwr.inventory_item_ids @> ARRAY[${inventoryItemId}::uuid]
                 ) AS has_open_withdrawal
          FROM user_inventory ui
          LEFT JOIN cards c ON c.id = ui.card_id
          WHERE ui.id = ${inventoryItemId}::uuid
            AND ui.user_id = ${userId}
          FOR UPDATE OF ui
        `)
      ).rows[0];

      if (!item) {
        return { ok: false as const, error: "Inventory item not found for this user" };
      }
      if (item.sold_at || item.exchanged_at) {
        return {
          ok: false as const,
          error: "Only open items can be removed — this one was already sold or exchanged",
        };
      }
      if (item.withdrawal_locked_at) {
        return {
          ok: false as const,
          error: "This item is withdrawal-locked — unlock or cancel the withdrawal first",
        };
      }
      if (item.has_open_withdrawal) {
        return {
          ok: false as const,
          error: "This item is tied to an open card withdrawal — cancel or complete it first",
        };
      }

      const balance = (
        await tx.execute<{ available_balance: string }>(sql`
          SELECT available_balance::text AS available_balance
          FROM balances
          WHERE user_id = ${userId}
          FOR UPDATE
        `)
      ).rows[0];
      const currentAvailable = balance?.available_balance ?? "0";
      const value = Number(item.value_at_obtained);
      const cardName = item.card_name ?? "Unknown item";
      const removedAt = new Date();

      await tx.execute(sql`
        DELETE FROM provably_fair_results
        WHERE inventory_item_id = ${inventoryItemId}::uuid
      `);
      const updated = await tx.execute<{ id: string }>(sql`
        UPDATE user_inventory
        SET sold_at = ${removedAt}, updated_at = NOW()
        WHERE id = ${inventoryItemId}::uuid
          AND user_id = ${userId}
          AND sold_at IS NULL
          AND exchanged_at IS NULL
        RETURNING id
      `);
      if (updated.rows.length !== 1) {
        return {
          ok: false as const,
          error: "Could not remove item — it may have changed since you opened this dialog",
        };
      }

      const metadata = {
        kind: "inventory_removal",
        inventory_item_id: inventoryItemId,
        card_id: item.card_id,
        card_name: cardName,
        value_at_obtained: value,
      };
      await tx.execute(sql`
        INSERT INTO ledger_transactions (
          id, user_id, type, amount, balance_before, balance_after,
          description, metadata, status, created_at, updated_at
        ) VALUES (
          ${crypto.randomUUID()}::uuid,
          ${userId},
          'admin_balance_adjustment',
          -ABS(${item.value_at_obtained}::numeric),
          ${currentAvailable}::numeric,
          ${currentAvailable}::numeric,
          ${`Inventory removed: ${cardName} ($${value.toFixed(2)}) — ${reason}`},
          ${JSON.stringify(metadata)}::jsonb,
          'completed',
          NOW(),
          NOW()
        )
      `);

      return {
        ok: true as const,
        itemId: item.id,
        cardId: item.card_id,
        cardName,
        value,
      };
    });

    if (!outcome.ok) return outcome;

    await createAdminAuditEvent({
      adminUserId,
      eventType: "inventory_item_deleted",
      targetUserId: userId,
      metadata: {
        inventoryItemId: outcome.itemId,
        cardId: outcome.cardId,
        cardName: outcome.cardName,
        valueAtObtained: outcome.value,
        reason,
      },
    });
    return { ok: true };
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
  const db = await getPrimaryDrizzleDb();
  const session = await requirePageAccess("/users");

  const parsed = bulkDeleteInventorySchema.safeParse(data);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  if (session.role !== "admin") {
    const perms = (
      await adminDrizzle.execute<{ allowed_pages: string[] | null }>(sql`
        SELECT allowed_pages FROM admin_users WHERE id = ${session.userId}::uuid
      `)
    ).rows[0];
    if (!perms || !canUserAdjustBalance(perms.allowed_pages ?? [])) {
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

  invalidateUserCaches(parsed.data.userId);

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
  const db = await getPrimaryDrizzleDb();
  await requirePageAccess("/users");

  const session = (
    await db.execute<{
      id: string;
      user_id: string;
      game_type: string;
      game_id: string | null;
      result: string | null;
      bet_amount: string;
      created_at: Date | string;
    }>(sql`
      SELECT id, user_id, game_type::text AS game_type, game_id,
             result, bet_amount::text AS bet_amount, created_at
      FROM game_sessions
      WHERE id = ${gameSessionId}::uuid
      LIMIT 1
    `)
  ).rows[0];

  // Ownership check — without this, anyone with access to /users could
  // join across users by passing any session id (which leaks the
  // session's server seed via provably_fair_results). We compare against
  // the URL's userId rather than session.user_id so a wrong-page click
  // returns "not found" rather than silently rendering another user's
  // session. Returning null (same as a missing row) avoids leaking the
  // existence of the session to admins viewing the wrong user.
  if (!session || session.user_id !== userId) return null;

  const provablyFairResults = (
    await db.execute<{
      id: string;
      client_seed: string;
      server_seed_hash: string;
      server_seed: string | null;
      nonce: number;
      cursor: number;
      ticket: number;
      result_hash: string;
      result_metadata: unknown;
      inventory_item_id: string | null;
      inventory_id: string | null;
      inventory_card_id: string | null;
      inventory_value_at_obtained: string | null;
    }>(sql`
      SELECT pfr.id, pfr.client_seed, pfr.server_seed_hash,
             pfr.server_seed, pfr.nonce, pfr.cursor, pfr.ticket,
             pfr.result_hash, pfr.result_metadata, pfr.inventory_item_id,
             ui.id AS inventory_id, ui.card_id AS inventory_card_id,
             ui.value_at_obtained::text AS inventory_value_at_obtained
      FROM provably_fair_results pfr
      LEFT JOIN user_inventory ui ON ui.id = pfr.inventory_item_id
      WHERE pfr.game_session_id = ${gameSessionId}::uuid
      ORDER BY pfr.nonce ASC, pfr.cursor ASC
    `)
  ).rows.map((row) => ({
    id: row.id,
    client_seed: row.client_seed,
    server_seed_hash: row.server_seed_hash,
    server_seed: row.server_seed,
    nonce: row.nonce,
    cursor: row.cursor,
    ticket: row.ticket,
    result_hash: row.result_hash,
    result_metadata: row.result_metadata,
    inventory_item_id: row.inventory_item_id,
    user_inventory:
      row.inventory_id && row.inventory_card_id
        ? {
            id: row.inventory_id,
            card_id: row.inventory_card_id,
            value_at_obtained: row.inventory_value_at_obtained ?? "0",
          }
        : null,
  }));

  // Fetch pack details if it's a pack opening
  let pack: { id: string; name: string; imageUrl: string | null } | null = null;
  if (session.game_type === "pack" && session.game_id) {
    const directPack = (
      await db.execute<{ id: string; name: string; image_url: string | null }>(
        sql`SELECT id, name, image_url FROM packs WHERE id = ${session.game_id} LIMIT 1`,
      )
    ).rows[0];
    if (directPack) {
      pack = { id: directPack.id, name: directPack.name, imageUrl: directPack.image_url };
    } else {
      const userPack = (
        await db.execute<{ id: string; name: string; image_url: string | null }>(
          sql`
            SELECT p.id, p.name, p.image_url
            FROM user_packs up
            JOIN packs p ON p.id = up.pack_id
            WHERE up.id = ${session.game_id}::uuid
            LIMIT 1
          `,
        )
      ).rows[0];
      if (userPack) {
        pack = {
          id: userPack.id,
          name: userPack.name,
          imageUrl: userPack.image_url,
        };
      }
    }
  }

  const inventoryItems = provablyFairResults
    .filter((r) => r.user_inventory)
    .map((r) => r.user_inventory!);

  const cardIds = [...new Set(inventoryItems.map((i) => i.card_id))];
  const cards = cardIds.length > 0
    ? (
        await db.execute<{
          id: string;
          name: string;
          image_url: string | null;
          rarity: string | null;
          price: string;
        }>(sql`
          SELECT id, name, image_url, rarity::text AS rarity, price::text AS price
          FROM cards
          WHERE id = ANY(${pgArrayParam(cardIds)}::uuid[])
        `)
      ).rows
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

  const pfResults = provablyFairResults.map((r) => ({
    id: r.id,
    clientSeed: r.client_seed,
    serverSeedHash: r.server_seed_hash,
    serverSeed: r.server_seed,
    nonce: r.nonce,
    cursor: r.cursor,
    ticket: r.ticket,
    resultHash: r.result_hash,
  }));

  // ── "Packs opened" — per-roll pack → picked-card mapping ──────────────
  //
  // Every provably_fair_results row stores, in its result_metadata JSON, the
  // exact pack it opened (`pack_id` / `pack_name`) and — for BATTLE sessions —
  // the card pulled from it (`card_id`, plus a `round_id` for ordering). A
  // battle opens one pack per round; each round contributes one PF roll the
  // user kept (inventory_item_id set) plus, in borrow/redistribution modes, a
  // second roll for the leg sent elsewhere. We collapse to ONE entry per round
  // and surface the card the USER actually pulled, preferring the kept-leg row.
  //
  // For a plain pack_opening the metadata carries pack_id/pack_name but NO
  // card_id (the card lives only on the inventory row), so we fall back to the
  // PF row's own inventory_item_id → card. This makes the section render
  // consistently for both pack_opening and battle_bet, with no fabrication:
  // both fields are read straight off the same provably_fair row.
  type PfRow = (typeof provablyFairResults)[number];
  const metaOf = (r: PfRow): Record<string, unknown> =>
    r.result_metadata && typeof r.result_metadata === "object"
      ? (r.result_metadata as Record<string, unknown>)
      : {};
  const asStr = (v: unknown): string | null =>
    typeof v === "string" && v.length > 0 ? v : null;
  // round_id is stored as a JSON number (e.g. 13), so a string-only coerce
  // would drop it. asInt accepts both number and numeric-string forms.
  const asInt = (v: unknown): number | null => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "") {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  };

  // Group PF rows by round (battle) or by PF row id (pack_opening, which has no
  // round_id). Within a round, prefer the leg the user kept so the displayed
  // card matches what landed in their inventory.
  const roundGroups = new Map<string, PfRow[]>();
  for (const r of provablyFairResults) {
    const meta = metaOf(r);
    // Only rows that actually reference a pack belong in this section.
    if (!asStr(meta.pack_id)) continue;
    const roundId = asInt(meta.round_id);
    const roundKey = roundId != null ? `round:${roundId}` : `pf:${r.id}`;
    const arr = roundGroups.get(roundKey);
    if (arr) arr.push(r);
    else roundGroups.set(roundKey, [r]);
  }

  // Resolve all referenced pack + card ids in two batched lookups (PK reads).
  const packIdSet = new Set<string>();
  const metaCardIdSet = new Set<string>();
  for (const rows of roundGroups.values()) {
    for (const r of rows) {
      const meta = metaOf(r);
      const pid = asStr(meta.pack_id);
      if (pid) packIdSet.add(pid);
      const cid = asStr(meta.card_id);
      if (cid) metaCardIdSet.add(cid);
    }
  }
  // The inventory-linked cards were already resolved into `cardMap` above; only
  // the metadata-only card ids (battle pulls not in `cardMap`) need fetching.
  const missingCardIds = [...metaCardIdSet].filter((id) => !cardMap.has(id));
  const [packsOpenedRows, extraCards] = await Promise.all([
    packIdSet.size > 0
      ? db
          .execute<{ id: string; name: string; image_url: string | null }>(sql`
            SELECT id, name, image_url
            FROM packs
            WHERE id = ANY(${pgArrayParam([...packIdSet])}::uuid[])
          `)
          .then((result) => result.rows)
      : Promise.resolve([] as { id: string; name: string; image_url: string | null }[]),
    missingCardIds.length > 0
      ? db
          .execute<{
            id: string;
            name: string;
            image_url: string | null;
            rarity: string | null;
            price: string;
          }>(sql`
            SELECT id, name, image_url, rarity::text AS rarity, price::text AS price
            FROM cards
            WHERE id = ANY(${pgArrayParam(missingCardIds)}::uuid[])
          `)
          .then((result) => result.rows)
      : Promise.resolve([]),
  ]);
  const packMap = new Map(packsOpenedRows.map((p) => [p.id, p]));
  const fullCardMap = new Map(cardMap);
  for (const cd of extraCards) fullCardMap.set(cd.id, cd);

  const packsOpened = [...roundGroups.entries()]
    .map(([roundKey, rows]) => {
      // Prefer the leg the user kept (inventory_item_id set), else first row.
      const primary = rows.find((r) => r.inventory_item_id) ?? rows[0]!;
      const meta = metaOf(primary);
      const packId = asStr(meta.pack_id)!;
      const packRow = packMap.get(packId);
      const packName = packRow?.name ?? asStr(meta.pack_name) ?? "Unknown pack";

      // Picked card: the inventory card (pack_opening + kept battle leg) wins;
      // otherwise the metadata card_id (battle leg the user pulled but didn't
      // keep). Either way it's the card pulled from THIS pack on THIS roll.
      const invItem = primary.inventory_item_id
        ? inventoryItems.find((i) => i.id === primary.inventory_item_id)
        : null;
      const cardId = invItem?.card_id ?? asStr(meta.card_id);
      const card = cardId ? fullCardMap.get(cardId) : undefined;
      // Value: the inventory's value_at_obtained when the user kept the card
      // (cent-exact at pull time), else the card's catalogue price.
      const keptValue = invItem
        ? Number(invItem.value_at_obtained)
        : null;

      const roundIndex = asInt(meta.round_id);

      return {
        key: roundKey,
        roundIndex,
        nonce: primary.nonce,
        kept: Boolean(primary.inventory_item_id),
        pack: {
          id: packId,
          name: packName,
          imageUrl: packRow?.image_url ?? null,
        },
        card: card
          ? {
              name: card.name,
              imageUrl: card.image_url,
              rarity: card.rarity,
              valueUsd: keptValue ?? Number(card.price),
            }
          : null,
      };
    })
    // Stable order: battle rounds by round index, pack_opening by nonce.
    .sort((a, b) => {
      if (a.roundIndex != null && b.roundIndex != null)
        return a.roundIndex - b.roundIndex;
      return a.nonce - b.nonce;
    });

  return {
    id: session.id,
    gameType: session.game_type,
    result: session.result,
    betAmount: Number(session.bet_amount),
    pack,
    items,
    pfResults,
    packsOpened,
    createdAt: postgresTimestampIso(session.created_at, "session.created_at"),
  };
}

function normalizeKenoNumbers(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter(
        (number): number is number =>
          typeof number === "number" &&
          Number.isInteger(number) &&
          number >= 0 &&
          number < 40,
      ),
    ),
  ];
}

/**
 * Lazy Keno replay lookup for the transaction-detail modal.
 *
 * The requested ledger row is ownership-checked before any game data can be
 * returned. The lateral Keno lookup is bounded to that user and a two-day
 * window around the ledger event, allowing PostgreSQL to use
 * idx_keno_games_user_id_created_at rather than sweeping keno_games.
 */
export async function getKenoGameDetails(
  ledgerTxId: string,
  userId: string,
): Promise<KenoGameDetails | null> {
  await requirePageAccess("/users");

  const parsedTxId = z.string().uuid().safeParse(ledgerTxId);
  if (!parsedTxId.success || !userId) return null;

  const db = await getReadDrizzleDb();
  const row = (
    await db.execute<{
      id: string;
      risk: string;
      selected_numbers: unknown;
      drawn_numbers: unknown;
      hits: number;
      result_multiplier: string;
      bet_amount: string;
      won_amount: string;
      bet_ledger_tx_id: string | null;
      payout_ledger_tx_id: string | null;
      created_at: Date | string;
    }>(sql`
      WITH requested_tx AS MATERIALIZED (
        SELECT id, user_id, created_at
        FROM ledger_transactions
        WHERE id = ${parsedTxId.data}::uuid
          AND user_id = ${userId}
          AND type::text IN ('keno_bet', 'keno_payout')
        LIMIT 1
      )
      SELECT
        game.id,
        game.risk::text AS risk,
        game.selected_numbers,
        game.drawn_numbers,
        game.hits,
        game.result_multiplier::text AS result_multiplier,
        game.bet_amount::text AS bet_amount,
        game.won_amount::text AS won_amount,
        game.bet_ledger_tx_id,
        game.payout_ledger_tx_id,
        game.created_at
      FROM requested_tx tx
      JOIN LATERAL (
        SELECT kg.*
        FROM keno_games kg
        WHERE kg.user_id = tx.user_id
          AND kg.created_at >= tx.created_at - INTERVAL '1 day'
          AND kg.created_at <= tx.created_at + INTERVAL '1 day'
          AND (
            kg.bet_ledger_tx_id = tx.id
            OR kg.payout_ledger_tx_id = tx.id
          )
        ORDER BY kg.created_at DESC
        LIMIT 1
      ) game ON TRUE
      LIMIT 1
    `)
  ).rows[0];

  if (
    !row ||
    (row.risk !== "low" && row.risk !== "medium" && row.risk !== "high")
  ) {
    return null;
  }

  return {
    id: row.id,
    risk: row.risk,
    selectedNumbers: normalizeKenoNumbers(row.selected_numbers),
    drawnNumbers: normalizeKenoNumbers(row.drawn_numbers),
    hits: row.hits,
    resultMultiplier: Number(row.result_multiplier),
    betAmount: Number(row.bet_amount),
    wonAmount: Number(row.won_amount),
    betLedgerTxId: row.bet_ledger_tx_id,
    payoutLedgerTxId: row.payout_ledger_tx_id,
    createdAt: postgresTimestampIso(row.created_at, "keno_game.created_at"),
  };
}

// ---------------------------------------------------------------------------
// Inventory item origin — lazy-loaded "where did this come from" detail
// ---------------------------------------------------------------------------
//
// Powers the click-to-view origin sheet on the Inventory tab's "Current
// Inventory" grid (user-tabs-inventory.tsx / inventory-item-origin-sheet.tsx).
// Deliberately called ONLY when an admin clicks a single card — never
// fetched for the whole grid (Active-Timeframe-Only / no eager loading).
//
// `user_inventory.source_id` is the originating `game_sessions.id` for
// pack / reward / battle / upgrader rows — verified read-only against prod
// (2026-07-11): source_id resolves to a real game_sessions row for 100% of
// `pack`/`battle` rows and 81458/81459 (~99.9%) of `reward` rows. `exchange`
// rows NEVER carry a source_id (1742/1742 null in prod) — a card exchange is
// a value-neutral item swap with no linked session, consistent with
// CLAUDE.md's Voucher=Card model (exchanging isn't a house event either).
// `raffle` rows DO carry a source_id (26/26), but it does NOT reference
// `game_sessions` (0/26 resolved) — no verified join exists for raffle
// origins in this codebase, so a raffle item degrades to the same "no
// linked opening session" fallback as exchange rather than fabricating one.
export type InventoryItemOrigin = {
  itemId: string;
  cardName: string;
  imageUrl: string | null;
  rarity: string | null;
  value: number;
  sourceType: string;
  obtainedAt: string;
  /** Probability of pulling this exact card at the time it was obtained
   *  (`user_inventory.pull_chance`), when recorded on the row. */
  pullChance: number | null;
  /**
   * Resolved game-session detail (pack/battle breakdown, bet amount, cards
   * pulled) — reuses the EXACT same lookup + ownership guard the
   * transaction-detail modal already uses for gaming rows. Null when the
   * source type has no linked session (exchange/raffle, per the audit
   * above) or the session row could not be resolved.
   */
  session: Awaited<ReturnType<typeof getGameSessionDetails>>;
};

export async function getInventoryItemOrigin(
  userId: string,
  itemId: string,
): Promise<InventoryItemOrigin | null> {
  const db = await getPrimaryDrizzleDb();
  await requirePageAccess("/users");

  const item = (
    await db.execute<{
      id: string;
      user_id: string;
      value_at_obtained: string;
      source_type: string;
      source_id: string | null;
      obtained_at: Date | string;
      pull_chance: string | null;
      card_name: string | null;
      image_url: string | null;
      rarity: string | null;
    }>(sql`
      SELECT ui.id, ui.user_id, ui.value_at_obtained::text,
             ui.source_type::text, ui.source_id, ui.obtained_at,
             ui.pull_chance::text, c.name AS card_name, c.image_url, c.rarity
      FROM user_inventory ui
      LEFT JOIN cards c ON c.id = ui.card_id
      WHERE ui.id = ${itemId}
      LIMIT 1
    `)
  ).rows[0];
  // Ownership check — same convention as getGameSessionDetails: compare
  // against the URL's userId so a wrong-page click returns "not found"
  // rather than leaking another user's item across a guessed id.
  if (!item || item.user_id !== userId) return null;

  const session = item.source_id
    ? await getGameSessionDetails(item.source_id, userId)
    : null;

  return {
    itemId: item.id,
    cardName: item.card_name ?? "Unknown",
    imageUrl: item.image_url,
    rarity: item.rarity,
    value: Number(item.value_at_obtained),
    sourceType: item.source_type,
    obtainedAt: postgresTimestampIso(item.obtained_at, "inventory.obtained_at"),
    pullChance: item.pull_chance !== null ? Number(item.pull_chance) : null,
    session,
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
  const db = await getPrimaryDrizzleDb();
  const session = await requireAdmin();
  await requireCapability(session, "__can_update_user_withdrawal_limits", "update user withdrawal limits");
  const parsed = withdrawalLimitsSchema.parse(data);

  await db.execute(sql`
    INSERT INTO creator_withdrawal_limits (
      id, user_id, currency_limit_amount, currency_limit_start_date,
      currency_limit_reset_days, percentage_limit
    ) VALUES (
      ${crypto.randomUUID()}, ${parsed.userId}, ${parsed.currencyLimitAmount},
      ${parsed.currencyLimitStartDate ? new Date(parsed.currencyLimitStartDate) : null},
      ${parsed.currencyLimitResetDays}, ${parsed.percentageLimit}
    )
    ON CONFLICT (user_id) DO UPDATE SET
      currency_limit_amount = EXCLUDED.currency_limit_amount,
      currency_limit_start_date = EXCLUDED.currency_limit_start_date,
      currency_limit_reset_days = EXCLUDED.currency_limit_reset_days,
      percentage_limit = EXCLUDED.percentage_limit,
      updated_at = NOW()
  `);

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

  invalidateUserCaches(parsed.userId);
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

export async function assignAffiliateCode(
  userId: string,
  affiliateCode: string | null,
) {
  const db = await getPrimaryDrizzleDb();
  const session = await requirePageAccess("/users");
  await requireCapability(session, "__can_assign_affiliate", "assign affiliate codes");

  if (!affiliateCode || affiliateCode.trim() === "") {
    const currentUser = await db.transaction(async (tx) => {
      const current = (
        await tx.execute<{ referred_by: string | null; affiliate_code: string | null }>(sql`
          SELECT referred_by, affiliate_code
          FROM "user"
          WHERE id = ${userId}
          FOR UPDATE
        `)
      ).rows[0];

      await tx.execute(sql`
        UPDATE "user"
        SET referred_by = NULL,
            affiliate_code = NULL,
            affiliate_code_active = false,
            affiliate_code_expires_at = NULL,
            updated_at = NOW()
        WHERE id = ${userId}
      `);
      await tx.execute(sql`
        DELETE FROM affiliate_code_queue WHERE user_id = ${userId}
      `);
      if (current?.referred_by) {
        await tx.execute(sql`
          UPDATE affiliate_accounts
          SET total_referred = GREATEST(total_referred - 1, 0),
              updated_at = NOW()
          WHERE user_id = ${current.referred_by}
        `);
      }
      return current;
    });

    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "affiliate_code_cleared",
      targetUserId: userId,
      metadata: {
        previousReferrerId: currentUser?.referred_by ?? null,
        clearedCode: currentUser?.affiliate_code ?? null,
      },
    });

    invalidateUserCaches(userId);
    revalidateTag(`user-attribution-${userId}`);
    if (currentUser?.referred_by) invalidateUserCaches(currentUser.referred_by);
    return { success: true };
  }

  const normalizedCode = affiliateCode.trim();
  const codeRecord = (
    await db.execute<{ code: string; user_id: string }>(sql`
      SELECT code, user_id
      FROM affiliate_codes
      WHERE code = ${normalizedCode}
      LIMIT 1
    `)
  ).rows[0];

  if (!codeRecord) throw new Error("Affiliate code not found");
  if (codeRecord.user_id === userId) {
    throw new Error("Cannot assign a user to their own affiliate code");
  }

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE "user"
      SET referred_by = ${codeRecord.user_id},
          affiliate_code = ${codeRecord.code},
          affiliate_code_active = true,
          affiliate_code_expires_at = NULL,
          updated_at = NOW()
      WHERE id = ${userId}
    `);
    const ownerUpdated = await tx.execute(sql`
      UPDATE affiliate_accounts
      SET total_referred = total_referred + 1,
          updated_at = NOW()
      WHERE user_id = ${codeRecord.user_id}
    `);
    if (ownerUpdated.rowCount !== 1) {
      throw new Error("Affiliate owner account not found");
    }
    await tx.execute(sql`
      INSERT INTO affiliate_code_usages (
        id, affiliate_user_id, code, referred_user_id, usage_type,
        created_at, updated_at
      ) VALUES (
        ${crypto.randomUUID()}::uuid,
        ${codeRecord.user_id},
        ${codeRecord.code},
        ${userId},
        'deposit',
        NOW(),
        NOW()
      )
    `);
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "affiliate_code_assigned",
    targetUserId: userId,
    metadata: {
      affiliateCode: normalizedCode,
      affiliateOwnerId: codeRecord.user_id,
    },
  });

  invalidateUserCaches(userId);
  invalidateUserCaches(codeRecord.user_id);
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
  const db = await getPrimaryDrizzleDb();
  const session = await requirePageAccess("/users");
  await requireCapability(session, "__can_assign_affiliate", "create affiliate codes");
  const trimmed = code.trim();
  if (!trimmed) return { success: false, error: "Code cannot be empty" };

  const existingCode = (
    await db.execute<{
      user_id: string;
      username: string | null;
      email: string | null;
    }>(sql`
      SELECT ac.user_id, u.username, u.email
      FROM affiliate_codes ac
      LEFT JOIN "user" u ON u.id = ac.user_id
      WHERE ac.code = ${trimmed}
      LIMIT 1
    `)
  ).rows[0];
  if (existingCode) {
    if (existingCode.user_id === userId) return { success: true };
    return {
      success: false,
      conflict: {
        currentOwnerId: existingCode.user_id,
        currentOwnerUsername: existingCode.username,
        currentOwnerEmail: existingCode.email,
        code: trimmed,
      },
    };
  }

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      INSERT INTO affiliate_accounts (user_id, created_at, updated_at)
      VALUES (${userId}, NOW(), NOW())
      ON CONFLICT (user_id) DO NOTHING
    `);
    await tx.execute(sql`
      INSERT INTO affiliate_codes (id, user_id, code, created_at, updated_at)
      VALUES (${crypto.randomUUID()}::uuid, ${userId}, ${trimmed}, NOW(), NOW())
    `);
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "affiliate_code_created",
    targetUserId: userId,
    metadata: { code: trimmed },
  });

  invalidateUserCaches(userId);
  revalidatePath(`/creators/${userId}`);
  return { success: true };
}
// `generateRandomAffiliateCode` now lives in the shared helper
// `@/lib/affiliate/generate-code` so the Insights Affiliate Codes transfer
// reuses the identical generation/uniqueness mechanism (no parallel
// random-code logic). Imported at the top of this file.

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
  const db = await getPrimaryDrizzleDb();
  const session = await requirePageAccess("/users");
  await requireCapability(session, "__can_assign_affiliate", "transfer affiliate codes");

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
  const targetIdentifier = args.toUserId.trim();
  if (!targetIdentifier) {
    return { success: false, error: "Target user is required" };
  }

  const [codeRows, targetRows] = await Promise.all([
    db.execute<{ id: string; user_id: string }>(sql`
      SELECT id, user_id
      FROM affiliate_codes
      WHERE code = ${code}
      LIMIT 1
    `),
    db.execute<{ id: string }>(sql`
      SELECT id
      FROM "user"
      WHERE id = ${targetIdentifier}
         OR LOWER(username) = LOWER(${targetIdentifier})
      ORDER BY CASE WHEN id = ${targetIdentifier} THEN 0 ELSE 1 END
      LIMIT 1
    `),
  ]);
  const codeRow = codeRows.rows[0];
  if (!codeRow) {
    return {
      success: false,
      error: "That code doesn't exist anymore — refresh and try again",
    };
  }
  const target = targetRows.rows[0];
  if (!target) return { success: false, error: "Target user not found" };
  const toUserId = target.id;
  if (codeRow.user_id === toUserId) {
    return { success: false, error: "Target user already owns that code" };
  }

  const previousOwnerId = codeRow.user_id;
  const replacementCode = await generateRandomAffiliateCode(db);

  await db.transaction(async (tx) => {
    const moved = await tx.execute(sql`
      UPDATE affiliate_codes
      SET user_id = ${toUserId}, updated_at = NOW()
      WHERE id = ${codeRow.id}::uuid
        AND user_id = ${previousOwnerId}
    `);
    if (moved.rowCount !== 1) {
      throw new Error("Affiliate code ownership changed; refresh and try again");
    }
    await tx.execute(sql`
      INSERT INTO affiliate_codes (id, user_id, code, created_at, updated_at)
      VALUES (
        ${crypto.randomUUID()}::uuid,
        ${previousOwnerId},
        ${replacementCode},
        NOW(),
        NOW()
      )
    `);
    await tx.execute(sql`
      INSERT INTO affiliate_accounts (user_id, created_at, updated_at)
      VALUES (${toUserId}, NOW(), NOW())
      ON CONFLICT (user_id) DO NOTHING
    `);
    await tx.execute(sql`
      INSERT INTO affiliate_accounts (user_id, created_at, updated_at)
      VALUES (${previousOwnerId}, NOW(), NOW())
      ON CONFLICT (user_id) DO NOTHING
    `);
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "affiliate_code_transferred",
    targetUserId: toUserId,
    metadata: {
      code,
      previousOwnerId,
      replacementCode,
      two_factor_verified: true,
    },
  });

  invalidateUserCaches(toUserId);
  invalidateUserCaches(previousOwnerId);
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
  const db = await getPrimaryDrizzleDb();
  const session = await requirePageAccess("/users");
  await requireCapability(session, "__can_adjust_xp", "adjust user XP");
  const parsed = adjustXpSchema.parse(data);

  // 2FA gate — must run BEFORE the user_statistics write so a missing /
  // invalid TOTP code can't slip an XP mutation through. `require2FA`
  // throws on missing / invalid codes; the client surfaces the message
  // via the existing try/catch + toast pattern.
  await require2FA(session.userId, parsed.totpCode);

  const result = await db.execute<{
    previous_xp: number;
    new_xp: number;
  }>(sql`
    WITH previous AS (
      SELECT user_id, xp
      FROM user_statistics
      WHERE user_id = ${parsed.userId}
      FOR UPDATE
    )
    UPDATE user_statistics us
    SET xp = GREATEST(0, previous.xp + ${parsed.amount}),
        updated_at = NOW()
    FROM previous
    WHERE us.user_id = previous.user_id
    RETURNING previous.xp AS previous_xp, us.xp AS new_xp
  `);
  const changed = result.rows[0];
  if (!changed) throw new Error("User statistics not found");
  const currentXp = Number(changed.previous_xp);
  const newXp = Number(changed.new_xp);

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "xp_adjustment",
    targetUserId: parsed.userId,
    metadata: { amount: parsed.amount, previousXp: currentXp, newXp, reason: parsed.reason },
  });

  invalidateUserCaches(parsed.userId);
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

/**
 * Force the next /users/[id] render to query LIVE (cache-busting refresh).
 *
 * The Balances panel's refresh icon calls router.refresh(), which re-runs the
 * page's server components — but the per-user reads are unstable_cache'd
 * (getUserDetailCached / getUserPnlBreakdownCached / the gaming + financial
 * feeds + the XP-purchase + reward-pack-open caches, ALL tagged both
 * "users-detail" AND `users-detail-${userId}`). Within their TTL a plain
 * router.refresh() just replays the same cached snapshot. We invalidate
 * BOTH:
 *   • `users-detail-${userId}` — drops THIS user's cache entries only, so a
 *     refresh on user A doesn't nuke unrelated users' warmed entries.
 *   • the route segment via `revalidatePath(.../page)` — drops the Next.js
 *     route-segment + RSC response cache for this specific page so the
 *     follow-up router.refresh() actually re-renders from scratch instead
 *     of replaying the cached RSC payload.
 *
 * Subsequent router.refresh() then re-queries Postgres live — the manual
 * refresh is always fresh.
 *
 * `userId` is optional for backwards compatibility (an undefined value falls
 * back to busting the GLOBAL `users-detail` tag, matching the legacy bulk-
 * flush behaviour). Always pass it when known.
 */
export async function refreshUserDetailCache(userId?: string): Promise<void> {
  await requirePageAccess("/users");
  if (userId) {
    revalidateTag(`users-detail-${userId}`);
    // The route-segment cache is independent of unstable_cache — busting it
    // here ensures the follow-up router.refresh() re-renders the page
    // server-side instead of replaying the cached RSC response.
    revalidatePath(`/users/${userId}`, "page");
  } else {
    revalidateTag("users-detail");
  }
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
  const db = await getPrimaryDrizzleDb();
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
    await db.execute(sql`
      INSERT INTO user_battle_limits (
        id, user_id, max_value_usd, base_bet_limit_usd
      ) VALUES (
        ${crypto.randomUUID()}, ${parsed.userId}, ${parsed.maxValueUsd},
        ${parsed.baseBetLimitUsd}
      )
      ON CONFLICT (user_id) DO UPDATE SET
        max_value_usd = EXCLUDED.max_value_usd,
        base_bet_limit_usd = EXCLUDED.base_bet_limit_usd,
        updated_at = NOW()
    `);
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

  // TAG-ONLY — the battle-limits card reflects the saved value optimistically,
  // so a current-route `revalidatePath('/users/[id]')` would only re-render +
  // re-suspend the page and lose scroll. Busting the per-user cache tag keeps
  // the cached getUserDetail (which carries this tag) fresh without the churn.
  revalidateTag(`users-detail-${parsed.userId}`);
  return { success: true };
}

export async function clearUserBattleLimits(
  userId: string,
): Promise<{ success: true } | { success: false; error: string }> {
  const db = await getPrimaryDrizzleDb();
  const session = await requireAdmin();

  if (!userId || typeof userId !== "string") {
    return { success: false, error: "Invalid user id" };
  }

  try {
    // deleteMany is idempotent — count: 0 when no row exists, no throw.
    // Matches the removeUserTag pattern so a double-click on "Clear"
    // can't crash the page.
    await db.execute(sql`DELETE FROM user_battle_limits WHERE user_id = ${userId}`);
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

  // TAG-ONLY (see updateUserBattleLimits) — the card falls back to defaults
  // optimistically, so no current-route path revalidate.
  revalidateTag(`users-detail-${userId}`);
  return { success: true };
}

// ---------------------------------------------------------------------------
// VIP Tags — admin-CRM metadata on packy.gg users
// ---------------------------------------------------------------------------
// Admin-CRM tag system (VIP / Wager Abuser).
// Stored in the
// admin DB only — no main-DB write. The full set lives in the
// `admin_user_tags` table; this action only knows about the allow-listed
// tag values. Adding a new tag = update both the Zod enum here AND the
// CHECK constraint in
// the historical ADMIN user-tags VIP consolidation migration.

const USER_TAG_VALUES = ["vip", "wager_abuser"] as const;
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
    await adminDrizzle.execute(sql`
      INSERT INTO admin_user_tags (target_user_id, tag, set_by_admin_id)
      VALUES (${parsed.data.userId}, ${parsed.data.tag}, ${session.userId}::uuid)
      ON CONFLICT (target_user_id, tag) DO NOTHING
    `);
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

  // TAG-ONLY for the user-detail surface — NO `revalidatePath('/users/[id]')`.
  // The client (user-tags-panel) updates its committed set optimistically, so
  // a broad current-route path revalidate would only re-render + re-suspend
  // the page and lose the admin's scroll (see use-toggle-action.ts). Busting
  // the per-user cache tag keeps every server-driven tag view + the cached
  // getUserDetail in sync without that churn.
  revalidateTag(`users-detail-${parsed.data.userId}`);
  return { success: true };
}

/**
 * Remove a single (user, tag) pair. Idempotent — `deleteMany` returns
 * `{ count: 0 }` instead of throwing when the row is already
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
    const result = await adminDrizzle.execute(sql`
      DELETE FROM admin_user_tags
      WHERE target_user_id = ${parsed.data.userId}
        AND tag = ${parsed.data.tag}
      RETURNING target_user_id
    `);

    if (result.rows.length > 0) {
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

  // TAG-ONLY for the user-detail surface (see setUserTag) — the client flips
  // its committed set optimistically, so no current-route path revalidate.
  revalidateTag(`users-detail-${parsed.data.userId}`);
  return { success: true };
}
