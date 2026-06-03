/**
 * protected.ts — the SINGLE source of truth for what every account-wipe
 * mode (adjustments / balance / vault / inventory) must NEVER delete or
 * affect, plus the human-readable "what is preserved" copy the confirm
 * dialogs show before the 2FA field.
 *
 * WHY THIS EXISTS (owner mandate): the wipes claw back house-granted
 * CONTENT value (admin balance credits, spendable/vault balance, won-card
 * inventory). They must provably never touch the user's REAL financial or
 * creator-economy records:
 *   • deposits / withdrawals                — real cash in / out
 *   • affiliate_claim                        — paid creator/affiliate earnings
 *   • ALL affiliate info of any kind         — commissions, payouts, codes,
 *                                              attribution (no affiliate data
 *                                              is EVER wiped — see
 *                                              isAffiliateRelatedAdjustment()
 *                                              + WIPE_NEVER_TOUCHES_AFFILIATE_
 *                                              TABLES below)
 *   • every creator-DEAL ledger flow         — grant / activate / spend /
 *                                              refund / convert / forfeit,
 *                                              plus the affiliate-leaderboard
 *                                              escrow + prize legs
 *   • the "Manual withdrawal:" admin_balance_adjustment subset
 *
 * The guard is enforced SERVER-SIDE in each wipe action (per-row check +
 * the delete/zero predicate), not just surfaced in the UI. This module is
 * the shared definition both `wipe-adjustments-actions.ts` and
 * `wipe-account-targets-actions.ts` import, so the protected set can never
 * drift between the four modes.
 *
 * ─── VERIFIED against the live codebase ─────────────────────────────────
 *
 *  1. The ONLY admin-panel flows that write `admin_balance_adjustment`
 *     ledger rows are `adjustBalance` ("Admin adjustment: <reason>", the
 *     wipeable CREDIT) and `recordManualWithdrawal` ("Manual withdrawal:
 *     …", a DEBIT — never wipeable). Verified in
 *     src/app/(admin)/users/[id]/actions.ts.
 *  2. Creator-deal money in the ledger uses the DEDICATED `creator_fill_*`
 *     / `affiliate_leaderboard_*` / `affiliate_claim` types (written by the
 *     packy.gg backend; the admin-panel creator payout writes
 *     `affiliate_claim` "Creator payout"). NONE of them is an
 *     `admin_balance_adjustment`, so the adjustments wipe already can't
 *     reach them by TYPE — these constants make that exclusion explicit and
 *     fail-closed.
 *  3. A creator-deal OR affiliate credit CAN, however, be entered by hand
 *     through the Adjust-Balance dialog (free-text reason) — e.g. the real
 *     prod row `Admin adjustment: weekly deal`, or `Admin adjustment:
 *     affiliate commission`. Those land as a genuine `admin_balance_
 *     adjustment` CREDIT and WOULD otherwise be wipeable.
 *     `isCreatorRelatedAdjustment()` and `isAffiliateRelatedAdjustment()`
 *     below are the defensive description / metadata guards that carve them
 *     out so a deal- or affiliate-related credit can never be wiped even
 *     though it is technically an admin adjustment. Both guards run in all
 *     three wipe-action guard spots (listing filter, per-row pre-check, and
 *     the in-tx re-guard before deleteMany), fail-closed.
 *  4. `user_inventory.source_type` is the enum
 *     `{ pack, reward, battle, exchange, raffle, upgrader }` — there is NO
 *     creator-deal source. Creator-deal payouts materialize as VOUCHERS
 *     (`voucher_origin` includes `creator_fill_conversion` /
 *     `creator_multiplier_payout`), never as `user_inventory` rows, and the
 *     wipe never touches the `vouchers` table. So inventory has no
 *     creator-deal subset to exclude (documented; nothing to filter there).
 *
 * NOTE: deliberately NOT `import "server-only"`. This module is pure
 * constants + pure functions (no DB, no secrets, no env) and the user-facing
 * preserved-summary string + helpers are imported by BOTH the server wipe
 * actions AND the "use client" confirm dialogs (so the on-screen "what is
 * preserved" copy is the exact same string the server guards enforce).
 * Marking it server-only breaks the client `next build` (a client component
 * may not import a server-only module).
 */

