"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { adminDb } from "@/lib/admin-db";
import { requireAdmin } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { require2FA } from "@/lib/require-2fa";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { toNumber } from "@/lib/utils/decimal";
import type { Prisma } from "@/generated/prisma/client";
import { ensureBalanceAdjustmentWipesSchema } from "@/lib/balance-adjustment-wipes/ensure-schema";
import {
  wipeSnapshotToJsonValue,
  type BalanceAdjustmentWipeSnapshot,
} from "@/lib/balance-adjustment-wipes/snapshot";
import {
  isProtectedLedgerType,
  isCreatorRelatedAdjustment,
  isAffiliateRelatedAdjustment,
} from "@/lib/account-wipes/protected";
import { getCreatorProtectionStatus } from "@/lib/account-wipes/creator-protection";
import { invalidateMetricCaches } from "@/lib/account-wipes/invalidate-metric-caches";
import {
  WIPE_STATUS,
  finalizeWipeSuccess,
  markWipeFailed,
  resolveRequestIp,
  type WipeStatus,
} from "@/lib/account-wipes/finalize";

// ---------------------------------------------------------------------------
// "Wipe content balance adjustments" — DELETE the admin balance-adjustment
// rows the admin selected (CREDITS *and* DEBITS), reduce the user's balance
// ONLY by the credits' summed amount (never raise it — see BALANCE RULE), and
// snapshot the deleted rows so the batch is recoverable.
//
// WHY: the owner grants creators admin balance adjustments so they can make
// content (open packs / stream), and occasionally posts DEBIT adjustments
// (corrections). The owner needs to delete ANY of these records — including
// the two stuck DEBIT adjustments that the old credit-only filter refused to
// list. This claws the records out WITHOUT touching real financial or gaming
// history.
//
// The ledger type that backs admin adjustments AND manual withdrawals is
// the SAME enum value: `admin_balance_adjustment` (verified against
// src/app/(admin)/users/[id]/actions.ts and
// src/lib/queries/insights-balance-adjustments/_shared.ts). The two are
// distinguished ONLY by the `description` prefix the write flows stamp:
//   - "Admin adjustment: <reason>"     ← a real balance adjustment (WIPEABLE)
//   - "Manual withdrawal: <reason> …"  ← an off-platform payout (NEVER wiped)
//
// So the wipeable set is: type === ADJ_TYPE AND description starts with
// ADJ_DESC_PREFIX (and NOT "Manual withdrawal:"). Credits AND debits within
// that set are deletable; manual withdrawals are ALWAYS excluded.
//
// CREATOR-CONDITIONAL CARVE-OUT (owner mandate, 2026-06-03): the two keyword
// carve-outs (isCreatorRelatedAdjustment + isAffiliateRelatedAdjustment),
// which drop any adjustment whose reason / metadata ties it to a creator deal
// OR to ANY affiliate info (commission / referral / affiliate payout), are
// applied ONLY when the target user IS or WAS a creator (the server-re-derived
// `everCreator` flag — getCreatorProtectionStatus). For a user who was NEVER a
// creator, a hand-typed "Admin adjustment: weekly deal" / "affiliate
// commission" row IS wipeable. The protected-LEDGER-TYPE assertion + the
// "Manual withdrawal:" exclusion stay UNCONDITIONAL.
//
// ORDERING (CRITICAL, snapshot-first): the recovery snapshot is written to
// the admin DB and confirmed BEFORE the main-DB delete + balance reduction.
// If the snapshot can't be written → abort before deleting (nothing
// changes, no money-back surprise). Once the main-DB delete commits the
// wipe is PERMANENT — there is no rollback path that re-adds money. (The
// prior delete→snapshot→rollback design could re-credit a user when the
// snapshot failed; that path is removed.)
// ---------------------------------------------------------------------------

/** The ledger enum value admin balance adjustments are written with. */
const ADJ_TYPE = "admin_balance_adjustment" as const;
/** Description prefix that marks a row as a genuine balance ADJUSTMENT. */
const ADJ_DESC_PREFIX = "Admin adjustment: ";
/** Description prefix the manual-withdrawal flow uses — must NOT be wiped. */
const MANUAL_WD_DESC_PREFIX = "Manual withdrawal:";

