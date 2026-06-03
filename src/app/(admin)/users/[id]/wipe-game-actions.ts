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
  type GameWipeSnapshot,
} from "@/lib/account-wipes/snapshot";
import {
  WAGER_TYPES,
  GAMING_PAYOUT_TYPES,
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
// WIPE GAME — the WINDOWED gameplay-only wipe. Sits alongside the existing
// Wager / gameplay wipe (`wipe-wager-actions.ts`) and shares its row scope, but
// is COUNTER-DISJOINT:
//
//   • Wager wipe decrements `balances.total_wagered` AND `balances.total_won`.
//   • GAME WIPE decrements ONLY `balances.total_won` (the gaming payouts the
//     user "won"). `balances.total_wagered` is LEFT as bookkeeping — so the
//     two wipes can be run independently for the same window without one
//     undoing the other's counter math (a subsequent Wager wipe over the
//     same window would still drop `total_wagered` even though the rows
//     are already gone).
//
// This is the "Game wipe" half of the critical-incident sweep (2026-06-03).
// It is the SMALLER of the three windowed wipes: pure gameplay events only.
// Pnl wipe is the LARGEST (every PnL-affecting leg in the window).
//
// CONCURRENCY (defence in depth — kills the prior "Balance changed
// concurrently — please retry" failure path on heavy/active accounts):
//   • Pattern A — `SELECT … FOR UPDATE` row lock on `balances` at the START
//                 of the destructive tx, so concurrent gameplay writes block
//                 instead of bumping the row's `version` mid-flight.
//   • Pattern B — atomic clamped raw SQL UPDATE
//                 (`SET total = GREATEST(0, total − $reduction)`), so the
//                 column value is computed from the LIVE row inside the
//                 same tx; no optimistic version check that can lose a race.
//
// ORDERING (CRITICAL, snapshot-first): the full recovery snapshot (rows +
// the exact counter / balance reductions) is written to the admin DB and
// confirmed BEFORE the destructive main-DB tx. Snapshot write failure →
// abort (nothing deleted).
//
// GATING: requireAdmin + __can_wipe_accounts + 2FA. NOT creator-protected
// (gameplay is the user's own activity).
//
// WINDOW: always BOUNDED (12 / 24 / 48 hours). Unlike the Wager wipe, there
// is no "All" sentinel — the windowed wipes are designed to be repeatable per
// window, not "wipe everything in one shot". Out-of-window rows survive and
// are independently wipeable via a subsequent windowed run.
// ---------------------------------------------------------------------------

/**
 * The ledger types the Game wipe deletes: WAGER + GAMING_PAYOUT, plus the
 * upgrader ledger legs IFF `UPGRADER_IN_LEDGER` is true. STRUCTURALLY
 * IDENTICAL to the Wager wipe's set — the two wipes differ at the COUNTER
 * layer (see file header), not at the row layer.
 */
const GAME_WIPE_LEDGER_TYPES: readonly LedgerTransactionType[] = [
  ...WAGER_TYPES,
  ...GAMING_PAYOUT_TYPES,
  ...(UPGRADER_IN_LEDGER ? UPGRADER_LEDGER_TYPES : []),
];

const GAME_WIPE_TYPE_SET: ReadonlySet<string> = new Set(GAME_WIPE_LEDGER_TYPES);

/**
 * The PAYOUT (credit) legs within the set — deleting these claws money back
 * out of the balance. Everything else in the set is a WAGER (debit) leg whose
 * balance effect is left in place (BALANCE RULE — never inflate).
 */
const GAME_WIPE_PAYOUT_TYPE_SET: ReadonlySet<string> = new Set<string>([
  ...GAMING_PAYOUT_TYPES,
  "upgrader_payout",
]);

/** Won-inventory sources the wipe deletes (the GGR-valued gameplay wins). */
const WON_INVENTORY_SOURCES = ["pack", "battle"] as const;

const MAX_GAME_ROWS = 100_000;
const WIPE_STATEMENT_TIMEOUT_MS = 180_000;
const WIPE_TX_OPTIONS = {
  timeout: WIPE_STATEMENT_TIMEOUT_MS + 15_000,
  maxWait: 15_000,
} as const;

async function gateWipe() {
  const session = await requireAdmin();
  await requireCapability(session, "__can_wipe_accounts", "wipe game / gameplay");
  return session;
}

const userIdSchema = z.string().min(1, "User id is required");

// ───────────────────────────────────────────────────────────────────────────
// Preview — lazy, read-only. Same shape as the Wager preview minus the "All"
// sentinel (Game wipe is always bounded — 12 / 24 / 48h).
// ───────────────────────────────────────────────────────────────────────────

export type GameWipePreview = {
  ledgerLegCount: number;
  wagerTotal: number;
  payoutTotal: number;
  inventoryCount: number;
  inventoryValue: number;
  withdrawalLockedSkipped: number;
  upgraderGameCount: number;
  upgraderBet: number;
  upgraderWon: number;
  upgraderTablePresent: boolean;
  windowHours: WipeWindowHours;
  cutoff: string;
};

type RegclassRow = { exists: string | null };
type UpgraderAggRow = { cnt: bigint | number | null; bet: string | null; won: string | null };

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

export async function previewGameWipe(
  userId: string,
  sinceHours: WipeWindowHours = 24,
): Promise<{ success: true; preview: GameWipePreview } | { success: false; error: string }> {
  await gateWipe();
  const parsed = userIdSchema.safeParse(userId);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid user id" };
  }
  const db = await getDb();

  const windowHours = normalizeWipeWindow(sinceHours);
  const cutoff = resolveWipeCutoff(windowHours);

  const ledgerGrouped = await db.ledger_transactions.groupBy({
    by: ["type"],
    where: {
      user_id: parsed.data,
      type: { in: GAME_WIPE_LEDGER_TYPES as unknown as LedgerTransactionType[] },
      created_at: { gte: cutoff },
    },
    _count: { _all: true },
    _sum: { amount: true },
  });

  let ledgerLegCount = 0;
  let wagerTotal = 0;
  let payoutTotal = 0;
  for (const g of ledgerGrouped) {
    const count = g._count._all;
    const magnitude = Math.abs(toNumber(g._sum.amount));
    ledgerLegCount += count;
    if (GAME_WIPE_PAYOUT_TYPE_SET.has(String(g.type))) payoutTotal += magnitude;
    else wagerTotal += magnitude;
  }

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

  let upgraderGameCount = 0;
  let upgraderBet = 0;
  let upgraderWon = 0;
  const upgraderTablePresent = await upgraderGamesPresent(db);
  if (upgraderTablePresent) {
    try {
      const rows = await db.$queryRawUnsafe<UpgraderAggRow[]>(
        `SELECT COUNT(*)::text AS cnt,
                COALESCE(SUM(bet_amount), 0)::text AS bet,
                COALESCE(SUM(won_amount), 0)::text AS won
         FROM upgrader_games WHERE user_id = $1 AND created_at >= $2`,
        parsed.data,
        cutoff,
      );
      const r = rows?.[0];
      upgraderGameCount = r ? Number(r.cnt ?? 0) : 0;
      upgraderBet = r ? toNumber(r.bet) : 0;
      upgraderWon = r ? toNumber(r.won) : 0;
    } catch (err) {
      console.error("[previewGameWipe] upgrader_games read failed:", err);
    }
  }

  return {
    success: true,
    preview: {
      ledgerLegCount,
      wagerTotal,
      payoutTotal,
      inventoryCount: invAgg._count._all,
      inventoryValue: toNumber(invAgg._sum.value_at_obtained),
      withdrawalLockedSkipped: lockedAgg,
      upgraderGameCount,
      upgraderBet,
      upgraderWon,
      upgraderTablePresent,
      windowHours,
      cutoff: cutoff.toISOString(),
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// WIPE — snapshot everything, delete FK-safe, claw payout legs out of balance.
// Decrements ONLY `balances.total_won` (not `total_wagered` — Wager wipe's
// territory).
// ───────────────────────────────────────────────────────────────────────────

const wipeGameSchema = z.object({
  userId: z.string().min(1, "User id is required"),
  totpCode: z.string().min(1, "2FA code is required"),
  windowHours: z.union([z.literal(12), z.literal(24), z.literal(48)]),
});

export async function wipeGame(data: {
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
      withdrawalLockedSkipped: number;
      balanceReduced: number;
      windowHours: WipeWindowHours;
    }
  | { success: false; error: string }
> {
  const session = await gateWipe();

  const parseResult = wipeGameSchema.safeParse(data);
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
    console.error("[wipeGame] ensure-schema failed:", err);
    return {
      success: false,
      error: "Could not prepare the recovery store — wipe aborted (nothing deleted)",
    };
  }

  const db = await getDb();

  const windowHours = normalizeWipeWindow(parsed.windowHours);
  const cutoff = resolveWipeCutoff(windowHours);

  // Read everything up front so the snapshot is exact. All scoped to user +
  // the window cutoff.
  const ledgerRows = await db.ledger_transactions.findMany({
    where: {
      user_id: parsed.userId,
      type: { in: GAME_WIPE_LEDGER_TYPES as unknown as LedgerTransactionType[] },
      created_at: { gte: cutoff },
    },
    take: MAX_GAME_ROWS + 1,
  });
  const inventoryRows = await db.user_inventory.findMany({
    where: {
      user_id: parsed.userId,
      source_type: { in: WON_INVENTORY_SOURCES as unknown as ("pack" | "battle")[] },
      withdrawal_locked_at: null,
      obtained_at: { gte: cutoff },
    },
    take: MAX_GAME_ROWS + 1,
  });
  const withdrawalLockedSkipped = await db.user_inventory.count({
    where: {
      user_id: parsed.userId,
      source_type: { in: WON_INVENTORY_SOURCES as unknown as ("pack" | "battle")[] },
      withdrawal_locked_at: { not: null },
      obtained_at: { gte: cutoff },
    },
  });

  if (ledgerRows.length > MAX_GAME_ROWS || inventoryRows.length > MAX_GAME_ROWS) {
    return {
      success: false,
      error: `Gameplay history too large to snapshot safely (> ${MAX_GAME_ROWS.toLocaleString()} rows) — wipe aborted`,
    };
  }

  // Defence-in-depth re-guard: every row must be this user's + a real type +
  // (for inventory) a won pack/battle + not withdrawal-locked.
  for (const row of ledgerRows) {
    if (row.user_id !== parsed.userId || !GAME_WIPE_TYPE_SET.has(String(row.type))) {
      return {
        success: false,
        error: "A selected gameplay ledger row failed the ownership/type check — wipe aborted (nothing deleted)",
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

  const ledgerIds = ledgerRows.map((r) => r.id);
  const inventoryIds = inventoryRows.map((r) => r.id);

  const provablyFairRows =
    inventoryIds.length > 0
      ? await db.provably_fair_results.findMany({
          where: { inventory_item_id: { in: inventoryIds } },
          take: MAX_GAME_ROWS + 1,
        })
      : [];
  if (provablyFairRows.length > MAX_GAME_ROWS) {
    return {
      success: false,
      error: `Gameplay provably-fair history too large to snapshot safely — wipe aborted`,
    };
  }

  const upgraderTablePresent = await upgraderGamesPresent(db);
  let upgraderGameRows: Array<Record<string, unknown>> = [];
  if (upgraderTablePresent) {
    try {
      upgraderGameRows = await db.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT * FROM upgrader_games WHERE user_id = $1 AND created_at >= $2 LIMIT ${MAX_GAME_ROWS + 1}`,
        parsed.userId,
        cutoff,
      );
    } catch (err) {
      console.error("[wipeGame] upgrader_games read failed — aborting (nothing deleted):", err);
      return {
        success: false,
        error: "Could not read the user's upgrader games — wipe aborted (nothing deleted)",
      };
    }
    if (upgraderGameRows.length > MAX_GAME_ROWS) {
      return {
        success: false,
        error: `Upgrader history too large to snapshot safely — wipe aborted`,
      };
    }
  }

  if (ledgerRows.length === 0 && inventoryRows.length === 0 && upgraderGameRows.length === 0) {
    return { success: false, error: "This user has no gameplay data to wipe in the selected window" };
  }

  // BALANCE RULE: reduce ONLY by PAYOUT (credit) legs' magnitude. Wager
  // (debit) legs delete without changing the balance. Clamp ≥ 0 inside the
  // atomic UPDATE below (GREATEST(0, …)), so this computed value is the
  // INFORMATIONAL snapshot record — the live row drives the actual subtraction.
  const payoutMagnitude = ledgerRows.reduce((acc, r) => {
    if (GAME_WIPE_PAYOUT_TYPE_SET.has(String(r.type))) {
      return acc + Math.abs(toNumber(r.amount));
    }
    return acc;
  }, 0);
  const inventoryValue = inventoryRows.reduce((acc, r) => acc + toNumber(r.value_at_obtained), 0);
  const wonDeleted = payoutMagnitude + inventoryValue;

  // Read balance for the snapshot record + the clamped reductions (the
  // destructive UPDATE uses GREATEST against the LIVE row, NOT this value).
  const balanceRow = await db.balances
    .findUnique({ where: { user_id: parsed.userId } })
    .catch(() => null);
  if (!balanceRow) return { success: false, error: "User balances not found" };

  const balanceBefore = toNumber(balanceRow.available_balance);
  const balanceAfter = Math.max(0, balanceBefore - payoutMagnitude);
  const balanceReduction = balanceBefore - balanceAfter;
  const totalWonBefore = toNumber(balanceRow.total_won);
  const totalWonReduction = Math.min(wonDeleted, totalWonBefore);
  const totalWonClamped = wonDeleted > totalWonBefore;

  const userMeta = await db.user
    .findUnique({ where: { id: parsed.userId }, select: { username: true, email: true } })
    .catch(() => null);

  // SNAPSHOT FIRST.
  const snapshot: AccountWipeSnapshot = {
    type: "game",
    userId: parsed.userId,
    ledgerRows: ledgerRows as unknown as Array<Record<string, unknown>>,
    inventoryRows: inventoryRows as unknown as Array<Record<string, unknown>>,
    provablyFairRows: provablyFairRows as unknown as Array<Record<string, unknown>>,
    upgraderGameRows,
    balanceReduction: balanceReduction.toFixed(2),
    totalWonReduction: totalWonReduction.toFixed(2),
    windowHours,
    windowCutoff: cutoff.toISOString(),
  } satisfies { type: "game" } & GameWipeSnapshot;

  let wipeId: string;
  try {
    const created = await adminDb.admin_account_wipes.create({
      data: {
        wipe_type: "game",
        user_id: parsed.userId,
        username: userMeta?.username ?? null,
        email: userMeta?.email ?? null,
        wiped_by: session.userId,
        amount: balanceReduction,
        item_count:
          ledgerRows.length +
          inventoryRows.length +
          provablyFairRows.length +
          upgraderGameRows.length,
        status: WIPE_STATUS.PENDING,
        snapshot: accountWipeSnapshotToJsonValue(snapshot) as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    wipeId = created.id;
  } catch (snapErr) {
    console.error("[wipeGame] snapshot write failed — wipe aborted (nothing deleted):", snapErr);
    return {
      success: false,
      error: "Could not write the recovery snapshot — wipe aborted (nothing deleted)",
    };
  }

  // DESTRUCTIVE — one main-DB tx, children-first, FK-safe.
  let provablyFairDeleted = 0;
  let upgraderGamesDeleted = 0;
  try {
    await db.$transaction(async (tx) => {
      // (0a) PATTERN A — FOR UPDATE row lock on balances. Serializes concurrent
      // gameplay writes for the duration of this tx so the atomic UPDATE
      // below sees a stable row.
      await tx.$executeRaw`SELECT id FROM "balances" WHERE user_id = ${parsed.userId} FOR UPDATE`;

      // (0b) Raise the per-statement timeout for this transaction only.
      await tx.$executeRawUnsafe(
        `SET LOCAL statement_timeout = ${WIPE_STATEMENT_TIMEOUT_MS}`,
      );

      // (1) Break the ledger↔session FK cycle.
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

      // (3) Delete the wager + payout ledger legs (re-scoped by user + type +
      // window cutoff).
      if (ledgerIds.length > 0) {
        const legDel = await tx.ledger_transactions.deleteMany({
          where: {
            id: { in: ledgerIds },
            user_id: parsed.userId,
            type: { in: GAME_WIPE_LEDGER_TYPES as unknown as LedgerTransactionType[] },
            created_at: { gte: cutoff },
          },
        });
        if (legDel.count !== ledgerIds.length) {
          throw new Error("GAME_GUARD: gameplay ledger legs changed concurrently — refresh and retry");
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
          throw new Error("GAME_GUARD: inventory changed concurrently — refresh and retry");
        }
      }

      // (5) Delete upgrader_games rows (raw SQL).
      if (upgraderGameRows.length > 0) {
        const deleted = await tx.$executeRawUnsafe(
          `DELETE FROM upgrader_games WHERE user_id = $1 AND created_at >= $2`,
          parsed.userId,
          cutoff,
        );
        upgraderGamesDeleted = typeof deleted === "number" ? deleted : upgraderGameRows.length;
      }

      // (6) PATTERN B — atomic clamped UPDATE. ONLY `available_balance` (the
      // payout clawback) and `total_won` (the gaming-won counter) move.
      // `total_wagered` is INTENTIONALLY LEFT ALONE (the disjoint distinction
      // from the Wager wipe).
      if (balanceReduction > 0 || totalWonReduction > 0) {
        const updated = await tx.$executeRaw`
          UPDATE "balances"
          SET available_balance = GREATEST(0::numeric, available_balance - ${balanceReduction}::numeric),
              total_won = GREATEST(0::numeric, total_won - ${totalWonReduction}::numeric),
              version = version + 1
          WHERE user_id = ${parsed.userId}
        `;
        if (updated !== 1) {
          throw new Error("GAME_GUARD: user balances row not found — wipe aborted");
        }
      }
    }, WIPE_TX_OPTIONS);
  } catch (err) {
    await markWipeFailed("account", wipeId);
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(
      "[wipeGame] delete transaction failed for user",
      parsed.userId,
      "— wipeId",
      wipeId,
      ":",
      err,
    );
    if (message.startsWith("GAME_GUARD:")) {
      return { success: false, error: message.replace(/^GAME_GUARD:\s*/, "") };
    }
    if (/statement timeout|57014|canceling statement due to/i.test(message)) {
      return {
        success: false,
        error:
          "Wipe timed out — this account's gameplay history is unusually large for the selected window. Nothing was deleted (the data is safe). Please pick a shorter window or notify an administrator.",
      };
    }
    return { success: false, error: "Wipe failed — please try again (nothing deleted)" };
  }

  const finalized = await finalizeWipeSuccess({
    store: "account",
    wipeId,
    audit: {
      adminUserId: session.userId,
      eventType: "user_wipe_game",
      targetUserId: parsed.userId,
      ip: await resolveRequestIp(),
      metadata: {
        wipeId,
        wipe_type: "game",
        admin_user_id: session.userId,
        target_user_id: parsed.userId,
        window_hours: windowHours,
        cutoff_iso: cutoff.toISOString(),
        snapshot_id: wipeId,
        deleted_count:
          ledgerRows.length + inventoryRows.length + provablyFairDeleted + upgraderGamesDeleted,
        success: true,
        ledgerLegsDeleted: ledgerRows.length,
        inventoryDeleted: inventoryRows.length,
        inventoryValue,
        provablyFairDeleted,
        upgraderGamesDeleted,
        upgraderTablePresent,
        withdrawalLockedSkipped,
        balanceBefore,
        balanceAfter,
        balanceReduced: balanceReduction,
        totalWonBefore,
        totalWonReduced: totalWonReduction,
        totalWonClamped,
        recoverable: true,
        note: `Game wipe (${windowHours}h window): deleted the user's wager+payout ledger legs (pack/battle/upgrader) + won pack/battle inventory + provably_fair_results + upgrader_games. Decremented total_won only (NOT total_wagered — that is the Wager wipe's distinction). Balance reduced ONLY by the windowed payout (credit) legs' clawback (clamped ≥0 via atomic UPDATE); wager (debit) legs left balance unchanged.`,
      },
    },
  });
  if (!finalized.ok) {
    invalidateMetricCaches(parsed.userId);
    return {
      success: false,
      error:
        "Game was wiped (recoverable), but the audit record could not be finalized — the wipe is logged as 'pending' for reconciliation. Please notify an administrator.",
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
    withdrawalLockedSkipped,
    balanceReduced: balanceReduction,
    windowHours,
  };
}
