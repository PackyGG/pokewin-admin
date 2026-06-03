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
  type WagerWipeSnapshot,
} from "@/lib/account-wipes/snapshot";
import {
  WAGER_TYPES,
  GAMING_PAYOUT_TYPES,
  UPGRADER_LEDGER_TYPES,
  UPGRADER_IN_LEDGER,
  type LedgerTransactionType,
} from "@/lib/metrics/ledger-sets";
// The wager-window constant + type + pure helpers live in a CLIENT-SAFE module
// (no "use server"), NOT here: every export of THIS "use server" file becomes a
// server-action reference on the client, so a "use client" import of a runtime
// const from here would receive a function proxy (not the array) and crash on
// `.map` at render time. See wager-window.ts for the full regression note.
import {
  normalizeWindowHours,
  resolveWindowCutoff,
  type WagerWipeWindowHours,
} from "@/lib/account-wipes/wager-window";

// ---------------------------------------------------------------------------
// WIPE WAGER / GAMEPLAY — the SIXTH recoverable, targeted wipe, alongside the
// adjustments / balance / vault / inventory / deposits set. It DELETES the
// rows that make a user's wager + the resulting wager-loss exist in the
// metrics, so they stop driving GGR / the gaming margin ("Who drove the gaming
// margin") / P&L and stop showing in the transaction list:
//
//   1. The wager + payout LEDGER legs for the user — types:
//        pack_opening, battle_bet, battle_sponsorship            (WAGER_TYPES)
//        battle_refund, battle_excess_to_voucher          (GAMING_PAYOUT_TYPES)
//        upgrader_bet, upgrader_payout                  (UPGRADER_LEDGER_TYPES)
//      (the exact canonical set from src/lib/metrics/ledger-sets.ts — the same
//      legs GGR/wager/P&L sum). These feed the ledger side of GGR and show in
//      the user's /transactions list.
//   2. The won pack/battle `user_inventory` rows (source_type IN
//      ('pack','battle')) — GGR's DOMINANT gaming-payout leg is the
//      `value_at_obtained` delta of exactly these rows (ggr.ts inv_leg +
//      contributor inv_payout). Their `provably_fair_results` children are
//      deleted first (FK).
//   3. The `upgrader_games` rows for the user — the canonical GGR folds
//      upgrader in from `upgrader_games` (NOT the ledger — see ledger-sets.ts
//      UPGRADER note + ggr.ts contributor probe), so the upgrader margin only
//      stops once these rows are gone. The table is NOT in the Prisma schema
//      (the backend owns it; the stale worktree snapshot lacks it), so it is
//      read/snapshotted/deleted via RAW SQL, guarded by a `to_regclass` probe
//      exactly like the GGR contributor query — a DB without the table simply
//      contributes 0 upgrader rows.
//
// ─── WHAT IS DELIBERATELY NOT DELETED (FK-safety, flagged) ──────────────────
//
//  • `game_sessions` / `battles` SHELLS are LEFT INTACT. The ledger↔session FK
//    cycle (ledger_transactions.game_session_id ↔ game_sessions.bet_ledger_tx_id)
//    is broken by NULLING the session→ledger pointer (and balances.
//    last_transaction_id) so the ledger legs delete cleanly; the sessions stay
//    as orphan-free shells (their bet pointer self-heals on the next tx). We do
//    NOT delete `battles` because `battle_participants` cascade-delete from a
//    battle delete — that would remove OTHER users' participation rows + their
//    game_sessions. The session/battle shells do NOT feed the gaming margin
//    (GGR reads the ledger legs + inventory + upgrader_games, never the
//    session shells), so leaving them is correct for the margin and strictly
//    safer for referential integrity. (The disabled "Gaming logs" category is
//    the placeholder for a future shell-delete.)
//  • A withdrawal-locked won card (withdrawal_locked_at set) is SKIPPED + the
//    count is surfaced: its id is bundled into a pending card_withdrawal_requests
//    (a soft `inventory_item_ids` string[] reference), and deleting it would
//    corrupt an in-flight physical/crypto withdrawal. The owner handles those
//    via the withdrawal flow. (Almost never applies to a margin-cleanup user.)
//
// ─── BALANCE RULE (never inflate — owner mandate, mirrors the adjustments
//     wipe) ──────────────────────────────────────────────────────────────────
//
//  Each deleted ledger leg moved the balance. Deleting must NOT add money back:
//   • A PAYOUT leg (battle_refund / battle_excess_to_voucher / upgrader_payout)
//     is a CREDIT — it raised the balance — so deleting it claws that back
//     (balance −= magnitude). Net reduction is clamped so the balance never
//     goes below 0.
//   • A WAGER leg (pack_opening / battle_bet / battle_sponsorship /
//     upgrader_bet) is a DEBIT — it lowered the balance — so deleting it
//     leaves the balance UNCHANGED (we do NOT give the stake back).
//  So the balance reduction = Σ payout magnitudes, clamped ≥ 0; it can only
//  ever go DOWN or stay put. Inventory + upgrader_games carry no balance leg
//  (the inventory win was booked as inventory value, the upgrader payout via a
//  balance-update the `upgrader_payout` ledger leg — if present — already
//  represents), so only the payout LEDGER legs move the balance here.
//
// ─── LIFETIME WAGERING COUNTERS (total_wagered / total_won — owner mandate) ──
//
//  The production-maintained lifetime counters `balances.total_wagered` /
//  `balances.total_won` back /users/[id] AND the cost-breakdown "Who drove the
//  gaming margin" contributors. Deleting the gameplay rows does NOT touch them,
//  so a wiped user still shows in the contributors. This wipe therefore also
//  decrements them by exactly what it DELETED (the production composition of
//  these counters isn't derivable from this panel — APPROXIMATION, documented
//  on WagerWipeSnapshot):
//   • total_wagered −= Σ deleted wager-leg magnitudes.
//   • total_won     −= Σ deleted payout-leg magnitudes + Σ deleted won-inventory
//                       value_at_obtained.
//  Both CLAMPED ≥ 0 (never negative); the clamped reduction is snapshotted and
//  Restore re-adds EXACTLY that (symmetric). A full wager wipe removes
//  effectively all gameplay, so both land at ~0 — the user drops off the
//  contributors, which is the goal.
//
// ORDERING (CRITICAL, snapshot-first): the full recovery snapshot (ledger legs
// + inventory + PF children + upgrader_games + the exact balance reduction) is
// written to the admin DB and confirmed BEFORE the destructive main-DB tx. If
// the snapshot can't be written → abort (nothing changed). Recoverability of
// the gameplay graph is BEST-EFFORT via that snapshot (the owner prioritizes
// real deletion over a perfect-undo guarantee); restore re-inserts everything
// it captured + re-adds the exact balance delta removed.
//
// DUAL-DB (strict): destructive reads/writes on the main `db`; snapshot on
// `adminDb` (admin_account_wipes). No cross-DB joins.
//
// GATING: requireAdmin + __can_wipe_accounts + 2FA, preview+confirm upstream,
// hard ownership + type re-check on every row. NOT creator-protected (gameplay
// is the user's own activity), so it is wipeable for any user.
//
// ─── TIME-WINDOW BOUNDING (owner mandate — the heavy-account timeout fix) ───
//
//  Even with the 180s statement-timeout raise (below), a pathologically heavy
//  account's FULL gameplay history is too big to delete in one bounded tx — it
//  still times out ("Wipe timed out — …unusually large"). So the wipe accepts a
//  RECENT-WINDOW selector (12h / 24h / 48h, or "All"). A bounded window scopes
//  EVERY snapshot/delete to gameplay whose timestamp is ≥ the cutoff:
//    • ledger legs        → `created_at  >= cutoff`
//    • won inventory      → `obtained_at >= cutoff` (its provably_fair_results
//                            follow by parent id — already scoped to those rows)
//    • upgrader_games     → `created_at  >= cutoff` (raw SQL; the SAME column the
//                            canonical GGR contributor query + the upgrader
//                            transactions feed filter/order by)
//  → far fewer rows → the delete completes inside the timeout, and the owner can
//  repeat it to peel older windows. "All" (cutoff = null) keeps the exact prior
//  full-wipe behaviour for a light account.
//
//  HONEST CAVEAT (surfaced in the UI): a windowed wipe removes ONLY that
//  window's gameplay — older gameplay (and its contribution to the lifetime
//  total_wagered / total_won counters + GGR / margin) survives until wiped too.
//  A 24h wipe is therefore NOT a full removal. The counter decrement, balance
//  clawback and snapshot are all scoped to exactly the windowed rows, so
//  wipe/restore stays symmetric per-window.
// ---------------------------------------------------------------------------

