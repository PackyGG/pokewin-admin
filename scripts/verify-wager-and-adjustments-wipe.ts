/**
 * verify-wager-and-adjustments-wipe.ts — proof of the two 2026-06-03 wipe
 * changes:
 *
 *   TASK B — adjustments wipe deletes CREDITS *and* DEBITS, and the balance is
 *            reduced ONLY by the credit clawback (Σ positive amounts, clamped
 *            ≥0); deleting a debit leaves the balance UNCHANGED (never
 *            inflates). Restore re-adds EXACTLY balance_before − balance_after.
 *
 *   TASK C — the new "wager / gameplay" wipe: snapshot → delete (FK-safe) →
 *            restore round-trip for the wager+payout ledger legs + won
 *            pack/battle inventory (+ their provably_fair_results). The balance
 *            is reduced ONLY by the PAYOUT (credit) legs' magnitude (clamped),
 *            never by the wager (debit) legs. game_sessions/battles SHELLS are
 *            left intact; the ledger↔session FK cycle is broken by nulling the
 *            session bet pointer + balances.last_transaction_id. The lifetime
 *            `balances.total_wagered` / `total_won` counters are also reduced
 *            (by Σ wager-leg magnitudes / Σ payout-leg + won-inventory value,
 *            each clamped ≥0) so a wiped user drops off the cost-breakdown
 *            contributors; restore re-adds EXACTLY those reductions.
 *
 *   TASK D — the TIME-WINDOW bounding (heavy-account timeout fix): the wager
 *            wipe accepts a recent window (12h / 24h / 48h, or "All" = null).
 *            A bounded window scopes EVERY snapshot/delete/counter-decrement to
 *            gameplay whose timestamp is ≥ the cutoff (ledger by created_at,
 *            won inventory by obtained_at, upgrader_games by created_at) so a
 *            heavy account's delete is small enough to finish inside the
 *            statement timeout. Out-of-window gameplay SURVIVES (the wipe is
 *            repeatable + restore re-adds exactly the windowed set). Asserted
 *            both PURE (cutoff resolution + in/out partition + the windowed
 *            balance/counter sums) and ROLLED-BACK (a mixed recent+old user
 *            where a 24h wipe deletes only the recent rows + leaves the old).
 *
 * Two layers:
 *   1. PURE (no DB) — always runs: the balance-rule arithmetic + the ledger
 *      type partition the wipe uses. These are the invariants the owner cares
 *      about ("don't add money back").
 *   2. ROLLED-BACK DB round-trip — runs ONLY when DATABASE_URL is set. Every
 *      destructive op is inside a tx force-ROLLED BACK at the end, so the
 *      (stale) snapshot DB is never mutated. upgrader_games is probed and
 *      skipped when the table is absent (the stale worktree snapshot lacks it).
 *
 * Run: npx tsx scripts/verify-wager-and-adjustments-wipe.ts
 */
import { config as loadEnv } from "dotenv";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.js";
import {
  WAGER_TYPES,
  GAMING_PAYOUT_TYPES,
  UPGRADER_LEDGER_TYPES,
  UPGRADER_IN_LEDGER,
} from "../src/lib/metrics/ledger-sets.js";

loadEnv({ path: ".env" });
loadEnv({ path: ".env.local", override: true });

const ROLLBACK = "ROLLBACK_SENTINEL";
let failures = 0;
function check(label: string, cond: boolean) {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
}

// ── The exact sets the wager wipe uses (mirrors wipe-wager-actions.ts). ──
// ENUM HYGIENE: the upgrader LEDGER legs are only in the deletable set when
// `UPGRADER_IN_LEDGER` is true. On prod the flag is false (upgrader lives in
// `upgrader_games`, not the ledger), so the Prisma `type: { in: [...] }`
// filter never names the upgrader enum members and can't throw 22P02 on a
// migration-lagged DB.
const WAGER_WIPE_LEDGER_TYPES = [
  ...WAGER_TYPES,
  ...GAMING_PAYOUT_TYPES,
  ...(UPGRADER_IN_LEDGER ? UPGRADER_LEDGER_TYPES : []),
];
// Only the CREDIT legs claw back: battle cash legs + upgrader_payout. NOT
// upgrader_bet (that's a wager/debit even though it lives in
// UPGRADER_LEDGER_TYPES alongside the payout).
const PAYOUT_SET = new Set<string>([...GAMING_PAYOUT_TYPES, "upgrader_payout"]);

/** The wager-wipe balance reduction = Σ payout magnitudes, clamped ≥0. */
function wagerBalanceReduction(
  legs: Array<{ type: string; amount: number }>,
  balanceBefore: number,
): number {
  const payout = legs.reduce(
    (acc, l) => (PAYOUT_SET.has(l.type) ? acc + Math.abs(l.amount) : acc),
    0,
  );
  const after = Math.max(0, balanceBefore - payout);
  return balanceBefore - after; // == clamped payout clawback
}

/** The adjustments-wipe balance reduction = Σ positive amounts, clamped ≥0. */
function adjBalanceReduction(
  rows: Array<{ amount: number }>,
  balanceBefore: number,
): number {
  const credit = rows.reduce((acc, r) => (r.amount > 0 ? acc + r.amount : acc), 0);
  const after = Math.max(0, balanceBefore - credit);
  return balanceBefore - after;
}

/**
 * The wager-wipe lifetime-counter reductions (mirrors wipe-wager-actions.ts):
 *   • total_wagered −= Σ wager-leg magnitudes,                clamped ≥0.
 *   • total_won     −= Σ payout-leg magnitudes + Σ inventory, clamped ≥0.
 * The clamped reduction (== what is subtracted AND what Restore re-adds) is
 * returned for each counter. Symmetric by construction: re-adding the returned
 * value to (before − reduction) lands back on `before` when nothing else moved.
 */