// BALANCE RULE — deleting NEVER raises the balance (CRITICAL, owner mandate).
//
// An `admin_balance_adjustment` row stores the SIGNED balance delta that was
// applied (`adjustBalance`: `newBalance = currentBalance + amount`, with
// `amount` written verbatim — actions.ts:158,179). So:
//   - amount > 0  → CREDIT: the house GAVE the user balance (content money).
//   - amount < 0  → DEBIT:  the house TOOK balance back (a clawback /
//                            correction).
//
// When we DELETE a selected batch:
//   - For each CREDIT (amount > 0): claw it back → reduce the balance by that
//     amount (the reverse of how it was added). Clamp the result at ≥ 0.
//   - For each DEBIT (amount < 0): delete the record but leave the balance
//     UNCHANGED — do NOT restore the money the debit removed. Re-adding it
//     would INFLATE the balance, which is exactly the prod incident the old
//     credit-only filter was bolted on to avoid ("it added the money back as
//     balance and is still there"). We now allow deleting the debit ROW while
//     keeping its balance effect, so nothing inflates.
//
// Therefore the balance reduction = Σ(positive amounts only) = `creditClawback`,
// clamped so the balance never goes negative. The balance can only ever go
// DOWN or stay the same — never up. (For the owner's two stuck debits: the
// records delete, creditClawback contributes 0 from them, the balance stays
// put.)
//
// RESTORE symmetry: a restore re-inserts ALL deleted rows AND re-adds EXACTLY
// the amount the wipe removed (`balance_before − balance_after`, which already
// accounts for the clamp + is credit-only), so wipe→restore is a perfect
// round-trip for the balance.

/** Max rows we surface / accept in one wipe batch (sanity bound). */
const MAX_BATCH = 500;

export type WipeableAdjustment = {
  id: string;
  /** Signed balance delta: > 0 = credit (clawed back on wipe), < 0 = debit (balance left unchanged). */
  amount: number;
  /** Raw admin reason — description with the "Admin adjustment: " prefix stripped. */
  reason: string;
  createdAt: string;
};

export type RecoverableWipe = {
  id: string;
  wipedAt: string;
  wipedByLabel: string;
  totalAmount: number;
  balanceBefore: number;
  balanceAfter: number;
  adjustmentCount: number;
  /**
   * Lifecycle status. 'completed' is the normal restorable state (and the
   * back-compat value for rows predating the column). 'pending' = the
   * committed wipe's audit-finalize is incomplete (restore refused until
   * reconciled). 'failed' batches (the delete never happened) are filtered
   * OUT of this listing.
   */
  status: WipeStatus;
  restoredAt: string | null;
  restoredByLabel: string | null;
};

/**
 * Shared gate for every action in this file. Mirrors the destructive
 * `wipeUserAccount` gate (requireAdmin + __can_wipe_accounts) — this is a
 * hard-delete of money rows, so it gets the strongest gate on the page, not
 * the permissive __can_adjust_balance capability. Returns the session.
 */
async function gateWipe() {
  const session = await requireAdmin();
  await requireCapability(
    session,
    "__can_wipe_accounts",
    "wipe balance adjustments",
  );
  return session;
}

const userIdSchema = z.string().min(1, "User id is required");

/**
 * Lazily list THIS user's wipeable admin balance-adjustment rows. Called by
 * the dialog when it opens (the dialog is a hidden component — per the
 * active-data rule we do NOT preload these on page render). Read-only.
 *
 * Lists the genuine "Admin adjustment:" subset — BOTH credits and debits.
 * Manual withdrawals (same ledger type, different prefix) are excluded so
 * they can never be selected. On top of that, for an EVER-CREATOR only, any
 * row whose reason / metadata ties it to a CREATOR DEAL / payout (e.g. the
 * real prod row "Admin adjustment: weekly deal") is excluded via
 * `isCreatorRelatedAdjustment`, AND any row tied to ANY affiliate info
 * (commission / referral / affiliate payout — e.g. "Admin adjustment:
 * affiliate commission") is excluded via `isAffiliateRelatedAdjustment`, so
 * neither deal money nor affiliate info entered by hand through the
 * Adjust-Balance dialog can ever be wiped for a creator (the wipe protects all
 * creator-deal AND all affiliate data — see src/lib/account-wipes/protected.ts).
 *
 * Debits ARE listed now (the old `amount > 0` filter is gone): deleting a
 * debit removes the record but leaves the balance unchanged (BALANCE RULE), so
 * it never inflates the balance. The signed `amount` lets the UI mark each row
 * as a credit (+) or debit (−).
 */
