"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { adminDb } from "@/lib/admin-db";
import { requireAdmin } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { require2FA } from "@/lib/require-2fa";
import { toNumber } from "@/lib/utils/decimal";
import type { Prisma } from "@/generated/prisma/client";
import { ensureAccountWipesSchema } from "@/lib/account-wipes/ensure-schema";
import { invalidateMetricCaches } from "@/lib/account-wipes/invalidate-metric-caches";
import {
  WIPE_STATUS,
  finalizeWipeSuccess,
  markWipeFailed,
  resolveRequestIp,
} from "@/lib/account-wipes/finalize";
import {
  accountWipeSnapshotToJsonValue,
  type AccountWipeSnapshot,
  type PnlWipeSnapshot,
} from "@/lib/account-wipes/snapshot";
import {
  WAGER_TYPES,
  GAMING_PAYOUT_TYPES,
  REWARD_PAYOUT_TYPES,
  UPGRADER_LEDGER_TYPES,
  UPGRADER_IN_LEDGER,
  type LedgerTransactionType,
} from "@/lib/metrics/ledger-sets";
import {
  normalizeWipeWindow,
  resolveWipeCutoff,
  type WipeWindowHours,
} from "@/lib/account-wipes/window";

// ---------------------------------------------------------------------------
// WIPE PNL — the WIDEST windowed wipe: removes every PnL-affecting event for
// the user in the selected window (12 / 24 / 48 hours). This is the LARGEST
// of the three windowed wipes (Wager / Game / PnL):
//
//   • Wager wipe — gameplay legs + counters (`total_wagered` + `total_won`).
//   • Game wipe  — gameplay legs + `total_won` only (counter-disjoint from Wager).
//   • PNL WIPE   — gameplay + deposits + rewards + admin balance adjustments +
//                  vouchers in the window. Decrements `total_wagered` /
//                  `total_won` / `total_deposited`.
//
// WITHDRAWAL CARVE-OUT (owner mandate, 2026-06-03): `card_withdrawal` ledger
// legs and the `balances.total_withdrawn` counter are EXCLUDED from this wipe.
// Withdrawals are not part of the PnL wipe scope. The on-ledger
// `card_withdrawal` rows in window are left untouched; `total_withdrawn` is
// never decremented. (Authoritative `card_withdrawal_requests` rows were
// already out of scope — they carry shipping/tracking state.)
//
// SCOPE — derived against `src/lib/queries/pnl.ts`:
//
//   pnl = deposits − withdrawals − onSiteBalance − inventoryValue − unclaimedVouchers
//
// Every term except `withdrawals` moves when we delete its underlying rows:
//   • `deposits`         — `deposit` ledger legs (`ledger_transactions`),
//                          plus the `balances.total_deposited` counter.
//   • `withdrawals`      — NOT TOUCHED. `card_withdrawal` ledger legs are left
//                          intact; `total_withdrawn` is left intact. (Owner
//                          carve-out.)
//   • `onSiteBalance`    — `balances.available_balance` is decremented by the
//                          payout (credit) legs' magnitude. Wager (debit) legs
//                          delete without changing the balance (BALANCE RULE —
//                          never inflate). `locked_balance` (vault) is left
//                          alone (wiping it is the Vault category).
//   • `inventoryValue`   — won pack/battle `user_inventory` rows obtained in
//                          window (+ their `provably_fair_results` children),
//                          EXCLUDING withdrawal-locked cards (active
//                          withdrawal).
//   • `unclaimedVouchers`— `vouchers` rows CREATED in the window.
//
// PLUS:
//   • Reward-payout legs (deposit_bonus, rakeback, race/raffle, etc.) — these
//                          all credited balance, so deleting them lowers the
//                          available_balance by their magnitude (clamped ≥0).
//   • Admin balance adjustments in window — both CREDITS (clawed back) and
//                          DEBITS (record deleted, balance unchanged — same
//                          BALANCE RULE as the adjustments wipe).
//   • upgrader_games rows in window (raw SQL, table-presence-guarded).
//
// EXCLUDED (intentionally — protect referential integrity):
//   • `card_withdrawal` ledger legs — owner carve-out, see above.
//   • `card_withdrawal_requests` table rows — they carry shipping / crypto /
//                          tracking / fireblocks state and multiple admin FKs.
//                          Deleting them is the disabled `withdrawals`
//                          category's territory.
//   • Affiliate / creator-deal ledger legs (per protected.ts: deposit /
//     card_withdrawal / affiliate_claim / creator_fill_* / etc. are protected
//     for ever-creators). For non-creators these are NOT in WAGER /
//     GAMING_PAYOUT / REWARD / our deposit set, so they are STRUCTURALLY
//     excluded from the delete filter, EXCEPT `deposit` which IS in scope
//     here intentionally.
//   • `voucher_redeemed` ledger legs — those are NEUTRAL inventory/voucher
//     conversions that don't move PnL; deleting the voucher row IS the
//     authoritative change.
//
// CREATOR-PROTECTED — NOT YET. Owner mandate (per categories.ts): deposits are
// creator-protected. The PnL wipe is a SUPERSET of those, so it inherits
// creator protection: if the user IS or WAS a creator, the PnL wipe is
// hard-rejected server-side (`creatorProtected: true` in categories.ts). For
// a never-creator the full scope runs.
//
// CONCURRENCY — same Pattern A (FOR UPDATE) + Pattern B (atomic GREATEST
// clamp) as Wager / Game. NO optimistic version check.
//
// ORDERING — snapshot-first. Snapshot write failure → abort.
// ---------------------------------------------------------------------------