function wagerCounterReductions(
  legs: Array<{ type: string; amount: number }>,
  inventoryValue: number,
  totalWageredBefore: number,
  totalWonBefore: number,
): { totalWageredReduction: number; totalWonReduction: number } {
  const wagerMagnitude = legs.reduce(
    (acc, l) => (PAYOUT_SET.has(l.type) ? acc : acc + Math.abs(l.amount)),
    0,
  );
  const payoutMagnitude = legs.reduce(
    (acc, l) => (PAYOUT_SET.has(l.type) ? acc + Math.abs(l.amount) : acc),
    0,
  );
  return {
    totalWageredReduction: Math.min(wagerMagnitude, totalWageredBefore),
    totalWonReduction: Math.min(payoutMagnitude + inventoryValue, totalWonBefore),
  };
}

// ── The TIME-WINDOW the wager wipe bounds itself to (mirrors
// wipe-wager-actions.ts: 12 / 24 / 48 hours, or null = "All"). A bounded
// window keeps a heavy account's delete small + fast (it was timing out). The
// cutoff is rows with the relevant ts ≥ (now − hours). ──
type WagerWipeWindowHours = 12 | 24 | 48 | null;

/** Normalize an arbitrary input to a valid window (unknown → "All"/null). */
function normalizeWindowHours(v: unknown): WagerWipeWindowHours {
  if (v === 12 || v === 24 || v === 48) return v;
  return null;
}

/** Resolve a window to an absolute cutoff Date (null = "All", no lower bound). */
function resolveWindowCutoff(hours: WagerWipeWindowHours, now: number = Date.now()): Date | null {
  if (hours === null) return null;
  return new Date(now - hours * 60 * 60 * 1000);
}

/** Is a row with timestamp `ts` inside the window cutoff? (null cutoff = always). */
function inWindow(ts: Date, cutoff: Date | null): boolean {
  return cutoff === null || ts.getTime() >= cutoff.getTime();
}