export async function listWipeableAdjustments(
  userId: string,
): Promise<{ success: true; rows: WipeableAdjustment[] } | { success: false; error: string }> {
  await gateWipe();

  const parsed = userIdSchema.safeParse(userId);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid user id" };
  }

  const db = await getDb();

  // CREATOR-CONDITIONAL: re-derive (server-side, dual-DB) whether this user
  // IS or WAS a creator. The deal/affiliate keyword carve-out below is applied
  // ONLY for an ever-creator; for a never-creator every genuine admin
  // adjustment is wipeable, including deal-tagged ones.
  const { everCreator } = await getCreatorProtectionStatus(parsed.data);

  // List genuine admin adjustments (credits AND debits). `startsWith` on the
  // description excludes "Manual withdrawal:" rows (same type) and any other
  // future prefix. NO sign filter — debits are deletable (their balance effect
  // is intentionally left in place per the BALANCE RULE). status = completed
  // mirrors how the rows are written (and how the insights surface counts
  // them). `metadata` is pulled so the creator-deal carve-out can inspect
  // structured deal tags, not just the reason text.
  const rows = await db.ledger_transactions.findMany({
    where: {
      user_id: parsed.data,
      type: ADJ_TYPE,
      status: "completed",
      description: { startsWith: ADJ_DESC_PREFIX },
    },
    orderBy: { created_at: "desc" },
    take: MAX_BATCH,
    select: { id: true, amount: true, description: true, metadata: true, created_at: true },
  });

  return {
    success: true,
    rows: rows
      // CREATOR-DEAL + AFFILIATE CARVE-OUT (creator-conditional): for an
      // ever-creator, never list a credit tied to a creator deal / payout OR
      // to any affiliate info (commission / referral / affiliate payout) — the
      // wipe protects ALL creator-deal AND ALL affiliate data for creators, so
      // such a credit entered via Adjust-Balance is filtered out here AND
      // hard-rejected by the in-tx guard below if its id is injected. For a
      // never-creator the carve-out does not apply (the row is a wipeable
      // content credit).
      .filter(
        (r) =>
          !everCreator ||
          (!isCreatorRelatedAdjustment(r.description, r.metadata) &&
            !isAffiliateRelatedAdjustment(r.description, r.metadata)),
      )
      .map((r) => ({
        id: r.id,
        amount: toNumber(r.amount),
        reason: r.description.slice(ADJ_DESC_PREFIX.length),
        createdAt: r.created_at.toISOString(),
      })),
  };
}

/**
 * List recoverable wipe batches for a user (newest first), resolving the
 * admin display labels. Used by the user-detail "Recoverable wipes" strip
 * and its restore button. Read-only against the admin DB.
 */
export async function listBalanceAdjustmentWipes(
  userId: string,
): Promise<RecoverableWipe[]> {
  await gateWipe();

  const parsed = userIdSchema.safeParse(userId);
  if (!parsed.success) return [];

  await ensureBalanceAdjustmentWipesSchema();

  const wipes = await adminDb.admin_balance_adjustment_wipes.findMany({
    // Exclude 'failed' batches: those deletes never happened (the main-DB tx
    // rolled back), so they are not real wipe history and must never appear
    // as restorable. 'completed' (incl. back-compat legacy rows) + 'pending'
    // (committed but audit-unfinalized) are shown.
    where: { user_id: parsed.data, status: { not: WIPE_STATUS.FAILED } },
    orderBy: { wiped_at: "desc" },
    take: 50,
  });
  if (wipes.length === 0) return [];

  // Resolve admin usernames for wiped_by / restored_by in one query.
  const adminIds = new Set<string>();
  for (const w of wipes) {
    adminIds.add(w.wiped_by);
    if (w.restored_by) adminIds.add(w.restored_by);
  }
  const admins = adminIds.size
    ? await adminDb.admin_users.findMany({
        where: { id: { in: Array.from(adminIds) } },
        select: { id: true, username: true, display_username: true },
      })
    : [];
  const labels = new Map(
    admins.map((a) => [a.id, a.display_username ?? a.username]),
  );

  return wipes.map((w) => ({
    id: w.id,
    wipedAt: w.wiped_at.toISOString(),
    wipedByLabel: labels.get(w.wiped_by) ?? w.wiped_by,
    totalAmount: toNumber(w.total_amount),
    balanceBefore: toNumber(w.balance_before),
    balanceAfter: toNumber(w.balance_after),
    adjustmentCount: w.adjustment_count,
    status: (w.status as WipeStatus),
    restoredAt: w.restored_at?.toISOString() ?? null,
    restoredByLabel: w.restored_by
      ? labels.get(w.restored_by) ?? w.restored_by
      : null,
  }));
}

const wipeSchema = z.object({
  userId: z.string().min(1, "User id is required"),
  ledgerIds: z
    .array(z.string().min(1))
    .min(1, "Select at least one adjustment to wipe")
    .max(MAX_BATCH, `Cannot wipe more than ${MAX_BATCH} adjustments at once`),
  totpCode: z.string().min(1, "2FA code is required"),
});