/**
 * Build the PnL-wipe deletable ledger set. INCLUDES wager + gaming-payout +
 * reward + admin adjustment + deposit — every type that directly moves a PnL
 * term that the wipe touches. `card_withdrawal` is EXCLUDED (owner carve-out
 * 2026-06-03). Upgrader ledger legs only included when `UPGRADER_IN_LEDGER`
 * is on (mirrors the Wager wipe's enum-hygiene fix).
 */
const PNL_WIPE_LEDGER_TYPES: readonly LedgerTransactionType[] = [
  // Wager + gaming payouts.
  ...WAGER_TYPES,
  ...GAMING_PAYOUT_TYPES,
  ...(UPGRADER_IN_LEDGER ? UPGRADER_LEDGER_TYPES : []),
  // Reward-payouts (deposit_bonus, rakeback_claim, race_prize, rain_win, etc.).
  ...REWARD_PAYOUT_TYPES,
  // Admin balance adjustments (both credits + debits in window).
  "admin_balance_adjustment",
  // Real cash flows IN (deposits). Withdrawals are intentionally EXCLUDED.
  "deposit",
];

const PNL_WIPE_TYPE_SET: ReadonlySet<string> = new Set(PNL_WIPE_LEDGER_TYPES);

/** Won-inventory sources the wipe deletes. */
const WON_INVENTORY_SOURCES = ["pack", "battle"] as const;

// BALANCE RULE (documented below per-leg, not via a single set):
//   • Credit legs (deposit, payout legs, reward legs, positive
//     admin_balance_adjustment) → clawed back from available_balance.
//   • Debit legs (wager, negative admin_balance_adjustment) → record deleted,
//     balance unchanged (never inflate).
// `card_withdrawal` legs are NOT in the wipe scope (owner carve-out, 2026-06-03)
// so they never enter this rule either way.
// Implemented per-row at the reduction-computation site below — the type-set
// abstraction was removed (unused) when the per-row split was inlined.

const MAX_PNL_ROWS = 200_000;
const WIPE_STATEMENT_TIMEOUT_MS = 180_000;
const WIPE_TX_OPTIONS = {
  timeout: WIPE_STATEMENT_TIMEOUT_MS + 15_000,
  maxWait: 15_000,
} as const;

async function gateWipe() {
  const session = await requireAdmin();
  await requireCapability(session, "__can_wipe_accounts", "wipe PnL");
  return session;
}

const userIdSchema = z.string().min(1, "User id is required");

// ───────────────────────────────────────────────────────────────────────────
// Preview — lazy, read-only.
// ───────────────────────────────────────────────────────────────────────────

export type PnlWipePreview = {
  /** Total PnL-affecting ledger legs in window. */
  ledgerLegCount: number;
  /** Σ |credit legs| — the amount that will be clawed from available_balance. */
  balanceClawback: number;
  /** Σ deposit ledger magnitudes in window. */
  depositSum: number;
  /** Σ wager-leg magnitudes (for total_wagered decrement). */
  wagerSum: number;
  /** Σ payout-leg magnitudes (for total_won decrement; inventory added separately). */
  payoutSum: number;
  /** Σ reward-payout magnitudes (for the balance clawback). */
  rewardSum: number;
  /** Won pack/battle inventory row count in window. */
  inventoryCount: number;
  /** Σ value_at_obtained of those inventory rows. */
  inventoryValue: number;
  /** Won cards skipped because withdrawal-locked. */
  withdrawalLockedSkipped: number;
  /** Vouchers created in window. */
  voucherCount: number;
  /** Σ value of those vouchers. */
  voucherValue: number;
  /** Upgrader games in window (0 when the table is absent). */
  upgraderGameCount: number;
  upgraderTablePresent: boolean;
  windowHours: WipeWindowHours;
  cutoff: string;
};