async function pureChecks() {
  console.log("── PURE: ledger partition the wager wipe deletes ──");
  // The deletable set is flag-aware: with UPGRADER_IN_LEDGER off (prod) it is
  // the 5 base wager+payout types; with it on, the 2 upgrader legs union in.
  const expectedWipeSet = (
    UPGRADER_IN_LEDGER
      ? [
          "battle_bet",
          "battle_excess_to_voucher",
          "battle_refund",
          "battle_sponsorship",
          "pack_opening",
          "upgrader_bet",
          "upgrader_payout",
        ]
      : [
          "battle_bet",
          "battle_excess_to_voucher",
          "battle_refund",
          "battle_sponsorship",
          "pack_opening",
        ]
  )
    .sort()
    .join(",");
  check(
    `wager-wipe set = WAGER ∪ GAMING_PAYOUT${UPGRADER_IN_LEDGER ? " ∪ UPGRADER (7 types)" : " (5 types; upgrader ledger legs gated OFF)"}`,
    [...new Set(WAGER_WIPE_LEDGER_TYPES)].sort().join(",") === expectedWipeSet,
  );
  // ENUM HYGIENE: while the flag is off, the upgrader enum members must NOT be
  // in the Prisma filter list (so a 22P02 on a migration-lagged DB is
  // impossible). This is the secondary fix being asserted.
  check(
    "enum hygiene: upgrader ledger legs excluded from the delete filter while UPGRADER_IN_LEDGER is off",
    UPGRADER_IN_LEDGER ||
      (!WAGER_WIPE_LEDGER_TYPES.includes("upgrader_bet") &&
        !WAGER_WIPE_LEDGER_TYPES.includes("upgrader_payout")),
  );
  check(
    "payout (credit) classification set = battle_refund, battle_excess_to_voucher, upgrader_payout",
    [...PAYOUT_SET].sort().join(",") ===
      ["battle_excess_to_voucher", "battle_refund", "upgrader_payout"].sort().join(","),
  );
  // The wager (debit) legs ACTUALLY in the deletable set — flag-aware: with the
  // upgrader ledger legs gated off, upgrader_bet is not present.
  const expectedWagerDebits = (
    UPGRADER_IN_LEDGER
      ? ["battle_bet", "battle_sponsorship", "pack_opening", "upgrader_bet"]
      : ["battle_bet", "battle_sponsorship", "pack_opening"]
  )
    .sort()
    .join(",");
  check(
    `wager (debit) legs in the delete set = ${expectedWagerDebits.replace(/,/g, ", ")}`,
    WAGER_WIPE_LEDGER_TYPES.filter((t) => !PAYOUT_SET.has(t))
      .sort()
      .join(",") === expectedWagerDebits,
  );

  console.log("\n── PURE: BALANCE RULE — deleting never inflates ──");
  // Wager wipe: only payout legs claw back; wager legs leave balance put.
  check(
    "wager wipe: a pure WAGER batch removes $0 from balance (debits left in place)",
    wagerBalanceReduction(
      [
        { type: "pack_opening", amount: 50 },
        { type: "battle_bet", amount: 30 },
        { type: "upgrader_bet", amount: 20 },
      ],
      140.67,
    ) === 0,
  );
  check(
    "wager wipe: payout legs claw back exactly their magnitude (clamped)",
    wagerBalanceReduction(
      [
        { type: "battle_refund", amount: 100 },
        { type: "pack_opening", amount: 50 }, // debit ignored
      ],
      140.67,
    ) === 100,
  );
  check(
    "wager wipe: clawback clamps at the available balance (never negative)",
    wagerBalanceReduction([{ type: "upgrader_payout", amount: 500 }], 140.67) === 140.67,
  );

  console.log("\n── PURE: lifetime counters (total_wagered / total_won) ──");
  // total_wagered drops by the wager-leg sum; total_won drops by the payout-leg
  // sum + won-inventory value. Here: wagers 50+30+20=100, payout 120,
  // inventory 75 → won-delta = 195.
  {
    const r = wagerCounterReductions(
      [
        { type: "pack_opening", amount: 50 },
        { type: "battle_bet", amount: 30 },
        { type: "upgrader_bet", amount: 20 },
        { type: "battle_refund", amount: 120 },
      ],
      75, // won-inventory value_at_obtained
      10_000, // total_wagered before (plenty)
      10_000, // total_won before (plenty)
    );
    check("total_wagered reduction = Σ wager legs (100)", r.totalWageredReduction === 100);
    check("total_won reduction = payout (120) + inventory (75) = 195", r.totalWonReduction === 195);
  }
  // Clamp: counters never go negative — a user whose counter holds less than the
  // deleted sum reduces only down to 0.
  {
    const r = wagerCounterReductions(
      [{ type: "pack_opening", amount: 500 }, { type: "battle_refund", amount: 800 }],
      400,
      120, // total_wagered before < 500 wager sum
      90, // total_won before < 800+400 won sum
    );
    check("total_wagered reduction clamps at the counter (120, not 500)", r.totalWageredReduction === 120);
    check("total_won reduction clamps at the counter (90, not 1200)", r.totalWonReduction === 90);
  }
  // Pure-wager wipe (no payout legs, no inventory): total_wagered drops, total_won
  // does NOT move — and the balance does NOT move either (debits left in place).
  {
    const legs = [{ type: "pack_opening", amount: 60 }, { type: "battle_bet", amount: 40 }];
    const r = wagerCounterReductions(legs, 0, 5_000, 5_000);
    check("pure-wager: total_wagered reduction = 100", r.totalWageredReduction === 100);
    check("pure-wager: total_won reduction = 0 (no payout/inventory)", r.totalWonReduction === 0);
    check("pure-wager: balance reduction = 0 (debits never inflate)", wagerBalanceReduction(legs, 140.67) === 0);
  }
  // Restore symmetry: re-adding the clamped reduction to (before − reduction)
  // restores the original counter exactly (when nothing else moved).
  {
    const before = 3210.55;
    const r = wagerCounterReductions(
      [{ type: "pack_opening", amount: 100 }],
      40,
      before,
      before,
    );
    const wageredAfter = before - r.totalWageredReduction;
    const wonAfter = before - r.totalWonReduction;
    check("total_wagered restore re-adds exactly before − after", wageredAfter + r.totalWageredReduction === before);
    check("total_won restore re-adds exactly before − after", wonAfter + r.totalWonReduction === before);
  }

  console.log("\n── PURE: time-window bounding (12h / 24h / 48h / All) ──");
  // Normalization: only 12/24/48 are bounded windows; anything else is "All".
  check("normalizeWindowHours(24) = 24", normalizeWindowHours(24) === 24);
  check("normalizeWindowHours(12) = 12", normalizeWindowHours(12) === 12);
  check("normalizeWindowHours(48) = 48", normalizeWindowHours(48) === 48);
  check("normalizeWindowHours(null) = null (All)", normalizeWindowHours(null) === null);
  check("normalizeWindowHours(undefined) = null (safe default = All)", normalizeWindowHours(undefined) === null);
  check("normalizeWindowHours(36) = null (not an offered option → All)", normalizeWindowHours(36) === null);
  check('normalizeWindowHours("24") = null (string is not a valid option)', normalizeWindowHours("24") === null);

  // Cutoff resolution: bounded windows produce a cutoff `hours` ago; All = null.
  const NOW = Date.UTC(2026, 5, 3, 12, 0, 0); // fixed instant for determinism
  check("24h cutoff = exactly 24h before now", resolveWindowCutoff(24, NOW)!.getTime() === NOW - 24 * 3600_000);
  check("12h cutoff = exactly 12h before now", resolveWindowCutoff(12, NOW)!.getTime() === NOW - 12 * 3600_000);
  check("48h cutoff = exactly 48h before now", resolveWindowCutoff(48, NOW)!.getTime() === NOW - 48 * 3600_000);
  check("All (null) cutoff = null (no lower bound)", resolveWindowCutoff(null, NOW) === null);

  // The cutoff partitions rows by timestamp: a row exactly AT the cutoff is IN
  // (gte), a row 1ms older is OUT; under "All" every row is IN.
  {
    const cutoff = resolveWindowCutoff(24, NOW)!; // 24h ago
    const atCutoff = new Date(cutoff.getTime());
    const justInside = new Date(cutoff.getTime() + 1);
    const justOutside = new Date(cutoff.getTime() - 1);
    const wayOld = new Date(NOW - 72 * 3600_000); // 72h ago
    const recent = new Date(NOW - 1 * 3600_000); // 1h ago
    check("row exactly at the cutoff is IN-window (>= is inclusive)", inWindow(atCutoff, cutoff));
    check("row 1ms after the cutoff is IN-window", inWindow(justInside, cutoff));
    check("row 1ms before the cutoff is OUT-of-window", !inWindow(justOutside, cutoff));
    check("row 72h old is OUT of a 24h window", !inWindow(wayOld, cutoff));
    check("row 1h old is IN a 24h window", inWindow(recent, cutoff));
    // Under "All" (null cutoff) even the 72h-old row counts.
    check('under "All", a 72h-old row is IN-window', inWindow(wayOld, null));
  }

  // The window bounds the DELETE/SNAPSHOT/COUNTER sets together: only in-window
  // rows feed the balance clawback + the lifetime-counter decrements. Mixed
  // recent+old gameplay: a 24h window must ignore the old rows entirely.
  {
    const cutoff = resolveWindowCutoff(24, NOW)!;
    const legs = [
      { type: "pack_opening", amount: 50, created_at: new Date(NOW - 2 * 3600_000) }, // IN
      { type: "battle_refund", amount: 120, created_at: new Date(NOW - 3 * 3600_000) }, // IN (payout)
      { type: "pack_opening", amount: 999, created_at: new Date(NOW - 50 * 3600_000) }, // OUT (old)
      { type: "battle_refund", amount: 777, created_at: new Date(NOW - 50 * 3600_000) }, // OUT (old)
    ];
    const windowedLegs = legs.filter((l) => inWindow(l.created_at, cutoff));
    const inv = [
      { value: 75, obtained_at: new Date(NOW - 2 * 3600_000) }, // IN
      { value: 500, obtained_at: new Date(NOW - 60 * 3600_000) }, // OUT (old)
    ];
    const windowedInv = inv.filter((r) => inWindow(r.obtained_at, cutoff));
    const windowedInvValue = windowedInv.reduce((a, r) => a + r.value, 0);

    check("24h window keeps only the 2 in-window legs (drops 2 old legs)", windowedLegs.length === 2);
    check("24h window keeps only the 1 in-window won card (drops the old $500)", windowedInv.length === 1);
    // Balance clawback over the WINDOWED legs = the in-window payout (120) only;
    // the old $777 payout must NOT be clawed back.
    check(
      "windowed balance clawback = 120 (in-window payout only; old 777 ignored)",
      wagerBalanceReduction(windowedLegs.map((l) => ({ type: l.type, amount: l.amount })), 1000) === 120,
    );
    // Counter decrements over the WINDOWED set: wagered −= 50 (the one in-window
    // pack_opening, NOT the old 999); won −= 120 + 75 (in-window payout + card,
    // NOT the old 777 + 500).
    const r = wagerCounterReductions(
      windowedLegs.map((l) => ({ type: l.type, amount: l.amount })),
      windowedInvValue,
      10_000,
      10_000,
    );
    check("windowed total_wagered reduction = 50 (old 999 leg excluded)", r.totalWageredReduction === 50);
    check("windowed total_won reduction = 195 (in-window 120 + 75; old 777/500 excluded)", r.totalWonReduction === 195);
  }

  // Adjustments wipe: the owner's two stuck DEBITS scenario.
  check(
    "adj wipe: two DEBITS (−17000, −17.88) remove $0 from balance — stays $140.67",
    adjBalanceReduction(
      [
        { amount: -17000 },
        { amount: -17.88 },
      ],
      140.67,
    ) === 0,
  );
  check(
    "adj wipe: a CREDIT claws back its amount (clamped)",
    adjBalanceReduction([{ amount: 50 }, { amount: -17.88 }], 140.67) === 50,
  );
  check(
    "adj wipe: mixed credit+debit only subtracts the credit (debit never adds back)",
    adjBalanceReduction([{ amount: 100 }, { amount: -17000 }], 140.67) === 100,
  );
  check(
    "adj wipe: credit clawback clamps at available balance",
    adjBalanceReduction([{ amount: 9999 }], 140.67) === 140.67,
  );

  // Restore symmetry: re-add == balance_before − balance_after.
  console.log("\n── PURE: restore symmetry (re-add = before − after) ──");
  const before = 140.67;
  const reduction = adjBalanceReduction([{ amount: 100 }, { amount: -50 }], before);
  const after = before - reduction;
  check("adj restore re-adds exactly before − after", before - after === reduction);
  check("adj debit-only batch restores $0 (balance never moved)", adjBalanceReduction([{ amount: -17000 }], before) === 0);
}