/**
 * Hard-delete the selected admin balance-adjustment CREDIT rows, reduce the
 * user's available_balance by their summed amount, and snapshot the deleted
 * rows into the admin DB so the batch is recoverable.
 *
 * SAFETY (defence in depth, all server-side):
 *   1. Gate: requireAdmin + __can_wipe_accounts + 2FA.
 *   2. Provision the recovery store (ensure-schema). If it can't be
 *      provisioned → abort before touching the main DB.
 *   3. READ + GUARD the selected rows (own read tx). Refuse the whole batch
 *      unless EVERY row is:
 *        - owned by `userId`,
 *        - type === admin_balance_adjustment,
 *        - description starts with "Admin adjustment: " (NOT a manual
 *          withdrawal, NOT any other prefix),
 *        - status === completed.
 *      Credits AND debits are accepted (no sign filter). A single
 *      bad/foreign/tampered/manual-withdrawal id aborts the entire wipe.
 *   4. SNAPSHOT FIRST: write the recovery copy to
 *      admin_balance_adjustment_wipes (admin DB) and get its id. If this
 *      throws → abort. NOTHING has been deleted, the balance is untouched,
 *      no money-back surprise.
 *   5. DELETE + REDUCE in ONE main-DB $transaction: re-guard + deleteMany
 *      EXACTLY those ids (scoped by id + user + type + prefix), then reduce
 *      available_balance by the CREDIT clawback only (Σ positive amounts,
 *      clamped ≥ 0; optimistic-locked on `version`). DEBITS delete but do
 *      NOT change the balance (BALANCE RULE — never inflate). Because the
 *      snapshot already exists, the committed delete is PERMANENT — no
 *      rollback re-adds money.
 *   6. If the main-DB tx FAILS, mark the orphan snapshot 'failed' (the
 *      recovery copy is unused because nothing was deleted) and report.
 *
 * The balance reduction (`creditClawback`) is the sum of the POSITIVE amounts
 * only (≥ 0), so the balance can only ever go DOWN or stay put — deleting a
 * debit never raises it.
 *
 * CAVEAT (owner-accepted): hard-delete breaks balance_before/after
 * continuity on the user's REMAINING ledger rows. We correct the CURRENT
 * balance but deliberately do NOT rewrite other rows' historical
 * balance_before/after. Surfaced in the dialog copy + the audit event.
 */
export async function wipeBalanceAdjustments(data: {
  userId: string;
  ledgerIds: string[];
  totpCode: string;
}): Promise<
  | { success: true; deletedCount: number; totalRemoved: number; balanceBefore: number; balanceAfter: number }
  | { success: false; error: string }