// `WagerWipeWindowHours`, `WAGER_WIPE_WINDOW_OPTIONS`, `normalizeWindowHours`
// and `resolveWindowCutoff` now live in the client-safe `wager-window.ts`
// (imported above and used in this file's signatures). This "use server" module
// deliberately exports NOTHING for them — not the runtime const (it becomes a
// server-action reference on the client and crashed the dialog), and not even a
// `export type { ... }` re-export: Turbopack's server-module transform turns a
// re-exported (imported) type into a runtime export binding, which has no value
// and throws `ReferenceError: WagerWipeWindowHours is not defined` at module
// evaluation. The type's single source of truth is `wager-window.ts`; every
// consumer (the dialog, this action) imports it from there directly.

/**
 * The exact ledger types the wager wipe deletes — the canonical wager + payout
 * set from ledger-sets.ts, unioned.
 *
 * ENUM HYGIENE (secondary fix): the upgrader LEDGER legs (`upgrader_bet` /
 * `upgrader_payout`) are ONLY included when `UPGRADER_IN_LEDGER` is true. On
 * prod that flag is `false` (the owner confirmed upgrader lives only in
 * `upgrader_games`, NOT the ledger — see ledger-sets.ts UPGRADER note), so a
 * Prisma `type: { in: [...] }` filter built from this list never references the
 * upgrader enum members. That makes it structurally impossible for a
 * migration-lagged DB that lacks those enum values to throw `22P02 invalid
 * input value for enum` here. When the flag flips (prod confirmed the rows
 * exist) the upgrader ledger legs are folded back in automatically. Upgrader
 * GAMEPLAY is deleted regardless via the `upgrader_games` raw-SQL path below
 * (`to_regclass`-guarded), which does not touch the enum.
 */
const WAGER_WIPE_LEDGER_TYPES: readonly LedgerTransactionType[] = [
  ...WAGER_TYPES,
  ...GAMING_PAYOUT_TYPES,
  ...(UPGRADER_IN_LEDGER ? UPGRADER_LEDGER_TYPES : []),
];

// ---------------------------------------------------------------------------
// STATEMENT-TIMEOUT RAISE (PRIMARY fix). The pooled main-DB connection sets a
// GLOBAL `statement_timeout` of 30s (src/lib/db.ts) so a runaway analytics
// scan can't pin a pool slot. But a wager wipe on a HEAVY account
// (thousands of gameplay rows) legitimately needs longer than 30s to delete
// everything in one transaction — so the destructive tx was being KILLED at
// 30s, the tx rolled back, and (snapshot-first) the result was the misleading
// "Wipe failed — please try again (nothing deleted)" after a long wait.
//
// Fix (same technique as src/lib/queries/creators-pnl.ts): issue
// `SET LOCAL statement_timeout = '180000'` as the FIRST statement inside the
// destructive `db.$transaction`. `SET LOCAL` is scoped to the current
// transaction and REVERTS on commit/rollback, so it NEVER leaks the raised
// budget to other pool users (the global 30s cap is restored the moment this
// tx ends). 180s is a rare, one-off, admin-gated + 2FA-gated action and sits
// comfortably under Vercel's 300s function limit (the user page sets
// maxDuration=300 so the server isn't cut off first).
//
// Prisma's INTERACTIVE-transaction wrapper ALSO has its own default `timeout`
// of 5s (the time the whole interactive callback may run); that would abort
// the long delete well before either Postgres limit, so it is raised to match
// via WIPE_TX_OPTIONS below.
// ---------------------------------------------------------------------------