async function dbChecks(db: PrismaClient) {
  // ── Rolled-back: adjustments wipe deletes credits AND debits ──
  console.log("\n── DB (rolled back): adjustments delete credits + debits ──");
  const aSuffix = Date.now().toString(36);
  const aUser = `adjw-${aSuffix}`;
  try {
    await db.$transaction(async (tx) => {
      await tx.user.create({ data: { id: aUser, email: `${aUser}@x.invalid`, username: aUser, role: "user" } });
      await tx.balances.create({ data: { user_id: aUser, available_balance: 140.67 } });
      const credit = await tx.ledger_transactions.create({
        data: { user_id: aUser, type: "admin_balance_adjustment", amount: 100, balance_before: 40.67, balance_after: 140.67, status: "completed", description: "Admin adjustment: content giveaway" },
      });
      const debit1 = await tx.ledger_transactions.create({
        data: { user_id: aUser, type: "admin_balance_adjustment", amount: -17000, balance_before: 17140.67, balance_after: 140.67, status: "completed", description: "Admin adjustment: correction" },
      });
      const debit2 = await tx.ledger_transactions.create({
        data: { user_id: aUser, type: "admin_balance_adjustment", amount: -17.88, balance_before: 158.55, balance_after: 140.67, status: "completed", description: "Admin adjustment: small correction" },
      });

      const ids = [credit.id, debit1.id, debit2.id];
      const rows = await tx.ledger_transactions.findMany({ where: { id: { in: ids } } });
      const creditClawback = rows.reduce((a, r) => (Number(r.amount) > 0 ? a + Number(r.amount) : a), 0);
      const balBefore = 140.67;
      const balAfter = Math.max(0, balBefore - creditClawback);

      // DELETE all three (credits + debits) — the new behaviour.
      const del = await tx.ledger_transactions.deleteMany({
        where: { id: { in: ids }, user_id: aUser, type: "admin_balance_adjustment", status: "completed", description: { startsWith: "Admin adjustment: " } },
      });
      await tx.balances.updateMany({ where: { user_id: aUser }, data: { available_balance: balAfter } });

      check("delete removed all 3 rows (1 credit + 2 debits)", del.count === 3);
      check("credit clawback = 100", creditClawback === 100);
      check("balance after wipe = 40.67 (only the credit clawed back; debits kept)", Number((await tx.balances.findUnique({ where: { user_id: aUser } }))!.available_balance) === 40.67);

      // RESTORE — re-insert all + re-add before−after = 100.
      const reAdd = balBefore - balAfter;
      const rowsForInsert = rows.map((r) => { const c: Record<string, unknown> = {}; for (const [k, v] of Object.entries(r)) if (v !== undefined) c[k] = v; return c; });
      await tx.ledger_transactions.createMany({ data: rowsForInsert as never, skipDuplicates: true });
      const bNow = await tx.balances.findUnique({ where: { user_id: aUser } });
      await tx.balances.updateMany({ where: { user_id: aUser }, data: { available_balance: Number(bNow!.available_balance) + reAdd } });

      check("restore re-added exactly the credit clawback (100)", reAdd === 100);
      check("after restore: 3 rows back", (await tx.ledger_transactions.count({ where: { user_id: aUser, type: "admin_balance_adjustment" } })) === 3);
      check("after restore: balance back to 140.67", Number((await tx.balances.findUnique({ where: { user_id: aUser } }))!.available_balance) === 140.67);

      throw new Error(ROLLBACK);
    });
  } catch (err) {
    if (!(err instanceof Error) || err.message !== ROLLBACK) { console.error("\n  ADJ TX ERROR:", err); failures++; }
    else console.log("  [tx rolled back cleanly]");
  }

  // ── Rolled-back: wager wipe round-trip (ledger legs + inventory + PF). ──
  console.log("\n── DB (rolled back): wager wipe snapshot → delete → restore ──");
  const wSuffix = Date.now().toString(36) + "w";
  const wUser = `wagw-${wSuffix}`;
  try {
    await db.$transaction(async (tx) => {
      await tx.user.create({ data: { id: wUser, email: `${wUser}@x.invalid`, username: wUser, role: "user" } });
      // Lifetime counters seeded ABOVE the deleted sums so the wipe reduces them
      // without clamping (wager legs sum 50, payout 120 + inventory 75 = 195).
      await tx.balances.create({ data: { user_id: wUser, available_balance: 200, total_wagered: 1000, total_won: 1000 } });

      // A pack/battle game_session + a wager bet leg that references it (the FK
      // cycle: leg.game_session_id → session, session.bet_ledger_tx_id → leg).
      const packSession = await tx.game_sessions.create({
        data: { user_id: wUser, game_type: "pack", game_id: "00000000-0000-0000-0000-000000000001", bet_amount: 50 },
      });
      const wagerLeg = await tx.ledger_transactions.create({
        data: { user_id: wUser, type: "pack_opening", amount: 50, balance_before: 250, balance_after: 200, status: "completed", description: "Pack opening", game_session_id: packSession.id },
      });
      await tx.game_sessions.update({ where: { id: packSession.id }, data: { bet_ledger_tx_id: wagerLeg.id } });
      // A PAYOUT (credit) leg — battle_refund — which the wipe claws back.
      const payoutLeg = await tx.ledger_transactions.create({
        data: { user_id: wUser, type: "battle_refund", amount: 120, balance_before: 80, balance_after: 200, status: "completed", description: "Battle win" },
      });
      // balances.last_transaction_id points at the wager leg (FK we must null).
      await tx.balances.updateMany({ where: { user_id: wUser }, data: { last_transaction_id: wagerLeg.id } });

      // A won pack inventory item + its provably_fair_results child.
      const wonCard = await tx.user_inventory.create({
        data: { user_id: wUser, card_id: "00000000-0000-0000-0000-0000000000c1", value_at_obtained: 75, source_type: "pack" },
      });
      const pf = await tx.provably_fair_results.create({
        data: { game_session_id: packSession.id, inventory_item_id: wonCard.id, client_seed: "cs", server_seed_hash: "ssh", nonce: 1, ticket: 1, result_hash: "rh" },
      });
      // A non-gameplay ledger row + a NON-pack inventory row that must SURVIVE.
      const deposit = await tx.ledger_transactions.create({
        data: { user_id: wUser, type: "deposit", amount: 300, balance_before: 0, balance_after: 300, status: "completed", description: "Crypto deposit" },
      });
      const rewardCard = await tx.user_inventory.create({
        data: { user_id: wUser, card_id: "00000000-0000-0000-0000-0000000000c2", value_at_obtained: 10, source_type: "reward" },
      });

      // ── Replicate the wipe: collect, snapshot, delete FK-safe. ──
      const legRows = await tx.ledger_transactions.findMany({
        where: { user_id: wUser, type: { in: WAGER_WIPE_LEDGER_TYPES as never } },
      });
      const invRows = await tx.user_inventory.findMany({
        where: { user_id: wUser, source_type: { in: ["pack", "battle"] as never }, withdrawal_locked_at: null },
      });
      const legIds = legRows.map((r) => r.id);
      const invIds = invRows.map((r) => r.id);
      const pfRows = await tx.provably_fair_results.findMany({ where: { inventory_item_id: { in: invIds } } });

      const balBefore = 200;
      const reduction = wagerBalanceReduction(legRows.map((r) => ({ type: String(r.type), amount: Number(r.amount) })), balBefore);
      const balAfter = balBefore - reduction;

      // Lifetime-counter reductions: the SAME composition the action uses.
      const invValue = invRows.reduce((a, r) => a + Number(r.value_at_obtained), 0);
      const balPre = (await tx.balances.findUnique({ where: { user_id: wUser } }))!;
      const wageredBefore = Number(balPre.total_wagered);
      const wonBefore = Number(balPre.total_won);
      const { totalWageredReduction, totalWonReduction } = wagerCounterReductions(
        legRows.map((r) => ({ type: String(r.type), amount: Number(r.amount) })),
        invValue,
        wageredBefore,
        wonBefore,
      );

      check("collected 2 wager+payout legs (pack_opening + battle_refund)", legRows.length === 2);
      check("collected 1 won pack inventory item", invRows.length === 1);
      check("collected 1 provably_fair_results child", pfRows.length === 1);
      check("wager-wipe balance reduction = 120 (payout leg only; wager leg kept)", reduction === 120);
      check("total_wagered reduction = 50 (the one pack_opening wager leg)", totalWageredReduction === 50);
      check("total_won reduction = 195 (battle_refund 120 + won card 75)", totalWonReduction === 195);

      // FK-safe delete: null cross pointers, delete PF, legs, inventory.
      await tx.game_sessions.updateMany({ where: { bet_ledger_tx_id: { in: legIds } }, data: { bet_ledger_tx_id: null } });
      await tx.balances.updateMany({ where: { user_id: wUser, last_transaction_id: { in: legIds } }, data: { last_transaction_id: null } });
      await tx.provably_fair_results.deleteMany({ where: { inventory_item_id: { in: invIds } } });
      const legDel = await tx.ledger_transactions.deleteMany({ where: { id: { in: legIds }, user_id: wUser, type: { in: WAGER_WIPE_LEDGER_TYPES as never } } });
      const invDel = await tx.user_inventory.deleteMany({ where: { id: { in: invIds }, user_id: wUser, source_type: { in: ["pack", "battle"] as never }, withdrawal_locked_at: null } });
      // One balances write: clamped clawback + both counter decrements (mirrors
      // the action's single optimistic-locked update).
      await tx.balances.updateMany({
        where: { user_id: wUser },
        data: {
          available_balance: balAfter,
          total_wagered: wageredBefore - totalWageredReduction,
          total_won: wonBefore - totalWonReduction,
        },
      });

      check("deleted exactly 2 ledger legs", legDel.count === 2);
      check("deleted exactly 1 inventory row", invDel.count === 1);
      check("after delete: 0 wager/payout legs remain", (await tx.ledger_transactions.count({ where: { user_id: wUser, type: { in: WAGER_WIPE_LEDGER_TYPES as never } } })) === 0);
      check("after delete: the DEPOSIT row survived (not gameplay)", (await tx.ledger_transactions.findUnique({ where: { id: deposit.id } })) != null);
      check("after delete: the REWARD inventory survived (not pack/battle)", (await tx.user_inventory.findUnique({ where: { id: rewardCard.id } })) != null);
      check("after delete: the game_session SHELL survived (bet pointer nulled)", (await tx.game_sessions.findUnique({ where: { id: packSession.id } })) != null);
      check("after delete: session.bet_ledger_tx_id is null", (await tx.game_sessions.findUnique({ where: { id: packSession.id } }))!.bet_ledger_tx_id === null);
      check("after delete: balance = 80 (only payout clawed back)", Number((await tx.balances.findUnique({ where: { user_id: wUser } }))!.available_balance) === 80);
      {
        const bDel = (await tx.balances.findUnique({ where: { user_id: wUser } }))!;
        check("after delete: total_wagered = 950 (1000 − 50)", Number(bDel.total_wagered) === 950);
        check("after delete: total_won = 805 (1000 − 195)", Number(bDel.total_won) === 805);
      }

      // ── RESTORE: re-insert legs, inventory, PF (after inv), re-add balance +
      // both lifetime counters (additively to the live values — mirrors the
      // action's single optimistic-locked re-add). ──
      const strip = (r: Record<string, unknown>) => { const c: Record<string, unknown> = {}; for (const [k, v] of Object.entries(r)) if (v !== undefined) c[k] = v; return c; };
      await tx.ledger_transactions.createMany({ data: legRows.map(strip) as never, skipDuplicates: true });
      await tx.user_inventory.createMany({ data: invRows.map(strip) as never, skipDuplicates: true });
      await tx.provably_fair_results.createMany({ data: pfRows.map(strip) as never, skipDuplicates: true });
      const bNow = await tx.balances.findUnique({ where: { user_id: wUser } });
      await tx.balances.updateMany({
        where: { user_id: wUser },
        data: {
          available_balance: Number(bNow!.available_balance) + reduction,
          total_wagered: Number(bNow!.total_wagered) + totalWageredReduction,
          total_won: Number(bNow!.total_won) + totalWonReduction,
        },
      });

      check("after restore: 2 wager/payout legs back", (await tx.ledger_transactions.count({ where: { user_id: wUser, type: { in: WAGER_WIPE_LEDGER_TYPES as never } } })) === 2);
      check("after restore: 1 won pack inventory back", (await tx.user_inventory.count({ where: { user_id: wUser, source_type: { in: ["pack", "battle"] as never } } })) === 1);
      check("after restore: 1 provably_fair_results back", (await tx.provably_fair_results.findUnique({ where: { id: pf.id } })) != null);
      check("after restore: balance back to 200", Number((await tx.balances.findUnique({ where: { user_id: wUser } }))!.available_balance) === 200);
      {
        const bRes = (await tx.balances.findUnique({ where: { user_id: wUser } }))!;
        check("after restore: total_wagered back to 1000", Number(bRes.total_wagered) === 1000);
        check("after restore: total_won back to 1000", Number(bRes.total_won) === 1000);
      }

      throw new Error(ROLLBACK);
    });
  } catch (err) {
    if (!(err instanceof Error) || err.message !== ROLLBACK) { console.error("\n  WAGER TX ERROR:", err); failures++; }
    else console.log("  [tx rolled back cleanly]");
  }

  // ── Rolled-back: WINDOWED wager wipe — the window bounds the deleted /
  // snapshotted / counter-decremented sets; out-of-window gameplay SURVIVES. ──
  console.log("\n── DB (rolled back): WINDOWED wager wipe (24h) bounds the delete ──");
  const winSuffix = Date.now().toString(36) + "win";
  const winUser = `wagwin-${winSuffix}`;
  // 24h window relative to a fixed "now": rows ≤ now and ≥ (now − 24h) are IN.
  const NOW = new Date();
  const cutoff = resolveWindowCutoff(24, NOW.getTime())!; // 24h ago
  const recentTs = new Date(NOW.getTime() - 2 * 3600_000); // 2h ago  → IN
  const oldTs = new Date(NOW.getTime() - 50 * 3600_000); // 50h ago → OUT
  try {
    await db.$transaction(async (tx) => {
      await tx.user.create({ data: { id: winUser, email: `${winUser}@x.invalid`, username: winUser, role: "user" } });
      // Counters seeded high so neither decrement clamps.
      await tx.balances.create({ data: { user_id: winUser, available_balance: 1000, total_wagered: 10_000, total_won: 10_000 } });

      // RECENT (in-window) gameplay: one pack_opening wager (50) + one
      // battle_refund payout (120) + one won pack card (75) all stamped 2h ago.
      const recentSession = await tx.game_sessions.create({
        data: { user_id: winUser, game_type: "pack", game_id: "00000000-0000-0000-0000-000000000011", bet_amount: 50, created_at: recentTs },
      });
      const recentWager = await tx.ledger_transactions.create({
        data: { user_id: winUser, type: "pack_opening", amount: 50, balance_before: 1050, balance_after: 1000, status: "completed", description: "Pack opening (recent)", game_session_id: recentSession.id, created_at: recentTs },
      });
      await tx.game_sessions.update({ where: { id: recentSession.id }, data: { bet_ledger_tx_id: recentWager.id } });
      const recentPayout = await tx.ledger_transactions.create({
        data: { user_id: winUser, type: "battle_refund", amount: 120, balance_before: 880, balance_after: 1000, status: "completed", description: "Battle win (recent)", created_at: recentTs },
      });
      const recentCard = await tx.user_inventory.create({
        data: { user_id: winUser, card_id: "00000000-0000-0000-0000-0000000000d1", value_at_obtained: 75, source_type: "pack", obtained_at: recentTs },
      });
      const recentPf = await tx.provably_fair_results.create({
        data: { game_session_id: recentSession.id, inventory_item_id: recentCard.id, client_seed: "cs", server_seed_hash: "ssh", nonce: 1, ticket: 1, result_hash: "rh" },
      });

      // OLD (out-of-window) gameplay: a pack_opening wager (999) + a
      // battle_refund payout (777) + a won pack card (500) stamped 50h ago.
      // These must be IGNORED entirely by a 24h wipe.
      const oldSession = await tx.game_sessions.create({
        data: { user_id: winUser, game_type: "pack", game_id: "00000000-0000-0000-0000-000000000012", bet_amount: 999, created_at: oldTs },
      });
      const oldWager = await tx.ledger_transactions.create({
        data: { user_id: winUser, type: "pack_opening", amount: 999, balance_before: 1999, balance_after: 1000, status: "completed", description: "Pack opening (old)", game_session_id: oldSession.id, created_at: oldTs },
      });
      await tx.game_sessions.update({ where: { id: oldSession.id }, data: { bet_ledger_tx_id: oldWager.id } });
      const oldPayout = await tx.ledger_transactions.create({
        data: { user_id: winUser, type: "battle_refund", amount: 777, balance_before: 223, balance_after: 1000, status: "completed", description: "Battle win (old)", created_at: oldTs },
      });
      const oldCard = await tx.user_inventory.create({
        data: { user_id: winUser, card_id: "00000000-0000-0000-0000-0000000000d2", value_at_obtained: 500, source_type: "pack", obtained_at: oldTs },
      });

      // ── Replicate the WINDOWED wipe: collect ONLY in-window rows (ledger by
      // created_at, inventory by obtained_at, both ≥ cutoff). ──
      const legRows = await tx.ledger_transactions.findMany({
        where: { user_id: winUser, type: { in: WAGER_WIPE_LEDGER_TYPES as never }, created_at: { gte: cutoff } },
      });
      const invRows = await tx.user_inventory.findMany({
        where: { user_id: winUser, source_type: { in: ["pack", "battle"] as never }, withdrawal_locked_at: null, obtained_at: { gte: cutoff } },
      });
      const legIds = legRows.map((r) => r.id);
      const invIds = invRows.map((r) => r.id);
      const pfRows = await tx.provably_fair_results.findMany({ where: { inventory_item_id: { in: invIds } } });

      check("24h collect: exactly 2 in-window legs (recent wager + payout)", legRows.length === 2);
      check("24h collect: the OLD wager leg is NOT collected", !legIds.includes(oldWager.id));
      check("24h collect: the OLD payout leg is NOT collected", !legIds.includes(oldPayout.id));
      check("24h collect: exactly 1 in-window won card", invRows.length === 1);
      check("24h collect: the OLD won card is NOT collected", !invIds.includes(oldCard.id));
      check("24h collect: 1 PF child (of the recent card only)", pfRows.length === 1);

      const balBefore = 1000;
      const reduction = wagerBalanceReduction(legRows.map((r) => ({ type: String(r.type), amount: Number(r.amount) })), balBefore);
      const invValue = invRows.reduce((a, r) => a + Number(r.value_at_obtained), 0);
      const balPre = (await tx.balances.findUnique({ where: { user_id: winUser } }))!;
      const { totalWageredReduction, totalWonReduction } = wagerCounterReductions(
        legRows.map((r) => ({ type: String(r.type), amount: Number(r.amount) })),
        invValue,
        Number(balPre.total_wagered),
        Number(balPre.total_won),
      );
      check("24h balance clawback = 120 (recent payout only; old 777 ignored)", reduction === 120);
      check("24h total_wagered reduction = 50 (recent wager only; old 999 ignored)", totalWageredReduction === 50);
      check("24h total_won reduction = 195 (recent payout 120 + recent card 75; old 777/500 ignored)", totalWonReduction === 195);

      // FK-safe windowed delete: null cross pointers for the in-window legs,
      // delete in-window PF / legs / inventory, then the single balances write.
      await tx.game_sessions.updateMany({ where: { bet_ledger_tx_id: { in: legIds } }, data: { bet_ledger_tx_id: null } });
      await tx.balances.updateMany({ where: { user_id: winUser, last_transaction_id: { in: legIds } }, data: { last_transaction_id: null } });
      await tx.provably_fair_results.deleteMany({ where: { inventory_item_id: { in: invIds } } });
      const legDel = await tx.ledger_transactions.deleteMany({ where: { id: { in: legIds }, user_id: winUser, type: { in: WAGER_WIPE_LEDGER_TYPES as never }, created_at: { gte: cutoff } } });
      const invDel = await tx.user_inventory.deleteMany({ where: { id: { in: invIds }, user_id: winUser, source_type: { in: ["pack", "battle"] as never }, withdrawal_locked_at: null, obtained_at: { gte: cutoff } } });
      await tx.balances.updateMany({
        where: { user_id: winUser },
        data: {
          available_balance: balBefore - reduction,
          total_wagered: Number(balPre.total_wagered) - totalWageredReduction,
          total_won: Number(balPre.total_won) - totalWonReduction,
        },
      });

      check("24h delete: exactly 2 ledger legs removed", legDel.count === 2);
      check("24h delete: exactly 1 inventory row removed", invDel.count === 1);
      // The OUT-OF-WINDOW gameplay must SURVIVE untouched.
      check("24h delete: OLD wager leg survived (out of window)", (await tx.ledger_transactions.findUnique({ where: { id: oldWager.id } })) != null);
      check("24h delete: OLD payout leg survived (out of window)", (await tx.ledger_transactions.findUnique({ where: { id: oldPayout.id } })) != null);
      check("24h delete: OLD won card survived (out of window)", (await tx.user_inventory.findUnique({ where: { id: oldCard.id } })) != null);
      check("24h delete: recent wager leg gone", (await tx.ledger_transactions.findUnique({ where: { id: recentWager.id } })) == null);
      check("24h delete: recent payout leg gone", (await tx.ledger_transactions.findUnique({ where: { id: recentPayout.id } })) == null);
      check("24h delete: recent won card gone", (await tx.user_inventory.findUnique({ where: { id: recentCard.id } })) == null);
      check("24h delete: the recent session SHELL survived (bet pointer nulled)", (await tx.game_sessions.findUnique({ where: { id: recentSession.id } })) != null);
      {
        const bDel = (await tx.balances.findUnique({ where: { user_id: winUser } }))!;
        check("24h delete: balance = 880 (only the 120 recent payout clawed back)", Number(bDel.available_balance) === 880);
        check("24h delete: total_wagered = 9950 (10000 − 50; old 999 untouched)", Number(bDel.total_wagered) === 9950);
        check("24h delete: total_won = 9805 (10000 − 195; old 777/500 untouched)", Number(bDel.total_won) === 9805);
      }

      // RESTORE re-adds EXACTLY the windowed set (rows + the recorded
      // reductions), additively to the live values.
      const strip = (r: Record<string, unknown>) => { const c: Record<string, unknown> = {}; for (const [k, v] of Object.entries(r)) if (v !== undefined) c[k] = v; return c; };
      await tx.ledger_transactions.createMany({ data: legRows.map(strip) as never, skipDuplicates: true });
      await tx.user_inventory.createMany({ data: invRows.map(strip) as never, skipDuplicates: true });
      await tx.provably_fair_results.createMany({ data: pfRows.map(strip) as never, skipDuplicates: true });
      const bNow = (await tx.balances.findUnique({ where: { user_id: winUser } }))!;
      await tx.balances.updateMany({
        where: { user_id: winUser },
        data: {
          available_balance: Number(bNow.available_balance) + reduction,
          total_wagered: Number(bNow.total_wagered) + totalWageredReduction,
          total_won: Number(bNow.total_won) + totalWonReduction,
        },
      });

      check("24h restore: recent wager leg back", (await tx.ledger_transactions.findUnique({ where: { id: recentWager.id } })) != null);
      check("24h restore: recent won card back", (await tx.user_inventory.findUnique({ where: { id: recentCard.id } })) != null);
      check("24h restore: recent PF child back", (await tx.provably_fair_results.findUnique({ where: { id: recentPf.id } })) != null);
      {
        const bRes = (await tx.balances.findUnique({ where: { user_id: winUser } }))!;
        check("24h restore: balance back to 1000", Number(bRes.available_balance) === 1000);
        check("24h restore: total_wagered back to 10000", Number(bRes.total_wagered) === 10_000);
        check("24h restore: total_won back to 10000", Number(bRes.total_won) === 10_000);
      }
      // Sanity: the total ledger/inventory population is the windowed set + the
      // untouched old rows (2 + 2 legs = 4; 1 + 1 cards = 2).
      check("24h restore: 4 wager/payout legs total (2 windowed back + 2 old)", (await tx.ledger_transactions.count({ where: { user_id: winUser, type: { in: WAGER_WIPE_LEDGER_TYPES as never } } })) === 4);
      check("24h restore: 2 won pack cards total (1 windowed back + 1 old)", (await tx.user_inventory.count({ where: { user_id: winUser, source_type: { in: ["pack", "battle"] as never } } })) === 2);

      throw new Error(ROLLBACK);
    });
  } catch (err) {
    if (!(err instanceof Error) || err.message !== ROLLBACK) { console.error("\n  WINDOWED WAGER TX ERROR:", err); failures++; }
    else console.log("  [tx rolled back cleanly]");
  }

  // Belt-and-braces: nothing persisted.
  for (const uid of [aUser, wUser, winUser]) {
    const ghost = await db.user.findUnique({ where: { id: uid }, select: { id: true } });
    check(`post-rollback: synthetic user ${uid} does not exist (prod untouched)`, ghost == null);
  }
}

async function main() {
  await pureChecks();

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.log("\n── DB round-trip SKIPPED: DATABASE_URL not set in this environment ──");
    console.log("   (Run where a stale-snapshot DATABASE_URL is configured to exercise the rolled-back delete/restore.)");
    console.log(`\n${failures === 0 ? "ALL PURE CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
    process.exit(failures === 0 ? 0 : 1);
  }

  const adapter = new PrismaPg({ connectionString, max: 3 });
  const db = new PrismaClient({ adapter });
  try {
    await dbChecks(db);
    console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
    await db.$disconnect();
    process.exit(failures === 0 ? 0 : 1);
  } catch (err) {
    console.error("FATAL:", err);
    await db.$disconnect();
    process.exit(1);
  }
}

void main();