> {
  const session = await gateWipe();

  const parseResult = wipeSchema.safeParse(data);
  if (!parseResult.success) {
    return { success: false, error: parseResult.error.issues[0]?.message ?? "Invalid input" };
  }
  const parsed = parseResult.data;

  // De-dupe ids defensively so a repeated id can't be counted twice toward
  // the balance reduction.
  const ids = Array.from(new Set(parsed.ledgerIds));

  try {
    await require2FA(session.userId, parsed.totpCode);
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "2FA verification failed" };
  }

  // STEP 2 — Provision the recovery store before we touch anything in the
  // main DB. If the admin DB / schema is unreachable we must NOT delete rows
  // we can't snapshot. A failure here aborts before any destructive write.
  try {
    await ensureBalanceAdjustmentWipesSchema();
  } catch (err) {
    console.error("[wipeBalanceAdjustments] ensure-schema failed:", err);
    return {
      success: false,
      error: "Could not prepare the recovery store — wipe aborted (nothing deleted)",
    };
  }

  const db = await getDb();

  // CREATOR-CONDITIONAL (server-re-derived, dual-DB): the deal/affiliate
  // keyword carve-out in the guards below is applied ONLY when this user IS or
  // WAS a creator. Never trusted from the client — recomputed here from the
  // DBs. Fail-closed (a derivation error returns everCreator: true → protect).
  const { everCreator } = await getCreatorProtectionStatus(parsed.userId);

  // STEP 3 — READ + GUARD. Read the exact selected rows and verify EVERY one
  // is this user's genuine admin-adjustment CREDIT. This read is in its own
  // short tx; the authoritative re-guard also runs again inside the
  // delete/reduce tx (STEP 5), so a row that changes in between can't slip
  // through. Nothing is mutated here.
  let guardedRows: Array<Record<string, unknown>>;
  let totalRemoved = 0;
  try {
    const rows = await db.ledger_transactions.findMany({
      where: { id: { in: ids } },
    });

    if (rows.length !== ids.length) {
      throw new Error("WIPE_GUARD: some selected adjustments no longer exist — refresh and retry");
    }

    for (const row of rows) {
      if (row.user_id !== parsed.userId) {
        throw new Error("WIPE_GUARD: a selected row does not belong to this user");
      }
      // PROTECTED-TYPE GUARD (fail-closed): a deposit / withdrawal /
      // affiliate_claim / any creator-deal or affiliate-leaderboard ledger
      // type must NEVER be deletable by a wipe. None of these is an
      // `admin_balance_adjustment`, so the `row.type !== ADJ_TYPE` check
      // below already rejects them — but assert the protected set
      // explicitly so the protection is obvious and can't regress if the
      // type filter is ever loosened.
      if (isProtectedLedgerType(row.type)) {
        throw new Error("WIPE_GUARD: a selected row is protected financial/creator data and cannot be wiped");
      }
      if (row.type !== ADJ_TYPE) {
        throw new Error("WIPE_GUARD: a selected row is not a balance adjustment");
      }
      if (
        !row.description.startsWith(ADJ_DESC_PREFIX) ||
        row.description.startsWith(MANUAL_WD_DESC_PREFIX)
      ) {
        throw new Error("WIPE_GUARD: a selected row is not a genuine admin adjustment");
      }
      if (row.status !== "completed") {
        throw new Error("WIPE_GUARD: a selected row is not a completed adjustment");
      }
      // NOTE: NO sign filter — credits AND debits are both deletable. A debit
      // deletes the record but leaves the balance unchanged (BALANCE RULE,
      // applied in the balance computation below), so deleting it can never
      // re-add money.
      // CREATOR-DEAL CARVE-OUT (creator-conditional, fail-closed): for an
      // ever-creator, an admin adjustment whose reason / metadata ties it to a
      // creator deal / payout (e.g. "Admin adjustment: weekly deal") is
      // protected even though it is an admin_balance_adjustment credit. A
      // single such id aborts the batch. For a never-creator this does not
      // apply (the credit is wipeable content money).
      if (everCreator && isCreatorRelatedAdjustment(row.description, row.metadata)) {
        throw new Error(
          "WIPE_GUARD: a selected adjustment is tied to a creator deal / payout and is protected for creators — it cannot be wiped",
        );
      }
      // AFFILIATE CARVE-OUT (creator-conditional, fail-closed): for an
      // ever-creator, an admin adjustment whose reason / metadata ties it to
      // ANY affiliate info (commission / referral / affiliate payout — e.g.
      // "Admin adjustment: affiliate commission") is protected even though it
      // is an admin_balance_adjustment credit. No affiliate info of any kind
      // is wiped for a creator. A single such id aborts the batch. For a
      // never-creator this does not apply.
      if (everCreator && isAffiliateRelatedAdjustment(row.description, row.metadata)) {
        throw new Error(
          "WIPE_GUARD: a selected adjustment is affiliate info (commission / referral / payout) and is protected for creators — it cannot be wiped",
        );
      }
    }

    guardedRows = rows as unknown as Array<Record<string, unknown>>;
    // Sum of the SIGNED amounts (credits + debits) — informational only
    // (reported as `totalRemoved` + stored on the snapshot for the audit
    // trail). The BALANCE reduction is computed separately below as the
    // credit-only clawback (positive amounts), so a debit in the batch never
    // raises the balance.
    totalRemoved = rows.reduce((acc, r) => acc + toNumber(r.amount), 0);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    if (message.startsWith("WIPE_GUARD:")) {
      return { success: false, error: message.replace(/^WIPE_GUARD:\s*/, "") };
    }
    console.error("[wipeBalanceAdjustments] guard read failed:", err);
    return { success: false, error: "Wipe failed — please try again (nothing was deleted)" };
  }

  // STEP 4 — SNAPSHOT FIRST. Write the recovery copy to the admin DB BEFORE
  // any destructive main-DB write, and capture its id. If this throws the
  // function returns here: nothing in the main DB has changed, the balance
  // is untouched. There is no path where money is deleted/reduced without a
  // recoverable snapshot already in place, and no rollback that re-adds
  // money. balance_before/after are recorded from a fresh read so the
  // snapshot row reflects the balance the wipe is about to act on.
  const userMeta = await db.user
    .findUnique({
      where: { id: parsed.userId },
      select: { username: true, email: true },
    })
    .catch(() => null);

  const preBalanceRow = await db.balances
    .findUnique({ where: { user_id: parsed.userId } })
    .catch(() => null);
  if (!preBalanceRow) {
    return { success: false, error: "User balances not found" };
  }
  const balanceBefore = toNumber(preBalanceRow.available_balance);
  // Version captured here is the one STEP 5 optimistic-locks on, so a
  // successful commit is guaranteed to have acted on EXACTLY this balance —
  // the snapshot's recorded balance_before/after can never disagree with the
  // committed result (if the balance moved, STEP 5 aborts + cleans up).
  const lockVersion = preBalanceRow.version;
  // BALANCE RULE: reduce ONLY by the credits' summed amount (positive
  // amounts). Debits in the batch delete their record but contribute 0 to the
  // clawback, so the balance is never raised by deleting a debit.
  const creditClawback = (guardedRows as Array<{ amount: unknown }>).reduce(
    (acc, r) => {
      const a = toNumber(r.amount as never);
      return a > 0 ? acc + a : acc;
    },
    0,
  );
  const reducedBalance = balanceBefore - creditClawback;
  // Never drive spendable balance negative (a wager balance check elsewhere
  // would misbehave). A clamp means the user had already spent some of the
  // credited money; the shortfall is surfaced in the audit metadata.
  const balanceAfter = reducedBalance < 0 ? 0 : reducedBalance;

  const snapshot: BalanceAdjustmentWipeSnapshot = {
    userId: parsed.userId,
    rows: guardedRows,
  };

  let wipeId: string;
  try {
    const created = await adminDb.admin_balance_adjustment_wipes.create({
      data: {
        user_id: parsed.userId,
        username: userMeta?.username ?? null,
        email: userMeta?.email ?? null,
        wiped_by: session.userId,
        total_amount: totalRemoved,
        balance_before: balanceBefore,
        balance_after: balanceAfter,
        adjustment_count: guardedRows.length,
        // 'pending' until the destructive main-DB tx commits AND the
        // status→completed + audit row are written atomically below.
        status: WIPE_STATUS.PENDING,
        snapshot: wipeSnapshotToJsonValue(snapshot) as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    wipeId = created.id;
  } catch (snapErr) {
    console.error(
      "[wipeBalanceAdjustments] snapshot write failed — wipe aborted (nothing deleted):",
      snapErr,
    );
    return {
      success: false,
      error: "Could not write the recovery snapshot — wipe aborted (nothing deleted)",
    };
  }

  // STEP 5 — DELETE + REDUCE in one main-DB transaction. The snapshot now
  // exists, so once this commits the wipe is PERMANENT and recoverable; if
  // it FAILS we delete the orphan snapshot in STEP 6 (nothing was deleted,
  // so the recovery copy is unused). The guard predicate is re-applied to
  // the deleteMany so the DELETE can't touch anything outside the verified
  // credit set even under a race.
  try {
    await db.$transaction(async (tx) => {
      // RE-GUARD INSIDE THE TX (authoritative): re-read the exact rows and
      // re-run the full per-row guard — protected-type + genuine-credit +
      // SIGN RULE + creator-deal carve-out + affiliate carve-out — on the
      // live data before deleting. The deleteMany predicate below can encode
      // type/prefix/sign in SQL but NOT the keyword-based creator/affiliate
      // carve-outs, so this in-tx re-check is what makes those carve-outs
      // fail-closed against a concurrent edit (e.g. a reason changed to
      // "weekly deal" or "affiliate commission" between the STEP 3 read and
      // now). Any violation aborts the whole tx → nothing deleted, orphan
      // snapshot cleaned up in STEP 6.
      const live = await tx.ledger_transactions.findMany({
        where: { id: { in: ids } },
        select: { id: true, user_id: true, type: true, status: true, description: true, amount: true, metadata: true },
      });
      if (live.length !== ids.length) {
        throw new Error("WIPE_GUARD: delete count mismatch — refresh and retry");
      }
      for (const row of live) {
        if (
          row.user_id !== parsed.userId ||
          isProtectedLedgerType(row.type) ||
          row.type !== ADJ_TYPE ||
          row.status !== "completed" ||
          !row.description.startsWith(ADJ_DESC_PREFIX) ||
          row.description.startsWith(MANUAL_WD_DESC_PREFIX) ||
          // NO sign filter — credits AND debits are deletable (the debit's
          // balance effect is intentionally left in place).
          // CREATOR-CONDITIONAL carve-outs: only protect deal/affiliate-tagged
          // rows when the user is/was a creator (same flag as STEP 3).
          (everCreator && isCreatorRelatedAdjustment(row.description, row.metadata)) ||
          (everCreator && isAffiliateRelatedAdjustment(row.description, row.metadata))
        ) {
          throw new Error("WIPE_GUARD: a selected row is protected and cannot be wiped — refresh and retry");
        }
      }

      const del = await tx.ledger_transactions.deleteMany({
        where: {
          id: { in: ids },
          user_id: parsed.userId,
          type: ADJ_TYPE,
          status: "completed",
          description: { startsWith: ADJ_DESC_PREFIX },
        },
      });
      if (del.count !== ids.length) {
        // Predicate mismatch between the guard read and the delete (e.g. a
        // row was restored/edited concurrently) → abort so nothing is
        // half-deleted; the snapshot orphan is cleaned up below.
        throw new Error("WIPE_GUARD: delete count mismatch — refresh and retry");
      }

      // Reduce available_balance by the summed credit amount (reverse of how
      // adjustBalance added it). Optimistic-locked on the version captured
      // when the snapshot was written (lockVersion) — if the balance changed
      // in the meantime this updates 0 rows and the whole tx aborts, so the
      // snapshot's recorded balance_before/after always matches the committed
      // result. We write the precomputed `balanceAfter` (derived from
      // `balanceBefore`, the value at lockVersion) for the same reason.
      const updated = await tx.balances.updateMany({
        where: { user_id: parsed.userId, version: lockVersion },
        data: {
          available_balance: balanceAfter,
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) {
        throw new Error("Balance changed concurrently — please retry");
      }
    });
  } catch (err) {
    // STEP 6 — main-DB tx failed: the whole tx rolled back, so NOTHING was
    // deleted and the balance is unchanged. Mark the snapshot 'failed' (a
    // terminal, detectable state restore refuses) instead of deleting it, so
    // it can't surface as a phantom recoverable batch (its ledger rows still
    // exist, so a later "restore" would re-credit money that was never
    // removed) AND there's a reconcilable record the delete did not happen.
    await markWipeFailed("adjustments", wipeId);

    const message = err instanceof Error ? err.message : "Unknown error";
    if (
      message.startsWith("WIPE_GUARD:") ||
      message === "User balances not found" ||
      message.includes("concurrently")
    ) {
      return { success: false, error: message.replace(/^WIPE_GUARD:\s*/, "") };
    }
    console.error("[wipeBalanceAdjustments] delete/reduce transaction failed:", err);
    return { success: false, error: "Wipe failed — please try again (nothing was deleted)" };
  }

  // STEP 7 — the delete + balance reduction COMMITTED. Atomically (one
  // admin-DB tx) flip the snapshot status → 'completed' AND write the audit
  // event, so this now-permanent wipe can never be left without an audit row.
  // If finalize fails after all retries the snapshot is left 'pending'
  // (detectable) + logged CRITICAL; we surface that while keeping the wipe
  // recoverable.
  const finalized = await finalizeWipeSuccess({
    store: "adjustments",
    wipeId,
    audit: {
      adminUserId: session.userId,
      eventType: "balance_adjustments_wiped",
      targetUserId: parsed.userId,
      ip: await resolveRequestIp(),
      metadata: {
        wipeId,
        deletedIds: ids,
        deletedCount: guardedRows.length,
        totalRemoved,
        creditClawback,
        balanceBefore,
        balanceAfter,
        balanceClamped: reducedBalance < 0,
        recoverable: true,
        caveat:
          "hard-delete (credits AND debits): balance reduced ONLY by the credit clawback (Σ positive amounts, clamped ≥0); deleted debits leave the balance unchanged (never inflate). Remaining ledger rows' balance_before/after are not rewritten; current balance corrected.",
      },
    },
  });
  if (!finalized.ok) {
    invalidateMetricCaches(parsed.userId);
    return {
      success: false,
      error:
        "Adjustments were wiped (recoverable), but the audit record could not be finalized — the wipe is logged as 'pending' for reconciliation. Please notify an administrator.",
    };
  }

  // Refresh the user page AND bust the global metric caches. Deleting the
  // admin_balance_adjustment rows + reducing available_balance changes the
  // balance-adjustments insight surface AND the P&L on-site term, so the
  // cached dashboard / analytics / insights figures must refresh immediately.
  revalidatePath(`/users/${parsed.userId}`);
  invalidateMetricCaches(parsed.userId);
  return {
    success: true,
    deletedCount: guardedRows.length,
    totalRemoved,
    balanceBefore,
    balanceAfter,
  };
}

const restoreSchema = z.object({
  wipeId: z.string().uuid("Invalid wipe id"),
  totpCode: z.string().min(1, "2FA code is required"),
});

/**
 * Restore a wipe batch: re-insert the snapshotted ledger rows back into the
 * main DB and re-add the summed amount to the user's balance. Mirrors
 * /users/deleted restoreDeletedUser. Idempotent-guarded: a batch already
 * marked restored_at cannot be restored again (double-insert / double-credit).
 */
export async function restoreBalanceAdjustmentWipe(
  wipeId: string,
  totpCode: string,
): Promise<{ success: true } | { success: false; error: string }> {
  const session = await gateWipe();

  const parsed = restoreSchema.safeParse({ wipeId, totpCode });
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  try {
    await require2FA(session.userId, parsed.data.totpCode);
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "2FA verification failed" };
  }

  await ensureBalanceAdjustmentWipesSchema();

  const wipe = await adminDb.admin_balance_adjustment_wipes.findUnique({
    where: { id: parsed.data.wipeId },
  });
  if (!wipe) return { success: false, error: "Wipe batch not found" };
  if (wipe.restored_at) {
    return { success: false, error: "This wipe has already been restored" };
  }
  // STATUS GUARD — only a 'completed' batch is safely restorable. A 'failed'
  // row's delete never happened (its ledger rows still exist, so restoring
  // would re-credit money that was never removed); a 'pending' row's audit-
  // finalize is incomplete and needs reconciliation first. 'completed' is the
  // back-compat value for legacy rows, so existing batches restore as before.
  if (wipe.status !== WIPE_STATUS.COMPLETED) {
    return {
      success: false,
      error:
        wipe.status === WIPE_STATUS.FAILED
          ? "This wipe did not complete (the deletion never happened) and cannot be restored."
          : "This wipe is still being finalized (pending) and cannot be restored yet — please reconcile it first.",
    };
  }

  const snapshot = wipe.snapshot as unknown as BalanceAdjustmentWipeSnapshot;
  if (!snapshot || !Array.isArray(snapshot.rows) || !snapshot.userId) {
    return { success: false, error: "Snapshot is malformed — cannot restore" };
  }
  // The EXACT amount the wipe removed from the balance = balance_before −
  // balance_after. This already accounts for the BALANCE RULE (credit-only
  // clawback) AND the ≥0 clamp, so re-adding it is a perfect symmetric
  // restore. NOTE: it is NOT `total_amount` (the SIGNED sum incl. debits) —
  // debits were deleted without changing the balance, so they contribute 0
  // here. A debit-only batch restores 0 to the balance (correct). The signed
  // `total_amount` stays informational for the audit/listing.
  const balanceReAdd = toNumber(wipe.balance_before) - toNumber(wipe.balance_after);
  const totalAmount = toNumber(wipe.total_amount);

  const db = await getDb();

  try {
    await db.$transaction(async (tx) => {
      // Re-insert the rows verbatim. createMany + Unchecked input (scalar
      // columns only) mirrors the deleted-users restore. skipDuplicates
      // makes a partial double-run safe (e.g. retried after a timeout).
      // We strip any column that's undefined; the snapshot is pure JSON.
      const rowsForInsert = snapshot.rows.map((r) => {
        const copy: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(r)) {
          if (v === undefined) continue;
          copy[k] = v;
        }
        return copy;
      });

      await tx.ledger_transactions.createMany({
        data: rowsForInsert as unknown as Prisma.ledger_transactionsCreateManyInput[],
        skipDuplicates: true,
      });

      // Re-add EXACTLY the amount the wipe removed (balance_before −
      // balance_after = the credit-only, clamp-aware reduction), reversing the
      // wipe's balance effect. Optimistic-locked. We do NOT attempt to rewrite
      // the re-inserted rows' historical balance_before/after — they reflect
      // the balance at their ORIGINAL time, same fidelity tradeoff the wipe
      // documented. A debit-only batch re-adds 0 (the balance was never
      // touched by the wipe).
      const b = await tx.balances.findUnique({ where: { user_id: snapshot.userId } });
      if (!b) throw new Error("User balances not found");

      const updated = await tx.balances.updateMany({
        where: { user_id: snapshot.userId, version: b.version },
        data: {
          available_balance: toNumber(b.available_balance) + balanceReAdd,
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) {
        throw new Error("Balance changed concurrently — please retry");
      }
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    if (message === "User balances not found" || message.includes("concurrently")) {
      return { success: false, error: message };
    }
    console.error("[restoreBalanceAdjustmentWipe] transaction failed:", err);
    return { success: false, error: "Restore failed — please try again" };
  }

  // Mark restored so it can't be re-applied.
  await adminDb.admin_balance_adjustment_wipes.update({
    where: { id: parsed.data.wipeId },
    data: { restored_at: new Date(), restored_by: session.userId },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "balance_adjustments_wipe_restored",
    targetUserId: snapshot.userId,
    metadata: {
      wipeId: parsed.data.wipeId,
      restoredCount: snapshot.rows.length,
      totalAmount,
      balanceReAdded: balanceReAdd,
    },
  });

  // Restore re-inserts the adjustment rows + re-adds the balance, so the
  // global metric caches must be busted too — the exact reverse of the wipe.
  revalidatePath(`/users/${snapshot.userId}`);
  invalidateMetricCaches(snapshot.userId);
  return { success: true };
}