/** Postgres per-statement budget inside the destructive wipe tx (ms). */
const WIPE_STATEMENT_TIMEOUT_MS = 180_000;

/**
 * Prisma interactive-transaction options for the destructive wipe. `timeout`
 * is the max wall-clock the whole interactive callback may run — it MUST
 * exceed the per-statement Postgres budget above (plus headroom) so Prisma
 * doesn't tear the transaction down mid-delete; `maxWait` bounds how long we
 * wait for a free pool connection before giving up.
 */
const WIPE_TX_OPTIONS = {
  timeout: WIPE_STATEMENT_TIMEOUT_MS + 15_000,
  maxWait: 15_000,
} as const;

/** O(1) membership test for the deletable ledger set. */
const WAGER_WIPE_TYPE_SET: ReadonlySet<string> = new Set(WAGER_WIPE_LEDGER_TYPES);

/**
 * The PAYOUT (credit) legs within the set — deleting these claws money back
 * out of the balance. Everything else in the set is a WAGER (debit) leg whose
 * balance effect is left in place (BALANCE RULE).
 *
 * NOTE: `UPGRADER_LEDGER_TYPES` is BOTH `upgrader_bet` (a WAGER/debit) AND
 * `upgrader_payout` (the credit) — only `upgrader_payout` belongs here. Putting
 * the whole upgrader set in the payout bucket would wrongly claw back the
 * upgrader STAKE too (inflating-in-reverse). So the payout set is the battle
 * cash legs + `upgrader_payout` only.
 */
const WAGER_WIPE_PAYOUT_TYPE_SET: ReadonlySet<string> = new Set<string>([
  ...GAMING_PAYOUT_TYPES,
  "upgrader_payout",
]);

/** Won-inventory sources the wipe deletes (the GGR-valued gameplay wins). */
const WON_INVENTORY_SOURCES = ["pack", "battle"] as const;

/**
 * Sanity ceiling on rows we snapshot in one wipe (per collection). A
 * pathological gameplay history must not produce a multi-hundred-MB JSONB
 * blob; over the cap we refuse rather than truncate (a truncated snapshot is
 * not recoverable). Generous because gameplay rows are small + a single
 * heavy user can legitimately have many.
 */
const MAX_WAGER_ROWS = 100_000;

async function gateWipe() {
  const session = await requireAdmin();
  await requireCapability(session, "__can_wipe_accounts", "wipe wager / gameplay");
  return session;
}

const userIdSchema = z.string().min(1, "User id is required");

// ───────────────────────────────────────────────────────────────────────────
// Preview — lazy, called when the Wager category is ticked. Read-only.
// ───────────────────────────────────────────────────────────────────────────

export type WagerWipePreview = {
  /** Count of wager + payout ledger legs to delete. */
  ledgerLegCount: number;
  /** Σ |wager legs| (stake placed) — informational. */
  wagerTotal: number;
  /** Σ |payout legs| (the credit clawback that will leave the balance). */
  payoutTotal: number;
  /** Count of won pack/battle inventory rows to delete (excludes withdrawal-locked). */
  inventoryCount: number;
  /** Σ value_at_obtained of those inventory rows (the GGR inv-payout removed). */
  inventoryValue: number;
  /** Won pack/battle cards SKIPPED because they back an in-flight withdrawal. */
  withdrawalLockedSkipped: number;
  /** Count of upgrader_games rows to delete (0 when the DB lacks the table). */
  upgraderGameCount: number;
  /** Σ bet_amount of those upgrader games — informational. */
  upgraderBet: number;
  /** Σ won_amount of those upgrader games — informational. */
  upgraderWon: number;
  /** True when the connected DB carries `upgrader_games` (prod). */
  upgraderTablePresent: boolean;
  /**
   * The window this preview was computed for (echoed back so the dialog can
   * label the counts + warning). `null` = "All" (no lower time bound); a number
   * = the bounded look-back in hours.
   */
  windowHours: WagerWipeWindowHours;
  /** ISO cutoff the window resolves to (rows with ts ≥ this counted), or null for "All". */
  cutoff: string | null;
};

/** Shape of a raw `to_regclass` probe row. */
type RegclassRow = { exists: string | null };
/** Shape of the raw upgrader aggregate row. */
type UpgraderAggRow = { cnt: bigint | number | null; bet: string | null; won: string | null };

/**
 * Does the connected DB carry the `upgrader_games` table? The table is not in
 * the Prisma schema (backend-owned; the stale worktree snapshot lacks it), so
 * every upgrader touch is guarded by this probe — identical to the GGR
 * contributor query (`to_regclass('public.upgrader_games')`).
 */
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

/**
 * Count + value of everything the wager wipe would delete for this user IN THE
 * CHOSEN WINDOW, plus the withdrawal-locked won-card count it will skip +
 * whether upgrader_games exists. Read-only, scoped to this user. `sinceHours`
 * bounds the counts to gameplay whose timestamp is ≥ the cutoff (12 / 24 / 48),
 * or counts everything when null ("All"). The preview's counts therefore equal
 * exactly what the wipe with the same window will delete.
 */