import type { LedgerTransactionType } from "@/lib/metrics/ledger-sets";

/**
 * Ledger types that NO wipe mode may ever delete. This is the task's
 * "protected ledger types" set, expressed as real `ledger_transaction_type`
 * enum members (checked against prisma/schema.prisma's enum). The
 * adjustments wipe is the only mode that deletes ledger rows, and it only
 * targets `admin_balance_adjustment`; none of these share that value, so by
 * construction they are unreachable — but the per-row guard asserts it
 * explicitly (fail-closed) so a future change can't silently widen the
 * blast radius.
 *
 * NOTE: `creator_multiplier_payout` from the task brief is intentionally
 * absent — it is NOT a ledger type; it is a `voucher_origin` value (the
 * multiplier deal settles as a voucher). The ledger-resident creator-deal
 * legs are the `creator_*` and `affiliate_leaderboard_*` members below.
 */
export const PROTECTED_LEDGER_TYPES = [
  // Real cash movement — never a content clawback.
  "deposit",
  "card_withdrawal",
  // Paid affiliate / creator earnings.
  "affiliate_claim",
  // Creator-deal fill lifecycle (house-funded promo balance — backend-written).
  "creator_deal_fill_grant",
  "creator_fill_activation",
  "creator_fill_spend_tip",
  "creator_fill_spend_battle",
  "creator_fill_refund",
  "creator_fill_conversion",
  "creator_fill_forfeiture",
  // Affiliate-leaderboard escrow + prize legs.
  "affiliate_leaderboard_creation",
  "affiliate_leaderboard_refund",
  "affiliate_leaderboard_prize",
  // User→user creator tip pass-through.
  "creator_tip",
] as const satisfies readonly LedgerTransactionType[];

/** O(1) membership test for the protected set. */
const PROTECTED_LEDGER_TYPE_SET: ReadonlySet<string> = new Set(
  PROTECTED_LEDGER_TYPES,
);

/** True if a ledger type is in the never-wipe protected set. */
export function isProtectedLedgerType(type: string): boolean {
  return PROTECTED_LEDGER_TYPE_SET.has(type);
}

/**
 * The ONLY ledger type the adjustments wipe is ever allowed to delete, and
 * the description prefixes that split it. Re-exported here so the wipe
 * action and this guard agree on the taxonomy.
 *   - "Admin adjustment: " → a genuine admin CREDIT (wipeable, unless the
 *     creator-deal carve-out below catches it).
 *   - "Manual withdrawal:" → an off-platform payout DEBIT (never wipeable).
 */
export const ADJUSTMENT_LEDGER_TYPE = "admin_balance_adjustment" as const;
export const ADJUSTMENT_DESC_PREFIX = "Admin adjustment: ";
export const MANUAL_WITHDRAWAL_DESC_PREFIX = "Manual withdrawal:";

/**
 * Case-insensitive substrings that, when present in an
 * `admin_balance_adjustment` CREDIT's reason (or its metadata), mark it as
 * tied to the creator economy / a deal / an off-platform payout — and
 * therefore PROTECTED from the adjustments wipe even though it is
 * technically an admin adjustment.
 *
 * This is a DEFENSIVE, fail-closed carve-out for credits an admin typed by
 * hand via the Adjust-Balance dialog (the only way a deal can become an
 * `admin_balance_adjustment`). The real prod row `Admin adjustment: weekly
 * deal` is exactly this case. Keep the list broad on the side of caution:
 * a false positive merely makes a credit non-wipeable (safe); a false
 * negative could wipe protected deal money (unsafe).
 */