type RegclassRow = { exists: string | null };
type UpgraderAggRow = { cnt: bigint | number | null };

async function upgraderGamesPresent(db: Awaited<ReturnType<typeof getDb>>): Promise<boolean> {
  try {
    const rows = await db.$queryRawUnsafe<RegclassRow[]>(
      `SELECT to_regclass('public.upgrader_games')::text AS exists`,
    );
    return Boolean(rows?.[0]?.exists);
  } catch {
    return false;
  }
}

export async function previewPnlWipe(
  userId: string,
  sinceHours: WipeWindowHours = 24,
): Promise<{ success: true; preview: PnlWipePreview } | { success: false; error: string }> {
  await gateWipe();
  const parsed = userIdSchema.safeParse(userId);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid user id" };
  }
  const db = await getDb();

  const windowHours = normalizeWipeWindow(sinceHours);
  const cutoff = resolveWipeCutoff(windowHours);

  // GroupBy on type for the legs aggregate.
  const ledgerGrouped = await db.ledger_transactions.groupBy({
    by: ["type"],
    where: {
      user_id: parsed.data,
      type: { in: PNL_WIPE_LEDGER_TYPES as unknown as LedgerTransactionType[] },
      created_at: { gte: cutoff },
    },
    _count: { _all: true },
    _sum: { amount: true },
  });

  // For admin_balance_adjustment we need the CREDIT/DEBIT split separately
  // (credits claw back, debits don't). Read the in-window adjustments rows
  // separately.
  const adjRows = await db.ledger_transactions.findMany({
    where: {
      user_id: parsed.data,
      type: "admin_balance_adjustment",
      created_at: { gte: cutoff },
    },
    select: { amount: true },
  });
  const adjCreditClawback = adjRows.reduce(
    (acc, r) => (toNumber(r.amount) > 0 ? acc + toNumber(r.amount) : acc),
    0,
  );

  let ledgerLegCount = 0;
  let depositSum = 0;
  let wagerSum = 0;
  let payoutSum = 0;
  let rewardSum = 0;
  let creditFromTypedLegs = 0;
  const REWARD_SET = new Set<string>(REWARD_PAYOUT_TYPES);
  const WAGER_SET = new Set<string>(WAGER_TYPES);
  const PAYOUT_SET = new Set<string>([
    ...GAMING_PAYOUT_TYPES,
    ...(UPGRADER_IN_LEDGER ? ["upgrader_payout"] : []),
  ]);
  for (const g of ledgerGrouped) {
    const count = g._count._all;
    const t = String(g.type);
    ledgerLegCount += count;
    const mag = Math.abs(toNumber(g._sum.amount));
    if (t === "deposit") {
      depositSum += mag;
      creditFromTypedLegs += mag;
    } else if (WAGER_SET.has(t)) {
      wagerSum += mag;
    } else if (PAYOUT_SET.has(t)) {
      payoutSum += mag;
      creditFromTypedLegs += mag;
    } else if (REWARD_SET.has(t)) {
      rewardSum += mag;
      creditFromTypedLegs += mag;
    }
    // Note: card_withdrawal is no longer in PNL_WIPE_LEDGER_TYPES (owner
    // carve-out, 2026-06-03), so it never appears in this group.
  }
  // upgrader_bet: when UPGRADER_IN_LEDGER, it's in WAGER_SET? No — only
  // WAGER_TYPES (pack_opening, battle_bet, battle_sponsorship). upgrader_bet
  // is a debit but not in WAGER_TYPES. Track it separately as a debit (NOT
  // adding to balance clawback, NOT to wagerSum either — it's NOT in
  // total_wagered conceptually unless production writes it that way).

  // Inventory in window.
  const [invAgg, lockedAgg] = await Promise.all([
    db.user_inventory.aggregate({
      where: {
        user_id: parsed.data,
        source_type: { in: WON_INVENTORY_SOURCES as unknown as ("pack" | "battle")[] },
        withdrawal_locked_at: null,
        obtained_at: { gte: cutoff },
      },
      _count: { _all: true },
      _sum: { value_at_obtained: true },
    }),
    db.user_inventory.count({
      where: {
        user_id: parsed.data,
        source_type: { in: WON_INVENTORY_SOURCES as unknown as ("pack" | "battle")[] },
        withdrawal_locked_at: { not: null },
        obtained_at: { gte: cutoff },
      },
    }),
  ]);

  // Vouchers created in window.
  const voucherAgg = await db.vouchers.aggregate({
    where: { user_id: parsed.data, created_at: { gte: cutoff } },
    _count: { _all: true },
    _sum: { value: true },
  });

  // Upgrader games count in window.
  let upgraderGameCount = 0;
  const upgraderTablePresent = await upgraderGamesPresent(db);
  if (upgraderTablePresent) {
    try {
      const rows = await db.$queryRawUnsafe<UpgraderAggRow[]>(
        `SELECT COUNT(*)::text AS cnt
         FROM upgrader_games WHERE user_id = $1 AND created_at >= $2`,
        parsed.data,
        cutoff,
      );
      const r = rows?.[0];
      upgraderGameCount = r ? Number(r.cnt ?? 0) : 0;
    } catch (err) {
      console.error("[previewPnlWipe] upgrader_games read failed:", err);
    }
  }

  return {
    success: true,
    preview: {
      ledgerLegCount,
      balanceClawback: creditFromTypedLegs + adjCreditClawback,
      depositSum,
      wagerSum,
      payoutSum,
      rewardSum,
      inventoryCount: invAgg._count._all,
      inventoryValue: toNumber(invAgg._sum.value_at_obtained),
      withdrawalLockedSkipped: lockedAgg,
      voucherCount: voucherAgg._count._all,
      voucherValue: toNumber(voucherAgg._sum.value),
      upgraderGameCount,
      upgraderTablePresent,
      windowHours,
      cutoff: cutoff.toISOString(),
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// WIPE — snapshot the broadest possible PnL-affecting set in window, delete
// FK-safe, claw credit legs out of balance, decrement all four lifetime
// counters (wagered/won/deposited/withdrawn) by what we removed.
// ───────────────────────────────────────────────────────────────────────────

const wipePnlSchema = z.object({
  userId: z.string().min(1, "User id is required"),
  totpCode: z.string().min(1, "2FA code is required"),
  windowHours: z.union([z.literal(12), z.literal(24), z.literal(48)]),
});

export async function wipePnl(data: {
  userId: string;
  totpCode: string;
  windowHours: WipeWindowHours;
}): Promise<
  | {
      success: true;
      ledgerLegsDeleted: number;
      inventoryDeleted: number;
      provablyFairDeleted: number;
      upgraderGamesDeleted: number;
      vouchersDeleted: number;
      withdrawalLockedSkipped: number;
      balanceReduced: number;
      windowHours: WipeWindowHours;
    }
  | { success: false; error: string }
> {
  const session = await gateWipe();

  const parseResult = wipePnlSchema.safeParse(data);
  if (!parseResult.success) {
    return { success: false, error: parseResult.error.issues[0]?.message ?? "Invalid input" };
  }
  const parsed = parseResult.data;

  try {
    await require2FA(session.userId, parsed.totpCode);
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "2FA verification failed" };
  }

  try {
    await ensureAccountWipesSchema();
  } catch (err) {
    console.error("[wipePnl] ensure-schema failed:", err);
    return {
      success: false,
      error: "Could not prepare the recovery store — wipe aborted (nothing deleted)",
    };
  }

  const db = await getDb();

  const windowHours = normalizeWipeWindow(parsed.windowHours);
  const cutoff = resolveWipeCutoff(windowHours);

  // Read everything up front so the snapshot is exact.
  const ledgerRows = await db.ledger_transactions.findMany({
    where: {
      user_id: parsed.userId,
      type: { in: PNL_WIPE_LEDGER_TYPES as unknown as LedgerTransactionType[] },
      created_at: { gte: cutoff },
    },
    take: MAX_PNL_ROWS + 1,
  });
  if (ledgerRows.length > MAX_PNL_ROWS) {
    return {
      success: false,
      error: `PnL history too large to snapshot safely (> ${MAX_PNL_ROWS.toLocaleString()} ledger rows in window) — wipe aborted; pick a shorter window`,
    };
  }

  const inventoryRows = await db.user_inventory.findMany({
    where: {
      user_id: parsed.userId,
      source_type: { in: WON_INVENTORY_SOURCES as unknown as ("pack" | "battle")[] },
      withdrawal_locked_at: null,
      obtained_at: { gte: cutoff },
    },
    take: MAX_PNL_ROWS + 1,
  });
  if (inventoryRows.length > MAX_PNL_ROWS) {
    return {
      success: false,
      error: `PnL inventory history too large to snapshot safely (> ${MAX_PNL_ROWS.toLocaleString()} rows in window) — wipe aborted`,
    };
  }
  const withdrawalLockedSkipped = await db.user_inventory.count({
    where: {
      user_id: parsed.userId,
      source_type: { in: WON_INVENTORY_SOURCES as unknown as ("pack" | "battle")[] },
      withdrawal_locked_at: { not: null },
      obtained_at: { gte: cutoff },
    },
  });

  const voucherRows = await db.vouchers.findMany({
    where: { user_id: parsed.userId, created_at: { gte: cutoff } },
    take: MAX_PNL_ROWS + 1,
  });
  if (voucherRows.length > MAX_PNL_ROWS) {
    return {
      success: false,
      error: `Voucher history too large to snapshot safely — wipe aborted`,
    };
  }

  // Defence-in-depth re-guard.
  for (const row of ledgerRows) {
    if (row.user_id !== parsed.userId || !PNL_WIPE_TYPE_SET.has(String(row.type))) {
      return {
        success: false,
        error: "A selected PnL ledger row failed the ownership/type check — wipe aborted (nothing deleted)",
      };
    }
  }
  for (const row of inventoryRows) {
    if (
      row.user_id !== parsed.userId ||
      !(WON_INVENTORY_SOURCES as readonly string[]).includes(String(row.source_type)) ||
      row.withdrawal_locked_at !== null
    ) {
      return {
        success: false,
        error: "A selected inventory row failed the ownership/source check — wipe aborted (nothing deleted)",
      };
    }
  }
  for (const row of voucherRows) {
    if (row.user_id !== parsed.userId) {
      return {
        success: false,
        error: "A selected voucher row failed the ownership check — wipe aborted (nothing deleted)",
      };
    }
  }

  const ledgerIds = ledgerRows.map((r) => r.id);
  const inventoryIds = inventoryRows.map((r) => r.id);
  const voucherIds = voucherRows.map((r) => r.id);

  const provablyFairRows =
    inventoryIds.length > 0
      ? await db.provably_fair_results.findMany({
          where: { inventory_item_id: { in: inventoryIds } },
          take: MAX_PNL_ROWS + 1,
        })
      : [];
  if (provablyFairRows.length > MAX_PNL_ROWS) {
    return {
      success: false,
      error: `PnL provably-fair history too large to snapshot safely — wipe aborted`,
    };
  }

  const upgraderTablePresent = await upgraderGamesPresent(db);
  let upgraderGameRows: Array<Record<string, unknown>> = [];
  if (upgraderTablePresent) {
    try {
      upgraderGameRows = await db.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT * FROM upgrader_games WHERE user_id = $1 AND created_at >= $2 LIMIT ${MAX_PNL_ROWS + 1}`,
        parsed.userId,
        cutoff,
      );
    } catch (err) {
      console.error("[wipePnl] upgrader_games read failed — aborting (nothing deleted):", err);
      return {
        success: false,
        error: "Could not read the user's upgrader games — wipe aborted (nothing deleted)",
      };
    }
    if (upgraderGameRows.length > MAX_PNL_ROWS) {
      return {
        success: false,
        error: `Upgrader history too large to snapshot safely — wipe aborted`,
      };
    }
  }

  if (
    ledgerRows.length === 0 &&
    inventoryRows.length === 0 &&
    voucherRows.length === 0 &&
    upgraderGameRows.length === 0
  ) {
    return { success: false, error: "This user has no PnL-affecting data to wipe in the selected window" };
  }

  // Compute the per-counter / balance reductions from the snapshotted rows.
  const REWARD_SET = new Set<string>(REWARD_PAYOUT_TYPES);
  const WAGER_SET = new Set<string>(WAGER_TYPES);
  const PAYOUT_SET = new Set<string>([
    ...GAMING_PAYOUT_TYPES,
    ...(UPGRADER_IN_LEDGER ? ["upgrader_payout"] : []),
  ]);

  let depositSum = 0;
  let wagerMagnitude = 0;
  let payoutMagnitude = 0;
  let rewardMagnitude = 0;
  let adjCreditClawback = 0;
  for (const r of ledgerRows) {
    const t = String(r.type);
    const mag = Math.abs(toNumber(r.amount));
    if (t === "deposit") depositSum += mag;
    else if (WAGER_SET.has(t)) wagerMagnitude += mag;
    else if (PAYOUT_SET.has(t)) payoutMagnitude += mag;
    else if (REWARD_SET.has(t)) rewardMagnitude += mag;
    else if (t === "admin_balance_adjustment") {
      const signed = toNumber(r.amount);
      if (signed > 0) adjCreditClawback += signed;
    }
    // card_withdrawal is no longer in scope (owner carve-out, 2026-06-03).
  }

  const inventoryValue = inventoryRows.reduce((acc, r) => acc + toNumber(r.value_at_obtained), 0);
  const voucherValueSum = voucherRows.reduce((acc, r) => acc + toNumber(r.value), 0);
  // Total credit clawback = every credit leg (deposit + payout + reward) +
  // the adjustments' credit clawback. Voucher delete does NOT change
  // available_balance (vouchers are their own pool); inventory delete does
  // not change available_balance either (it changes inventoryValue).
  const availableBalanceClawback =
    depositSum + payoutMagnitude + rewardMagnitude + adjCreditClawback;

  // Counter reductions (clamp against live row inside the atomic UPDATE).
  const balanceRow = await db.balances
    .findUnique({ where: { user_id: parsed.userId } })
    .catch(() => null);
  if (!balanceRow) return { success: false, error: "User balances not found" };

  const totalWageredBefore = toNumber(balanceRow.total_wagered);
  const totalWonBefore = toNumber(balanceRow.total_won);
  const totalDepositedBefore = toNumber(balanceRow.total_deposited);
  const balanceBefore = toNumber(balanceRow.available_balance);
  const balanceAfter = Math.max(0, balanceBefore - availableBalanceClawback);
  const balanceReduction = balanceBefore - balanceAfter;

  const wonDeleted = payoutMagnitude + inventoryValue;
  const totalWageredReduction = Math.min(wagerMagnitude, totalWageredBefore);
  const totalWonReduction = Math.min(wonDeleted, totalWonBefore);
  const totalDepositedReduction = Math.min(depositSum, totalDepositedBefore);
  // total_withdrawn is NOT decremented (owner carve-out, 2026-06-03). Kept at
  // 0 in the snapshot so restore re-adds 0 (no-op) — preserves the symmetric
  // snapshot shape required by PnlWipeSnapshot.
  const totalWithdrawnReduction = 0;

  const userMeta = await db.user
    .findUnique({ where: { id: parsed.userId }, select: { username: true, email: true } })
    .catch(() => null);

  // SNAPSHOT FIRST.
  const snapshot: AccountWipeSnapshot = {
    type: "pnl",
    userId: parsed.userId,
    ledgerRows: ledgerRows as unknown as Array<Record<string, unknown>>,
    inventoryRows: inventoryRows as unknown as Array<Record<string, unknown>>,
    provablyFairRows: provablyFairRows as unknown as Array<Record<string, unknown>>,
    upgraderGameRows,
    voucherRows: voucherRows as unknown as Array<Record<string, unknown>>,
    availableBalanceReduction: balanceReduction.toFixed(2),
    totalWageredReduction: totalWageredReduction.toFixed(2),
    totalWonReduction: totalWonReduction.toFixed(2),
    totalDepositedReduction: totalDepositedReduction.toFixed(2),
    totalWithdrawnReduction: totalWithdrawnReduction.toFixed(2),
    windowHours,
    windowCutoff: cutoff.toISOString(),
  } satisfies { type: "pnl" } & PnlWipeSnapshot;

  let wipeId: string;
  try {
    const created = await adminDb.admin_account_wipes.create({
      data: {
        wipe_type: "pnl",
        user_id: parsed.userId,
        username: userMeta?.username ?? null,
        email: userMeta?.email ?? null,
        wiped_by: session.userId,
        amount: balanceReduction,
        item_count:
          ledgerRows.length +
          inventoryRows.length +
          provablyFairRows.length +
          upgraderGameRows.length +
          voucherRows.length,
        status: WIPE_STATUS.PENDING,
        snapshot: accountWipeSnapshotToJsonValue(snapshot) as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    wipeId = created.id;
  } catch (snapErr) {
    console.error("[wipePnl] snapshot write failed — wipe aborted (nothing deleted):", snapErr);
    return {
      success: false,
      error: "Could not write the recovery snapshot — wipe aborted (nothing deleted)",
    };
  }

  // DESTRUCTIVE — one main-DB tx, children-first, FK-safe.
  let provablyFairDeleted = 0;
  let upgraderGamesDeleted = 0;
  let vouchersDeleted = 0;
  try {
    await db.$transaction(async (tx) => {
      // (0a) PATTERN A — FOR UPDATE row lock.
      await tx.$executeRaw`SELECT id FROM "balances" WHERE user_id = ${parsed.userId} FOR UPDATE`;

      // (0b) Raise per-statement timeout.
      await tx.$executeRawUnsafe(
        `SET LOCAL statement_timeout = ${WIPE_STATEMENT_TIMEOUT_MS}`,
      );

      // (1) Break ledger↔session FK cycle for any deleted leg.
      if (ledgerIds.length > 0) {
        await tx.game_sessions.updateMany({
          where: { bet_ledger_tx_id: { in: ledgerIds } },
          data: { bet_ledger_tx_id: null },
        });
        await tx.balances.updateMany({
          where: { user_id: parsed.userId, last_transaction_id: { in: ledgerIds } },
          data: { last_transaction_id: null },
        });
      }

      // (2) Provably_fair_results children of the inventory being deleted.
      if (inventoryIds.length > 0) {
        const pfDel = await tx.provably_fair_results.deleteMany({
          where: { inventory_item_id: { in: inventoryIds } },
        });
        provablyFairDeleted = pfDel.count;
      }

      // (3) Delete the wide PnL ledger set (re-scoped).
      if (ledgerIds.length > 0) {
        const legDel = await tx.ledger_transactions.deleteMany({
          where: {
            id: { in: ledgerIds },
            user_id: parsed.userId,
            type: { in: PNL_WIPE_LEDGER_TYPES as unknown as LedgerTransactionType[] },
            created_at: { gte: cutoff },
          },
        });
        if (legDel.count !== ledgerIds.length) {
          throw new Error("PNL_GUARD: PnL ledger legs changed concurrently — refresh and retry");
        }
      }

      // (4) Delete the won pack/battle inventory rows.
      if (inventoryIds.length > 0) {
        const invDel = await tx.user_inventory.deleteMany({
          where: {
            id: { in: inventoryIds },
            user_id: parsed.userId,
            source_type: { in: WON_INVENTORY_SOURCES as unknown as ("pack" | "battle")[] },
            withdrawal_locked_at: null,
            obtained_at: { gte: cutoff },
          },
        });
        if (invDel.count !== inventoryIds.length) {
          throw new Error("PNL_GUARD: inventory changed concurrently — refresh and retry");
        }
      }

      // (5) Delete upgrader_games rows.
      if (upgraderGameRows.length > 0) {
        const deleted = await tx.$executeRawUnsafe(
          `DELETE FROM upgrader_games WHERE user_id = $1 AND created_at >= $2`,
          parsed.userId,
          cutoff,
        );
        upgraderGamesDeleted = typeof deleted === "number" ? deleted : upgraderGameRows.length;
      }

      // (6) Delete vouchers created in window.
      if (voucherIds.length > 0) {
        const vDel = await tx.vouchers.deleteMany({
          where: {
            id: { in: voucherIds },
            user_id: parsed.userId,
            created_at: { gte: cutoff },
          },
        });
        vouchersDeleted = vDel.count;
        if (vDel.count !== voucherIds.length) {
          throw new Error("PNL_GUARD: vouchers changed concurrently — refresh and retry");
        }
      }

      // (7) PATTERN B — atomic clamped UPDATE for the balance + the three
      // lifetime counters we touch. ONE raw SQL UPDATE; GREATEST(0, …) clamps
      // each independently. NO optimistic version check. `total_withdrawn`
      // is NOT in this UPDATE (owner carve-out 2026-06-03 — withdrawals are
      // not part of the PnL wipe scope).
      if (
        balanceReduction > 0 ||
        totalWageredReduction > 0 ||
        totalWonReduction > 0 ||
        totalDepositedReduction > 0
      ) {
        const updated = await tx.$executeRaw`
          UPDATE "balances"
          SET available_balance = GREATEST(0::numeric, available_balance - ${balanceReduction}::numeric),
              total_wagered = GREATEST(0::numeric, total_wagered - ${totalWageredReduction}::numeric),
              total_won = GREATEST(0::numeric, total_won - ${totalWonReduction}::numeric),
              total_deposited = GREATEST(0::numeric, total_deposited - ${totalDepositedReduction}::numeric),
              version = version + 1
          WHERE user_id = ${parsed.userId}
        `;
        if (updated !== 1) {
          throw new Error("PNL_GUARD: user balances row not found — wipe aborted");
        }
      }
    }, WIPE_TX_OPTIONS);
  } catch (err) {
    await markWipeFailed("account", wipeId);
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(
      "[wipePnl] delete transaction failed for user",
      parsed.userId,
      "— wipeId",
      wipeId,
      ":",
      err,
    );
    if (message.startsWith("PNL_GUARD:")) {
      return { success: false, error: message.replace(/^PNL_GUARD:\s*/, "") };
    }
    if (/statement timeout|57014|canceling statement due to/i.test(message)) {
      return {
        success: false,
        error:
          "Wipe timed out — this account's PnL history is unusually large for the selected window. Nothing was deleted (the data is safe). Please pick a shorter window or notify an administrator.",
      };
    }
    return { success: false, error: "Wipe failed — please try again (nothing deleted)" };
  }

  const finalized = await finalizeWipeSuccess({
    store: "account",
    wipeId,
    audit: {
      adminUserId: session.userId,
      eventType: "user_wipe_pnl",
      targetUserId: parsed.userId,
      ip: await resolveRequestIp(),
      metadata: {
        wipeId,
        wipe_type: "pnl",
        admin_user_id: session.userId,
        target_user_id: parsed.userId,
        window_hours: windowHours,
        cutoff_iso: cutoff.toISOString(),
        snapshot_id: wipeId,
        deleted_count:
          ledgerRows.length +
          inventoryRows.length +
          provablyFairDeleted +
          upgraderGamesDeleted +
          vouchersDeleted,
        success: true,
        ledgerLegsDeleted: ledgerRows.length,
        depositSum,
        wagerMagnitude,
        payoutMagnitude,
        rewardMagnitude,
        adjCreditClawback,
        inventoryDeleted: inventoryRows.length,
        inventoryValue,
        provablyFairDeleted,
        upgraderGamesDeleted,
        upgraderTablePresent,
        vouchersDeleted,
        voucherValueSum,
        withdrawalLockedSkipped,
        balanceBefore,
        balanceAfter,
        balanceReduced: balanceReduction,
        totalWageredBefore,
        totalWageredReduced: totalWageredReduction,
        totalWonBefore,
        totalWonReduced: totalWonReduction,
        totalDepositedBefore,
        totalDepositedReduced: totalDepositedReduction,
        recoverable: true,
        note: `PnL wipe (${windowHours}h window): deleted every PnL-affecting event in window — deposits, wager + payout legs (pack/battle/upgrader) + won pack/battle inventory + provably_fair_results + upgrader_games, reward-payout legs, in-window admin balance adjustments (credits clawed back, debits delete record only), vouchers created in window. Decremented total_wagered / total_won / total_deposited by the deleted sums (each clamped ≥0 via atomic UPDATE). available_balance reduced ONLY by credit legs' magnitude (deposits + payouts + rewards + adj credits) clamped ≥0; wager / debit-adjustments left balance unchanged. WITHDRAWALS CARVE-OUT (owner mandate 2026-06-03): card_withdrawal ledger legs are NOT in scope and total_withdrawn is NOT decremented; card_withdrawal_requests was already untouched. Restore re-inserts all snapshotted rows + re-adds the recorded reductions (symmetric).`,
      },
    },
  });
  if (!finalized.ok) {
    invalidateMetricCaches(parsed.userId);
    return {
      success: false,
      error:
        "PnL was wiped (recoverable), but the audit record could not be finalized — the wipe is logged as 'pending' for reconciliation. Please notify an administrator.",
    };
  }

  revalidatePath(`/users/${parsed.userId}`);
  invalidateMetricCaches(parsed.userId);
  return {
    success: true,
    ledgerLegsDeleted: ledgerRows.length,
    inventoryDeleted: inventoryRows.length,
    provablyFairDeleted,
    upgraderGamesDeleted,
    vouchersDeleted,
    withdrawalLockedSkipped,
    balanceReduced: balanceReduction,
    windowHours,
  };
}