export async function previewWagerWipe(
  userId: string,
  sinceHours: WagerWipeWindowHours = null,
): Promise<{ success: true; preview: WagerWipePreview } | { success: false; error: string }> {
  await gateWipe();
  const parsed = userIdSchema.safeParse(userId);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid user id" };
  }
  const db = await getDb();

  // Resolve the window to a single cutoff instant. null = "All" (no lower
  // bound). The ledger / inventory / upgrader reads below all share it.
  const windowHours = normalizeWindowHours(sinceHours);
  const cutoff = resolveWindowCutoff(windowHours);

  // Ledger legs split into wager (debit) vs payout (credit) by groupBy type,
  // bounded to the window by created_at (omitted entirely for "All").
  const ledgerGrouped = await db.ledger_transactions.groupBy({
    by: ["type"],
    where: {
      user_id: parsed.data,
      type: { in: WAGER_WIPE_LEDGER_TYPES as unknown as LedgerTransactionType[] },
      ...(cutoff ? { created_at: { gte: cutoff } } : {}),
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
    if (WAGER_WIPE_PAYOUT_TYPE_SET.has(String(g.type))) payoutTotal += magnitude;
    else wagerTotal += magnitude;
  }

  // Won pack/battle inventory — deletable (NOT withdrawal-locked) vs the
  // withdrawal-locked subset we skip. Both bounded to the window by obtained_at
  // so the deletable count + the skipped count both describe ONLY in-window
  // cards (consistent with what the wipe will actually touch).
  const [invAgg, lockedAgg] = await Promise.all([
    db.user_inventory.aggregate({
      where: {
        user_id: parsed.data,
        source_type: { in: WON_INVENTORY_SOURCES as unknown as ("pack" | "battle")[] },
        withdrawal_locked_at: null,
        ...(cutoff ? { obtained_at: { gte: cutoff } } : {}),
      },
      _count: { _all: true },
      _sum: { value_at_obtained: true },
    }),
    db.user_inventory.count({
      where: {
        user_id: parsed.data,
        source_type: { in: WON_INVENTORY_SOURCES as unknown as ("pack" | "battle")[] },
        withdrawal_locked_at: { not: null },
        ...(cutoff ? { obtained_at: { gte: cutoff } } : {}),
      },
    }),
  ]);

  // upgrader_games — probe first, then a raw aggregate (the table is not in the
  // Prisma client). Scoped to the user; injection-proof (no interpolation of
  // user input into the SQL string — the id is a bound parameter).
  let upgraderGameCount = 0;
  let upgraderBet = 0;
  let upgraderWon = 0;
  const upgraderTablePresent = await upgraderGamesPresent(db);
  if (upgraderTablePresent) {
    try {
      // Bound by created_at when a window is set (the SAME column the canonical
      // GGR contributor query + the upgrader transactions feed filter/order by).
      // The cutoff is a bound parameter ($2) — never string-interpolated.
      const rows = cutoff
        ? await db.$queryRawUnsafe<UpgraderAggRow[]>(
            `SELECT COUNT(*)::text AS cnt,
                    COALESCE(SUM(bet_amount), 0)::text AS bet,
                    COALESCE(SUM(won_amount), 0)::text AS won
             FROM upgrader_games WHERE user_id = $1 AND created_at >= $2`,
            parsed.data,
            cutoff,
          )
        : await db.$queryRawUnsafe<UpgraderAggRow[]>(
            `SELECT COUNT(*)::text AS cnt,
                    COALESCE(SUM(bet_amount), 0)::text AS bet,
                    COALESCE(SUM(won_amount), 0)::text AS won
             FROM upgrader_games WHERE user_id = $1`,
            parsed.data,
          );
      const r = rows?.[0];
      upgraderGameCount = r ? Number(r.cnt ?? 0) : 0;
      upgraderBet = r ? toNumber(r.bet) : 0;
      upgraderWon = r ? toNumber(r.won) : 0;
    } catch (err) {
      // Probe said present but the read failed — treat as absent (0) rather
      // than blocking the preview; the wipe re-checks before deleting.
      console.error("[previewWagerWipe] upgrader_games read failed:", err);
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
      cutoff: cutoff ? cutoff.toISOString() : null,
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// WIPE — snapshot everything, delete FK-safe, claw payout legs out of balance.
// ───────────────────────────────────────────────────────────────────────────

const wipeWagerSchema = z.object({
  userId: z.string().min(1, "User id is required"),
  totpCode: z.string().min(1, "2FA code is required"),
  // The recent window to bound the wipe to: 12 / 24 / 48 hours, or null/omitted
  // for "All" (no lower time bound — the prior full-wipe behaviour). Anything
  // else normalizes to "All" (the safe explicit default).
  sinceHours: z.union([z.literal(12), z.literal(24), z.literal(48), z.null()]).optional(),
});

export async function wipeWager(data: {
  userId: string;
  totpCode: string;
  sinceHours?: WagerWipeWindowHours;
}): Promise<
  | {
      success: true;
      ledgerLegsDeleted: number;
      inventoryDeleted: number;
      provablyFairDeleted: number;
      upgraderGamesDeleted: number;
      withdrawalLockedSkipped: number;
      balanceReduced: number;
      /** The window the wipe ran for: null = "All", a number = bounded hours. */
      windowHours: WagerWipeWindowHours;
    }
  | { success: false; error: string }
> {
  const session = await gateWipe();

  const parseResult = wipeWagerSchema.safeParse(data);
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
    console.error("[wipeWager] ensure-schema failed:", err);
    return {
      success: false,
      error: "Could not prepare the recovery store — wipe aborted (nothing deleted)",
    };
  }

  const db = await getDb();

  // Resolve the chosen window to a single cutoff instant up front (null =
  // "All"). EVERY read + delete below shares this exact instant, so the
  // snapshot, the delete and the counter decrement describe the same row set
  // (no drift between the read and the destructive tx).
  const windowHours = normalizeWindowHours(parsed.sinceHours);
  const cutoff = resolveWindowCutoff(windowHours);

  // ── READ everything up front (full rows) so the snapshot is exact. All
  // scoped strictly to this user AND to the window (ledger by created_at,
  // inventory by obtained_at). Bounded by MAX_WAGER_ROWS+1 per collection so an
  // over-cap history is detected without an unbounded scan. A bounded window is
  // precisely what keeps a heavy account's row count under the timeout. ──
  const ledgerRows = await db.ledger_transactions.findMany({
    where: {
      user_id: parsed.userId,
      type: { in: WAGER_WIPE_LEDGER_TYPES as unknown as LedgerTransactionType[] },
      ...(cutoff ? { created_at: { gte: cutoff } } : {}),
    },
    take: MAX_WAGER_ROWS + 1,
  });
  // Won pack/battle inventory, EXCLUDING withdrawal-locked (those back an
  // in-flight withdrawal — skipped + flagged). Bounded to the window by
  // obtained_at.
  const inventoryRows = await db.user_inventory.findMany({
    where: {
      user_id: parsed.userId,
      source_type: { in: WON_INVENTORY_SOURCES as unknown as ("pack" | "battle")[] },
      withdrawal_locked_at: null,
      ...(cutoff ? { obtained_at: { gte: cutoff } } : {}),
    },
    take: MAX_WAGER_ROWS + 1,
  });
  const withdrawalLockedSkipped = await db.user_inventory.count({
    where: {
      user_id: parsed.userId,
      source_type: { in: WON_INVENTORY_SOURCES as unknown as ("pack" | "battle")[] },
      withdrawal_locked_at: { not: null },
      ...(cutoff ? { obtained_at: { gte: cutoff } } : {}),
    },
  });

  if (ledgerRows.length > MAX_WAGER_ROWS || inventoryRows.length > MAX_WAGER_ROWS) {
    return {
      success: false,
      error: `Gameplay history too large to snapshot safely (> ${MAX_WAGER_ROWS.toLocaleString()} rows) — wipe aborted`,
    };
  }

  // HARD RE-GUARD every row (defence in depth): every ledger leg is this
  // user's + an allowed type; every inventory row is this user's + a won
  // pack/battle source + not withdrawal-locked. A foreign/mistyped row aborts
  // the whole wipe (nothing deleted).
  for (const row of ledgerRows) {
    if (row.user_id !== parsed.userId || !WAGER_WIPE_TYPE_SET.has(String(row.type))) {
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

  // provably_fair_results children of the inventory being deleted (snapshot so
  // a restore can re-insert them after the inventory; they FK to user_inventory
  // with onDelete Cascade, so the delete would otherwise drop them silently).
  const provablyFairRows =
    inventoryIds.length > 0
      ? await db.provably_fair_results.findMany({
          where: { inventory_item_id: { in: inventoryIds } },
          take: MAX_WAGER_ROWS + 1,
        })
      : [];
  if (provablyFairRows.length > MAX_WAGER_ROWS) {
    return {
      success: false,
      error: `Gameplay provably-fair history too large to snapshot safely — wipe aborted`,
    };
  }

  // upgrader_games for the user — raw read (table not in the Prisma client),
  // guarded by the regclass probe. Full rows captured as generic records so
  // restore can re-insert them via raw SQL.
  const upgraderTablePresent = await upgraderGamesPresent(db);
  let upgraderGameRows: Array<Record<string, unknown>> = [];
  if (upgraderTablePresent) {
    try {
      // Bound to the window by created_at (the canonical upgrader time column).
      // The cutoff is a bound parameter ($2); the LIMIT is a compile-time
      // constant, never user input.
      upgraderGameRows = cutoff
        ? await db.$queryRawUnsafe<Array<Record<string, unknown>>>(
            `SELECT * FROM upgrader_games WHERE user_id = $1 AND created_at >= $2 LIMIT ${MAX_WAGER_ROWS + 1}`,
            parsed.userId,
            cutoff,
          )
        : await db.$queryRawUnsafe<Array<Record<string, unknown>>>(
            `SELECT * FROM upgrader_games WHERE user_id = $1 LIMIT ${MAX_WAGER_ROWS + 1}`,
            parsed.userId,
          );
    } catch (err) {
      console.error("[wipeWager] upgrader_games read failed — aborting (nothing deleted):", err);
      return {
        success: false,
        error: "Could not read the user's upgrader games — wipe aborted (nothing deleted)",
      };
    }
    if (upgraderGameRows.length > MAX_WAGER_ROWS) {
      return {
        success: false,
        error: `Upgrader history too large to snapshot safely — wipe aborted`,
      };
    }
  }

  // Nothing to delete at all?
  if (ledgerRows.length === 0 && inventoryRows.length === 0 && upgraderGameRows.length === 0) {
    return { success: false, error: "This user has no wager / gameplay data to wipe" };
  }

  // ── BALANCE RULE: reduce ONLY by the PAYOUT (credit) legs' summed magnitude.
  // Wager (debit) legs delete without changing the balance. Clamp ≥ 0. ──
  const payoutMagnitude = ledgerRows.reduce((acc, r) => {
    if (WAGER_WIPE_PAYOUT_TYPE_SET.has(String(r.type))) {
      return acc + Math.abs(toNumber(r.amount));
    }
    return acc;
  }, 0);

  // Sum the stake (wager legs) for the audit trail only.
  const wagerMagnitude = ledgerRows.reduce((acc, r) => {
    if (!WAGER_WIPE_PAYOUT_TYPE_SET.has(String(r.type))) {
      return acc + Math.abs(toNumber(r.amount));
    }
    return acc;
  }, 0);
  const inventoryValue = inventoryRows.reduce((acc, r) => acc + toNumber(r.value_at_obtained), 0);

  // Read balance for the snapshot record (informational only — the destructive
  // tx below uses Pattern A: FOR UPDATE row lock + Pattern B: atomic clamped
  // UPDATE, so there is NO optimistic version check that can lose a race
  // against real-time gameplay writes ("Balance changed concurrently — please
  // retry" used to surface here on a heavy/active account).
  const balanceRow = await db.balances
    .findUnique({ where: { user_id: parsed.userId } })
    .catch(() => null);
  if (!balanceRow) return { success: false, error: "User balances not found" };
  const balanceBefore = toNumber(balanceRow.available_balance);
  const reduced = balanceBefore - payoutMagnitude;
  const balanceAfter = reduced < 0 ? 0 : reduced;
  const balanceReduction = balanceBefore - balanceAfter; // == clamped payout clawback, ≥ 0

  // ── LIFETIME WAGERING COUNTERS (total_wagered / total_won) ──
  // These are production-maintained lifetime counters this panel only reads —
  // they back /users/[id] (Total Wagered / Total Won / Wager Loss) AND the
  // cost-breakdown "Who drove the gaming margin" contributors. The wipe deletes
  // the gameplay rows but the counters retain the old values, so a wiped user
  // still shows in the contributors.
  //
  // TWO MODES (owner mandate 2026-06-03 — the FloridaManJeff fix):
  //
  //   • WINDOWED (12 / 24 / 48h): decrement each counter by what was DELETED
  //     in the chosen window — total_wagered −= Σ windowed wager-leg
  //     magnitudes; total_won −= Σ windowed payout-leg magnitudes + Σ windowed
  //     won-inventory value_at_obtained. Both CLAMPED ≥0 via the atomic
  //     UPDATE. This is the original behaviour and is UNCHANGED for windowed
  //     wipes — it must never zero a counter on a partial-window wipe.
  //
  //   • "ALL" (windowHours = null, cutoff = null): SET both counters DIRECTLY
  //     to 0 in the atomic UPDATE, regardless of how many rows the destructive
  //     delete actually touched. This is the FIX for the FloridaManJeff case:
  //     after earlier wipes (e.g. inventory / voucher) already deleted the
  //     source rows, a subsequent "All" Wager wipe finds nothing to subtract,
  //     the decrement is $0, and the lifetime counter never zeroes — leaving
  //     the Wagering Stats showing stale figures. The owner's intent for "All"
  //     is "treat this user as freshly created", so the counters MUST reach 0.
  //     The PRE-WIPE absolutes are snapshotted so Restore can put them back
  //     EXACTLY (a delta of 0 cannot be re-added meaningfully).
  //
  // CONCURRENCY: the atomic UPDATE is wrapped by Pattern A (FOR UPDATE row
  // lock) + Pattern B (computed against the LIVE row inside the same tx). For
  // the All case the SET = 0 / 0 is value-independent so concurrency safety is
  // trivial — no GREATEST needed.
  const totalWageredBefore = toNumber(balanceRow.total_wagered);
  const totalWonBefore = toNumber(balanceRow.total_won);
  const wonDeleted = payoutMagnitude + inventoryValue;
  // All-window wipe → counter "reduction" recorded for the audit is the FULL
  // pre-wipe value (so the audit log shows the actual zero-ing magnitude);
  // restore uses the snapshotted absolute, not this delta.
  const isAllWindow = cutoff === null;
  const totalWageredReduction = isAllWindow
    ? totalWageredBefore
    : Math.min(wagerMagnitude, totalWageredBefore);
  const totalWonReduction = isAllWindow
    ? totalWonBefore
    : Math.min(wonDeleted, totalWonBefore);
  // "Clamped" only applies to windowed wipes — an All-wipe is not "clamped",
  // it's an explicit reset (the audit log surfaces this via counters_fully_reset).
  const totalWageredClamped = isAllWindow ? false : wagerMagnitude > totalWageredBefore;
  const totalWonClamped = isAllWindow ? false : wonDeleted > totalWonBefore;

  const userMeta = await db.user
    .findUnique({ where: { id: parsed.userId }, select: { username: true, email: true } })
    .catch(() => null);

  // ── SNAPSHOT FIRST — write every captured row + the exact balance reduction.
  // Abort on failure (nothing deleted). ──
  const snapshot: AccountWipeSnapshot = {
    type: "wager",
    userId: parsed.userId,
    ledgerRows: ledgerRows as unknown as Array<Record<string, unknown>>,
    inventoryRows: inventoryRows as unknown as Array<Record<string, unknown>>,
    provablyFairRows: provablyFairRows as unknown as Array<Record<string, unknown>>,
    upgraderGameRows,
    balanceReduction: balanceReduction.toFixed(2),
    totalWageredReduction: totalWageredReduction.toFixed(2),
    totalWonReduction: totalWonReduction.toFixed(2),
    // Record the window the wipe ran for (informational — the snapshot already
    // holds ONLY the windowed rows, so restore re-adds exactly the windowed set).
    windowHours,
    windowCutoff: cutoff ? cutoff.toISOString() : null,
    // ALL-WINDOW COUNTER-RESET fields (owner mandate 2026-06-03). On an "All"
    // wipe the destructive UPDATE sets total_wagered + total_won to 0
    // directly, so Restore needs the PRE-WIPE ABSOLUTES to put back — a zero
    // delta cannot be re-added meaningfully. For windowed wipes these fields
    // stay unset and Restore falls back to the existing additive-delta path.
    ...(isAllWindow
      ? {
          countersFullyReset: true as const,
          totalWageredBefore: totalWageredBefore.toFixed(2),
          totalWonBefore: totalWonBefore.toFixed(2),
        }
      : {}),
  } satisfies { type: "wager" } & WagerWipeSnapshot;

  let wipeId: string;
  try {
    const created = await adminDb.admin_account_wipes.create({
      data: {
        wipe_type: "wager",
        user_id: parsed.userId,
        username: userMeta?.username ?? null,
        email: userMeta?.email ?? null,
        wiped_by: session.userId,
        // `amount` = the balance clawback (what left the balance); `item_count`
        // = the total rows removed across all collections (legs + inventory +
        // PF + upgrader games).
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
    console.error("[wipeWager] snapshot write failed — wipe aborted (nothing deleted):", snapErr);
    return {
      success: false,
      error: "Could not write the recovery snapshot — wipe aborted (nothing deleted)",
    };
  }

  // ── DESTRUCTIVE — one main-DB tx, children-first, FK-safe. ──
  let provablyFairDeleted = 0;
  let upgraderGamesDeleted = 0;
  try {
    await db.$transaction(async (tx) => {
      // (0a) PATTERN A — lock the user's balance row FOR UPDATE at the very
      // start of the destructive tx. Concurrent real-time gameplay writes
      // (a pack open / battle settle racing this wipe) BLOCK here until the
      // tx commits, instead of going through and bumping `version` mid-flight.
      // This kills the prior "Balance changed concurrently — please retry"
      // failure mode on a heavy/active account: when the wipe ran the
      // optimistic-version check at the end, a single live tx between the read
      // and the write was enough to fail it. With the row lock taken first,
      // there is no race window — every other ledger write on this user
      // serializes behind this tx for the duration. The lock is released on
      // commit/rollback. Bound the user id to a parameter ($1), never inlined.
      await tx.$executeRaw`SELECT id FROM "balances" WHERE user_id = ${parsed.userId} FOR UPDATE`;

      // (0b) Raise the per-statement timeout for THIS transaction only. The
      // pooled connection's global 30s `statement_timeout` (src/lib/db.ts) is
      // too low for a heavy account's full gameplay delete — it was killing
      // the tx at 30s and yielding the misleading "nothing deleted" after a
      // long wait. `SET LOCAL` is transaction-scoped and reverts on
      // commit/rollback, so the global 30s cap is restored the instant this tx
      // ends and never leaks to other pool users. (Same technique as
      // creators-pnl.ts.)
      await tx.$executeRawUnsafe(
        `SET LOCAL statement_timeout = ${WIPE_STATEMENT_TIMEOUT_MS}`,
      );

      // (1) Break the ledger↔session FK cycle: null any game_sessions pointer
      // to a ledger leg we're about to delete (RESTRICT would otherwise block
      // the delete). The session shell stays; the bet pointer self-heals.
      if (ledgerIds.length > 0) {
        await tx.game_sessions.updateMany({
          where: { bet_ledger_tx_id: { in: ledgerIds } },
          data: { bet_ledger_tx_id: null },
        });
        // (2) Null the denorm balances.last_transaction_id if it points at a
        // leg we're deleting (FK is RESTRICT; self-heals on the next tx).
        await tx.balances.updateMany({
          where: { user_id: parsed.userId, last_transaction_id: { in: ledgerIds } },
          data: { last_transaction_id: null },
        });
      }

      // (3) Delete the provably_fair_results children of the inventory being
      // deleted (snapshotted above). Scoped to exactly those inventory ids so
      // PF rows of surviving inventory are untouched.
      if (inventoryIds.length > 0) {
        const pfDel = await tx.provably_fair_results.deleteMany({
          where: { inventory_item_id: { in: inventoryIds } },
        });
        provablyFairDeleted = pfDel.count;
      }

      // (4) Delete the wager + payout ledger legs (re-scoped by user + type +
      // the window cutoff so a race can't widen the blast radius beyond the
      // windowed set we snapshotted; count verified). Their outbound
      // game_session_id FK is fine — the session they point at remains.
      if (ledgerIds.length > 0) {
        const legDel = await tx.ledger_transactions.deleteMany({
          where: {
            id: { in: ledgerIds },
            user_id: parsed.userId,
            type: { in: WAGER_WIPE_LEDGER_TYPES as unknown as LedgerTransactionType[] },
            ...(cutoff ? { created_at: { gte: cutoff } } : {}),
          },
        });
        if (legDel.count !== ledgerIds.length) {
          throw new Error("WAGER_GUARD: gameplay ledger legs changed concurrently — refresh and retry");
        }
      }

      // (5) Delete the won pack/battle inventory rows (re-scoped + held-from-
      // withdrawal + the window cutoff; PF children already gone). Count
      // verified.
      if (inventoryIds.length > 0) {
        const invDel = await tx.user_inventory.deleteMany({
          where: {
            id: { in: inventoryIds },
            user_id: parsed.userId,
            source_type: { in: WON_INVENTORY_SOURCES as unknown as ("pack" | "battle")[] },
            withdrawal_locked_at: null,
            ...(cutoff ? { obtained_at: { gte: cutoff } } : {}),
          },
        });
        if (invDel.count !== inventoryIds.length) {
          throw new Error("WAGER_GUARD: inventory changed concurrently — refresh and retry");
        }
      }

      // (6) Delete the upgrader_games rows (raw SQL; table not in the Prisma
      // client). Scoped to the user AND the window cutoff (created_at) so a
      // windowed wipe deletes ONLY in-window upgrader games — NOT the user's
      // entire upgrader history. Both the user id and the cutoff are bound
      // parameters ($1 / $2), never string-interpolated.
      if (upgraderGameRows.length > 0) {
        const deleted = cutoff
          ? await tx.$executeRawUnsafe(
              `DELETE FROM upgrader_games WHERE user_id = $1 AND created_at >= $2`,
              parsed.userId,
              cutoff,
            )
          : await tx.$executeRawUnsafe(
              `DELETE FROM upgrader_games WHERE user_id = $1`,
              parsed.userId,
            );
        upgraderGamesDeleted = typeof deleted === "number" ? deleted : upgraderGameRows.length;
      }

      // (7) PATTERN B — atomic balance UPDATE. ONE raw SQL UPDATE covering all
      // three columns. The exact SET clause depends on the window:
      //
      //   WINDOWED (12 / 24 / 48h) — UNCHANGED ORIGINAL BEHAVIOUR: clamped
      //   delta subtraction via GREATEST(0, current − reduction). Values are
      //   computed FROM THE LIVE ROW inside the same transaction, NOT from the
      //   values we read earlier (which could be stale by even a few ms on a
      //   hot account). The FOR UPDATE row lock above already serializes
      //   concurrent writers behind this tx, so the live row's values reflect
      //   any tx that committed BEFORE we took the lock — and nothing else can
      //   move them until we commit. No optimistic version check.
      //
      //   "ALL" (cutoff = null, isAllWindow = true) — owner mandate 2026-06-03
      //   FloridaManJeff fix: SET total_wagered = 0, total_won = 0 DIRECTLY.
      //   Concurrency safety is trivial — value-independent SET. We still use
      //   the same GREATEST clamp on available_balance (the balance is moved
      //   by the actual payout-leg clawback regardless of window; an "All"
      //   wipe doesn't claw back more than the payouts it actually deleted —
      //   inflating the balance reduction would VIOLATE the BALANCE RULE).
      //
      // The version is bumped so cached reads invalidate.
      //
      // Fired whenever any column has something to do (a pure-wager wipe or an
      // All-wipe with zero rows still resets counters, so this is NOT gated on
      // balanceReduction alone). All numeric reductions are bound as
      // parameters (never string-interpolated) and decimals (their
      // string-toFixed form, parsed by Postgres as NUMERIC).
      if (isAllWindow) {
        // All-window: reset counters to 0 directly; balance still uses the
        // clamped delta path (payout-leg clawback only — owner BALANCE RULE).
        const updated = await tx.$executeRaw`
          UPDATE "balances"
          SET available_balance = GREATEST(0::numeric, available_balance - ${balanceReduction}::numeric),
              total_wagered = 0::numeric,
              total_won = 0::numeric,
              version = version + 1
          WHERE user_id = ${parsed.userId}
        `;
        if (updated !== 1) {
          throw new Error("WAGER_GUARD: user balances row not found — wipe aborted");
        }
      } else if (balanceReduction > 0 || totalWageredReduction > 0 || totalWonReduction > 0) {
        // Windowed: original clamped-delta path, UNCHANGED.
        const updated = await tx.$executeRaw`
          UPDATE "balances"
          SET available_balance = GREATEST(0::numeric, available_balance - ${balanceReduction}::numeric),
              total_wagered = GREATEST(0::numeric, total_wagered - ${totalWageredReduction}::numeric),
              total_won = GREATEST(0::numeric, total_won - ${totalWonReduction}::numeric),
              version = version + 1
          WHERE user_id = ${parsed.userId}
        `;
        if (updated !== 1) {
          throw new Error("WAGER_GUARD: user balances row not found — wipe aborted");
        }
      }
    }, WIPE_TX_OPTIONS);
  } catch (err) {
    // Main-DB tx failed → nothing deleted. Mark the snapshot 'failed' (terminal,
    // restore refuses) rather than deleting it, for a reconcilable record.
    await markWipeFailed("account", wipeId);
    const message = err instanceof Error ? err.message : "Unknown error";
    // ALWAYS log the real underlying error/stack (NOT just the redacted
    // client message) so the Vercel logs show exactly why a wipe failed —
    // statement-timeout (57014 / "canceling statement due to statement
    // timeout"), an FK RESTRICT, a 22P02 enum, or the optimistic-lock retry.
    // The redacted message returned to the client never leaks internals.
    console.error(
      "[wipeWager] delete transaction failed for user",
      parsed.userId,
      "— wipeId",
      wipeId,
      ":",
      err,
    );
    if (message.startsWith("WAGER_GUARD:")) {
      return { success: false, error: message.replace(/^WAGER_GUARD:\s*/, "") };
    }
    if (message.includes("concurrently")) return { success: false, error: message };
    // Surface a timeout distinctly so a still-too-large account is actionable
    // (rather than the generic "try again" that hid the real cause). Postgres
    // raises SQLSTATE 57014 with this message text when statement_timeout hits.
    if (
      /statement timeout|57014|canceling statement due to/i.test(message)
    ) {
      return {
        success: false,
        error:
          "Wipe timed out — this account's gameplay history is unusually large. Nothing was deleted (the data is safe). Please notify an administrator.",
      };
    }
    return { success: false, error: "Wipe failed — please try again (nothing deleted)" };
  }

  // Destructive delete COMMITTED → atomically (one admin-DB tx) flip the
  // snapshot status → 'completed' AND write the audit event.
  const finalized = await finalizeWipeSuccess({
    store: "account",
    wipeId,
    audit: {
      adminUserId: session.userId,
      eventType: "user_wager_wiped",
      targetUserId: parsed.userId,
      ip: await resolveRequestIp(),
      metadata: {
        wipeId,
        windowHours,
        windowCutoff: cutoff ? cutoff.toISOString() : null,
        // OWNER MANDATE 2026-06-03 (FloridaManJeff fix): explicit flag on
        // "All" wipes so wipe-history rendering can label them clearly. For
        // 12/24/48 windowed wipes this is `false`.
        counters_fully_reset: isAllWindow,
        ledgerLegsDeleted: ledgerRows.length,
        wagerMagnitude,
        payoutMagnitude,
        inventoryDeleted: inventoryRows.length,
        inventoryValue,
        provablyFairDeleted,
        upgraderGamesDeleted,
        upgraderTablePresent,
        withdrawalLockedSkipped,
        balanceBefore,
        balanceAfter,
        balanceReduced: balanceReduction,
        balanceClamped: reduced < 0,
        totalWageredBefore,
        totalWageredReduced: totalWageredReduction,
        totalWageredClamped,
        totalWonBefore,
        totalWonReduced: totalWonReduction,
        totalWonClamped,
        recoverable: true,
        note: `Deleted the user's wager+payout ledger legs (pack/battle/upgrader) + won pack/battle inventory (+ their provably_fair_results) + upgrader_games, bounded to ${windowHours === null ? "ALL gameplay (no time window)" : `the last ${windowHours}h (created_at/obtained_at ≥ cutoff)`}. ${isAllWindow ? "ALL-WINDOW COUNTER RESET (owner mandate 2026-06-03): total_wagered AND total_won SET TO 0 DIRECTLY (regardless of deleted row sums) so the user reads as freshly created — restore puts back the PRE-WIPE absolutes from the snapshot. " : ""}A WINDOWED wipe removes ONLY that window's gameplay — older gameplay (and its effect on lifetime stats / GGR) remains until wiped too. Balance reduced ONLY by the windowed payout (credit) legs' clawback (clamped ≥0); wager (debit) legs left the balance unchanged (never inflate). ${isAllWindow ? "" : "Lifetime balances.total_wagered reduced by Σ windowed wager-leg magnitudes; balances.total_won reduced by Σ windowed payout-leg magnitudes + windowed won-inventory value_at_obtained (the production composition isn't derivable here, so this decrements by what was DELETED — both clamped ≥0); restore re-adds EXACTLY these. "}game_sessions/battles shells LEFT intact (battle delete would cascade other participants); session bet pointer + balances.last_transaction_id nulled to break the FK cycle (self-heal). Withdrawal-locked won cards SKIPPED (back an in-flight withdrawal). Remaining ledger rows' balance_before/after not rewritten.`,
      },
    },
  });
  if (!finalized.ok) {
    invalidateMetricCaches(parsed.userId);
    return {
      success: false,
      error:
        "Wager / gameplay was wiped (recoverable), but the audit record could not be finalized — the wipe is logged as 'pending' for reconciliation. Please notify an administrator.",
    };
  }

  // Bust the user page + global metric caches — the deleted legs + inventory +
  // upgrader games feed GGR / wager / gaming-margin / P&L; restore reverses it.
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