export const CREATOR_DEAL_ADJUSTMENT_KEYWORDS = [
  "creator",
  "deal",
  "fill",
  "payout",
  "streamer",
  "sponsor",
  "sponsorship",
  "multiplier",
  "affiliate",
] as const;

/**
 * True if an `admin_balance_adjustment` row looks creator-deal / payout
 * related and must therefore be excluded from the adjustments wipe. Checks
 * BOTH the free-text reason AND any string values inside the row's
 * `metadata` JSON (so a structured deal tag is caught even if the reason
 * text is innocuous).
 *
 * `description` is the FULL ledger description (with the "Admin adjustment:
 * " prefix or not — we match anywhere in the string). `metadata` is the raw
 * `ledger_transactions.metadata` jsonb value (may be null / object / array).
 */
export function isCreatorRelatedAdjustment(
  description: string | null | undefined,
  metadata?: unknown,
): boolean {
  const haystacks: string[] = [];
  if (typeof description === "string") haystacks.push(description.toLowerCase());

  // Flatten any string values inside metadata (shallow + nested) so a deal
  // reference stored structurally (e.g. { reason: "creator deal" } or
  // { deal_id: "…" }) is also caught. Keys are included too: a key like
  // "creator_deal_id" alone is a strong signal.
  if (metadata != null && typeof metadata === "object") {
    const stack: unknown[] = [metadata];
    let guard = 0;
    while (stack.length && guard < 1000) {
      guard++;
      const cur = stack.pop();
      if (cur == null) continue;
      if (typeof cur === "string") {
        haystacks.push(cur.toLowerCase());
      } else if (Array.isArray(cur)) {
        for (const v of cur) stack.push(v);
      } else if (typeof cur === "object") {
        for (const [k, v] of Object.entries(cur)) {
          haystacks.push(k.toLowerCase());
          stack.push(v);
        }
      }
    }
  }

  if (haystacks.length === 0) return false;
  const blob = haystacks.join(" ");
  return CREATOR_DEAL_ADJUSTMENT_KEYWORDS.some((kw) => blob.includes(kw));
}

/**
 * Case-insensitive substrings that, when present in an
 * `admin_balance_adjustment` CREDIT's reason (or its metadata), mark it as
 * AFFILIATE info of any kind — an affiliate/referral commission, an affiliate
 * payout / bonus, a downstream-referral earning, etc. — and therefore
 * PROTECTED from the adjustments wipe even though it is technically an admin
 * adjustment.
 *
 * WHY THIS EXISTS (owner mandate): no affiliate info of ANY kind may ever be
 * wiped. The dedicated affiliate ledger flows (`affiliate_claim`, the
 * `affiliate_leaderboard_*` legs) are already blocked by
 * PROTECTED_LEDGER_TYPES — and the admin-panel affiliate/creator payout writes
 * `affiliate_claim` "Creator payout" (type-protected, verified in
 * src/app/(admin)/creators/actions.ts). The ONLY way affiliate value can land
 * as a wipeable `admin_balance_adjustment` CREDIT is when an admin types it by
 * hand through the free-text Adjust-Balance dialog (e.g. "Admin adjustment:
 * affiliate commission" / "referral payout"). This keyword guard carves those
 * out so an affiliate-tagged credit can never be wiped.
 *
 * The list deliberately overlaps with CREATOR_DEAL_ADJUSTMENT_KEYWORDS on
 * "affiliate" / "payout" — that is intentional defence in depth (a row caught
 * by EITHER guard is protected). Keep it broad on the side of caution: a false
 * positive merely makes a credit non-wipeable (safe); a false negative could
 * wipe protected affiliate money (unsafe). NOTE: short tokens like "ref" are
 * excluded on purpose — they would substring-match innocuous words ("reFUND",
 * "REFerence") and over-protect unrelated rows; the affiliate concepts are
 * spelled out in full instead.
 */
export const AFFILIATE_ADJUSTMENT_KEYWORDS = [
  "affiliate",
  "commission",
  "referral",
  "referrer",
  "referred",
  "payout",
] as const;

