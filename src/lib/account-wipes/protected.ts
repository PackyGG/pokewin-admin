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
 *  3. A creator-deal credit CAN, however, be entered by hand through the
 *     Adjust-Balance dialog (free-text reason) — e.g. the real prod row
 *     `Admin adjustment: weekly deal`. Those land as a genuine
 *     `admin_balance_adjustment` CREDIT and WOULD otherwise be wipeable.
 *     `isCreatorRelatedAdjustment()` below is the defensive description /
 *     metadata guard that carves them out so a deal-related credit can
 *     never be wiped even though it is technically an admin adjustment.
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
 * The canonical "what is preserved" reassurance line shown in every wipe
 * mode's confirm step (before the 2FA field). Single source of truth so all
 * four dialogs make the exact same promise the server-side guards enforce.
 */
export const WIPE_PRESERVED_SUMMARY =
  "Deposits, withdrawals, affiliate claims, gaming history, and all creator deal / fill / payout data are preserved.";