/**
 * True if an `admin_balance_adjustment` row looks like AFFILIATE info (a
 * commission / referral / affiliate payout or bonus) and must therefore be
 * excluded from the adjustments wipe. Mirrors `isCreatorRelatedAdjustment`
 * exactly: it scans BOTH the free-text reason AND any string keys/values
 * inside the row's `metadata` JSON (so a structured affiliate tag is caught
 * even when the reason text is innocuous).
 *
 * `description` is the FULL ledger description (we match anywhere in the
 * string). `metadata` is the raw `ledger_transactions.metadata` jsonb value
 * (may be null / object / array).
 */
export function isAffiliateRelatedAdjustment(
  description: string | null | undefined,
  metadata?: unknown,
): boolean {
  const haystacks: string[] = [];
  if (typeof description === "string") haystacks.push(description.toLowerCase());

  // Same shallow+nested flatten as isCreatorRelatedAdjustment: pull every
  // string key and value out of metadata so an affiliate reference stored
  // structurally (e.g. { reason: "affiliate commission" } or
  // { affiliate_code_usage_id: "…" }) is also caught.
  if (metadata != null && typeof metadata === "object") {
    const stack: unknown[] = [metadata];
    let guard = 0;
    while (stack.length && guard < 1000) {
      guard++;
      const cur = stack.pop();
      if (cur == null) continue;
      if (typeof cur === "string") {
        haystacks.push(cur.toLowerCase());
      } else if (Array.isArray(cur)) {
        for (const v of cur) stack.push(v);
      } else if (typeof cur === "object") {
        for (const [k, v] of Object.entries(cur)) {
          haystacks.push(k.toLowerCase());
          stack.push(v);
        }
      }
    }
  }

  if (haystacks.length === 0) return false;
  const blob = haystacks.join(" ");
  return AFFILIATE_ADJUSTMENT_KEYWORDS.some((kw) => blob.includes(kw));
}

/**
 * The wipe NEVER touches any affiliate TABLE — asserted here for the record.
 *
 * The four wipe modes only ever read/write THREE main-DB surfaces:
 *   • `ledger_transactions` (the adjustments wipe — and ONLY `admin_balance_
 *     adjustment` CREDIT rows within it, after the protected-type + creator +
 *     affiliate carve-outs above),
 *   • `balances` (the balance / vault wipes — `available_balance` /
 *     `locked_balance`),
 *   • `user_inventory` (+ its `provably_fair_results` children — the inventory
 *     wipe).
 *
 * NONE of `affiliate_accounts`, `affiliate_code_usages`, `affiliate_codes`,
 * `affiliate_payouts`, `affiliate_clicks`, or `affiliate_code_queue` is in
 * that set. So an affiliate account's earned/available/paid-out totals, every
 * code-usage attribution row (commissions owed + referral linkage), the
 * affiliate code itself, and the payout history are STRUCTURALLY untouched by
 * any wipe — there is nothing to carve out there because the wipe never
 * reaches those tables in the first place. Deleting from them is explicitly
 * OUT OF SCOPE and must never be added to a wipe mode. The rolled-back proof
 * (scripts/verify-affiliate-wipe-protection.ts) demonstrates that a wipe
 * leaves the user's `affiliate_accounts` / `affiliate_code_usages` rows
 * intact.
 */
export const WIPE_NEVER_TOUCHES_AFFILIATE_TABLES = true as const;

/**
 * The canonical "what is preserved" reassurance line shown in every wipe
 * mode's confirm step (before the 2FA field). Single source of truth so all
 * four dialogs make the exact same promise the server-side guards enforce.
 *
 * Spells out the affiliate + creator coverage explicitly (owner mandate: no
 * affiliate info of any kind, and no creator-deal data, is ever wiped).
 */
export const WIPE_PRESERVED_SUMMARY =
  "Deposits, withdrawals, all affiliate data (claims, commissions, codes, attribution), gaming history, and all creator deal / fill / payout data are preserved.";
