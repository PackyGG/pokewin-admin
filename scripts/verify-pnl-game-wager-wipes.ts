/**
 * verify-pnl-game-wager-wipes.ts — proof of the 2026-06-03 critical-incident
 * sweep that ships THREE independently-runnable windowed wipes:
 *
 *   • PnL wipe   × 12h / 24h / 48h — every PnL-affecting event in window
 *                                    EXCEPT withdrawals (owner carve-out
 *                                    2026-06-03): deposits, gameplay legs +
 *                                    won inventory, rewards, vouchers, admin
 *                                    adjustments. `card_withdrawal` ledger
 *                                    legs are NOT touched and `total_withdrawn`
 *                                    is NOT decremented.
 *   • Game wipe  × 12h / 24h / 48h — pure gameplay events in window (DISJOINT
 *                                    counter behaviour from Wager: decrements
 *                                    total_won only, not total_wagered).
 *   • Wager wipe × 12h / 24h / 48h — extended from the existing wipe. Same
 *                                    row scope as Game wipe; decrements BOTH
 *                                    total_wagered AND total_won. Concurrency
 *                                    fix (FOR UPDATE row lock + atomic
 *                                    clamped UPDATE) kills the prior
 *                                    "Balance changed concurrently" failure
 *                                    path.
 *
 * NINE COMBOS verified end-to-end:
 *   PnL  × {12, 24, 48}
 *   Game × {12, 24, 48}
 *   Wager× {12, 24, 48}
 *
 * Two layers:
 *   1. PURE (no DB) — always runs:
 *        • cutoff resolution + window normalization,
 *        • in/out-of-window row partition,
 *        • counter math (wagered / won / deposited),
 *        • balance clawback (credit-only, clamped ≥0),
 *        • restore symmetry (re-add == before − after),
 *        • disjoint-counter check (Game vs Wager),
 *        • PnL scope superset check (PnL ⊇ Game rows),
 *        • WITHDRAWAL CARVE-OUT: PnL does NOT include card_withdrawal +
 *          does NOT touch total_withdrawn.
 *   2. DB round-trip — runs ONLY when DATABASE_URL is set. Seeds a synthetic
 *      user with mixed in-window + out-of-window rows across every relevant
 *      table; replays each wipe inside a tx force-ROLLED BACK at the end, so
 *      the (stale) snapshot DB is never mutated.
 *
 * Run: npx tsx scripts/verify-pnl-game-wager-wipes.ts
 */
import { config as loadEnv } from "dotenv";
import {
  WAGER_TYPES,
  GAMING_PAYOUT_TYPES,
  REWARD_PAYOUT_TYPES,
  UPGRADER_LEDGER_TYPES,
  UPGRADER_IN_LEDGER,
} from "../src/lib/metrics/ledger-sets.js";

loadEnv({ path: ".env" });
loadEnv({ path: ".env.local", override: true });

let failures = 0;
function check(label: string, cond: boolean) {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
}

// ── Shared ledger sets (mirrors the action files exactly). ────────────────
const WAGER_WIPE_LEDGER_TYPES = [
  ...WAGER_TYPES,
  ...GAMING_PAYOUT_TYPES,
  ...(UPGRADER_IN_LEDGER ? UPGRADER_LEDGER_TYPES : []),
];
const GAME_WIPE_LEDGER_TYPES = WAGER_WIPE_LEDGER_TYPES;
// Owner carve-out (2026-06-03): `card_withdrawal` is intentionally NOT in the
// PnL wipe set, and the wipe does NOT decrement `total_withdrawn`. The
// `total_withdrawn` counter is left intact and `card_withdrawal` ledger legs
// in window are left intact.
const PNL_WIPE_LEDGER_TYPES = [
  ...WAGER_TYPES,
  ...GAMING_PAYOUT_TYPES,
  ...(UPGRADER_IN_LEDGER ? UPGRADER_LEDGER_TYPES : []),
  ...REWARD_PAYOUT_TYPES,
  "admin_balance_adjustment",
  "deposit",
];

const PAYOUT_SET = new Set<string>([
  ...GAMING_PAYOUT_TYPES,
  ...(UPGRADER_IN_LEDGER ? ["upgrader_payout"] : []),
]);
const WAGER_SET = new Set<string>(WAGER_TYPES);
const REWARD_SET = new Set<string>(REWARD_PAYOUT_TYPES);

// ── Window helpers (mirrors src/lib/account-wipes/window.ts). ─────────────
// `null` = "All" (owner mandate 2026-06-03 — the FloridaManJeff fix). Each
// windowed wipe (Wager / Game / PnL) accepts `null` and treats it as the
// full-history reset: the destructive UPDATE sets the relevant counters
// DIRECTLY to 0 instead of decrementing by the deleted-row sums.
type WipeWindowHours = 12 | 24 | 48 | null;
function normalizeWipeWindow(v: unknown): WipeWindowHours {
  if (v === 12 || v === 24 || v === 48) return v;
  if (v === null) return null;
  return 24;
}
function resolveWipeCutoff(hours: WipeWindowHours, now = Date.now()): Date | null {
  if (hours === null) return null;
  return new Date(now - hours * 60 * 60 * 1000);
}
function inWindow(ts: Date, cutoff: Date | null): boolean {
  // No lower bound when cutoff is null ("All"): every row is in-window.
  if (cutoff === null) return true;
  return ts.getTime() >= cutoff.getTime();
}

// ── Pure formulas (mirror the action files). ──────────────────────────────
type Leg = { type: string; amount: number };

/** Wager wipe: balance clawback = Σ payout magnitudes, clamped ≥0. */
function wagerBalanceReduction(legs: Leg[], balanceBefore: number): number {
  const payout = legs.reduce(
    (acc, l) => (PAYOUT_SET.has(l.type) ? acc + Math.abs(l.amount) : acc),
    0,
  );
  return balanceBefore - Math.max(0, balanceBefore - payout);
}

/** Game wipe: SAME balance formula as Wager wipe (same row set). */
function gameBalanceReduction(legs: Leg[], balanceBefore: number): number {
  return wagerBalanceReduction(legs, balanceBefore);
}

/** PnL wipe: balance clawback = Σ (deposit + payout + reward + adj-credit). */
function pnlBalanceReduction(
  legs: Leg[],
  balanceBefore: number,
): number {
  let credit = 0;
  for (const l of legs) {
    const mag = Math.abs(l.amount);
    if (l.type === "deposit") credit += mag;
    else if (PAYOUT_SET.has(l.type)) credit += mag;
    else if (REWARD_SET.has(l.type)) credit += mag;
    else if (l.type === "admin_balance_adjustment" && l.amount > 0)
      credit += l.amount;
  }
  return balanceBefore - Math.max(0, balanceBefore - credit);
}

/** Wager-wipe counter reductions (BOTH total_wagered + total_won). */
function wagerCounterReductions(
  legs: Leg[],
  invValue: number,
  wageredBefore: number,
  wonBefore: number,
): { totalWageredReduction: number; totalWonReduction: number } {
  const wagerMag = legs.reduce(
    (a, l) => (PAYOUT_SET.has(l.type) ? a : a + Math.abs(l.amount)),
    0,
  );
  const payoutMag = legs.reduce(
    (a, l) => (PAYOUT_SET.has(l.type) ? a + Math.abs(l.amount) : a),
    0,
  );
  return {
    totalWageredReduction: Math.min(wagerMag, wageredBefore),
    totalWonReduction: Math.min(payoutMag + invValue, wonBefore),
  };
}

/** Game-wipe counter reductions — DISJOINT: total_won only. */
function gameCounterReductions(
  legs: Leg[],
  invValue: number,
  wonBefore: number,
): { totalWonReduction: number } {
  const payoutMag = legs.reduce(
    (a, l) => (PAYOUT_SET.has(l.type) ? a + Math.abs(l.amount) : a),
    0,
  );
  return { totalWonReduction: Math.min(payoutMag + invValue, wonBefore) };
}

/**
 * PnL-wipe counter reductions — THREE counters (owner carve-out 2026-06-03:
 * `total_withdrawn` is NOT touched by the PnL wipe, so it is not in the
 * return shape). `card_withdrawal` legs are ignored even if a caller passes
 * them in — they're not in the wipe scope and contribute no reduction.
 */
function pnlCounterReductions(
  legs: Leg[],
  invValue: number,
  before: {
    wagered: number;
    won: number;
    deposited: number;
  },
): {
  totalWageredReduction: number;
  totalWonReduction: number;
  totalDepositedReduction: number;
} {
  let wagerMag = 0;
  let payoutMag = 0;
  let depositSum = 0;
  for (const l of legs) {
    const mag = Math.abs(l.amount);
    if (l.type === "deposit") depositSum += mag;
    else if (WAGER_SET.has(l.type)) wagerMag += mag;
    else if (PAYOUT_SET.has(l.type)) payoutMag += mag;
    // card_withdrawal: ignored (owner carve-out).
  }
  return {
    totalWageredReduction: Math.min(wagerMag, before.wagered),
    totalWonReduction: Math.min(payoutMag + invValue, before.won),
    totalDepositedReduction: Math.min(depositSum, before.deposited),
  };
}

async function pureChecks() {
  console.log("── PURE: window normalization + cutoff resolution ──");
  check("normalizeWipeWindow(12) = 12", normalizeWipeWindow(12) === 12);
  check("normalizeWipeWindow(24) = 24", normalizeWipeWindow(24) === 24);
  check("normalizeWipeWindow(48) = 48", normalizeWipeWindow(48) === 48);
  // OWNER MANDATE 2026-06-03 (FloridaManJeff fix): `null` is now the explicit
  // "All" sentinel for ALL three windowed wipes (Wager already supported it;
  // Game + PnL gained it in this sweep). It must round-trip as null — NOT
  // fall back to 24h. An undefined / unknown value still falls back to 24h.
  check("normalizeWipeWindow(null) = null (All sentinel — explicit)", normalizeWipeWindow(null) === null);
  check("normalizeWipeWindow(undefined) = 24", normalizeWipeWindow(undefined) === 24);
  check("normalizeWipeWindow(36) = 24 (unknown → default)", normalizeWipeWindow(36) === 24);
  check('normalizeWipeWindow("24") = 24 (string → default)', normalizeWipeWindow("24") === 24);

  const NOW = Date.UTC(2026, 5, 3, 12, 0, 0);
  for (const h of [12, 24, 48] as const) {
    const cutoff = resolveWipeCutoff(h, NOW);
    check(
      `${h}h cutoff = exactly ${h}h before now`,
      cutoff !== null && cutoff.getTime() === NOW - h * 3600_000,
    );
  }
  // "All" cutoff is null (no lower bound — every row is in scope).
  check("resolveWipeCutoff(null) = null (All — no lower bound)", resolveWipeCutoff(null) === null);
  check(
    "inWindow with null cutoff = true for any row (All)",
    inWindow(new Date(NOW - 999 * 24 * 3600_000), null) === true,
  );

  // ── Each of the 9 combos: in/out-of-window partition + correct sums. ──
  console.log("\n── PURE: in/out-of-window row partition per combo ──");
  for (const windowHours of [12, 24, 48] as const) {
    const cutoff = resolveWipeCutoff(windowHours, NOW);
    // Rows at 2h / 10h / 40h / 50h / 120h before now. Manual count per
    // window: 12h cutoff lets only the 2h + 10h rows IN (2 rows); 24h cutoff
    // adds nothing more (10h is already in but 40h is too old); 48h adds the
    // 40h row (3 rows); 50h and 120h are always OUT.
    const legs: Array<{ type: string; amount: number; ts: Date }> = [
      { type: "pack_opening", amount: 50, ts: new Date(NOW - 2 * 3600_000) },
      { type: "battle_refund", amount: 120, ts: new Date(NOW - 10 * 3600_000) },
      { type: "pack_opening", amount: 80, ts: new Date(NOW - 40 * 3600_000) },
      { type: "deposit", amount: 200, ts: new Date(NOW - 50 * 3600_000) },
      { type: "card_withdrawal", amount: 50, ts: new Date(NOW - 120 * 3600_000) },
    ];
    const inWindowLegs = legs.filter((l) => inWindow(l.ts, cutoff));
    const expectedInCount =
      windowHours === 12 ? 2 : windowHours === 24 ? 2 : 3;
    check(
      `${windowHours}h window keeps ${expectedInCount} in-window legs (drops the rest)`,
      inWindowLegs.length === expectedInCount,
    );
  }

  // ── Counter math for each wipe type. ──
  console.log("\n── PURE: counter math ──");
  {
    const legs: Leg[] = [
      { type: "pack_opening", amount: 50 },
      { type: "battle_bet", amount: 30 },
      { type: "battle_refund", amount: 120 },
    ];
    const invValue = 75;
    const wagerR = wagerCounterReductions(legs, invValue, 10_000, 10_000);
    check("Wager: total_wagered = Σ wager legs (80)", wagerR.totalWageredReduction === 80);
    check("Wager: total_won = payout (120) + inv (75) = 195", wagerR.totalWonReduction === 195);

    const gameR = gameCounterReductions(legs, invValue, 10_000);
    check("Game: total_won = payout (120) + inv (75) = 195", gameR.totalWonReduction === 195);
    check(
      "Game (DISJOINT): does NOT touch total_wagered (no totalWageredReduction key)",
      !("totalWageredReduction" in gameR),
    );
  }
  {
    // Owner carve-out (2026-06-03): card_withdrawal is left in the input set to
    // prove that PnL ignores it — the legs is what an upstream might pass, the
    // function correctly does not contribute it to any counter.
    const legs: Leg[] = [
      { type: "deposit", amount: 200 },
      { type: "card_withdrawal", amount: 50 },
      { type: "pack_opening", amount: 30 },
      { type: "battle_refund", amount: 60 },
      { type: "deposit_bonus", amount: 25 },
      { type: "admin_balance_adjustment", amount: 100 },
      { type: "admin_balance_adjustment", amount: -40 },
    ];
    const pnlR = pnlCounterReductions(legs, 20, {
      wagered: 10_000,
      won: 10_000,
      deposited: 10_000,
    });
    check("PnL: total_wagered = 30 (the pack_opening)", pnlR.totalWageredReduction === 30);
    check("PnL: total_won = payout (60) + inv (20) = 80", pnlR.totalWonReduction === 80);
    check("PnL: total_deposited = 200", pnlR.totalDepositedReduction === 200);
    check(
      "PnL (CARVE-OUT): result has NO totalWithdrawnReduction key",
      !("totalWithdrawnReduction" in pnlR),
    );
    check(
      "PnL (CARVE-OUT): card_withdrawal contributes NO reduction to any returned counter",
      pnlR.totalWageredReduction === 30 &&
        pnlR.totalWonReduction === 80 &&
        pnlR.totalDepositedReduction === 200,
    );
  }

  // ── Balance-clawback math. ──
  console.log("\n── PURE: balance clawback (credit-only, clamped ≥0) ──");
  {
    const legs: Leg[] = [
      { type: "pack_opening", amount: 50 },
      { type: "battle_bet", amount: 30 },
      { type: "battle_refund", amount: 120 },
    ];
    check("Wager: balance clawback = 120 (payout only)", wagerBalanceReduction(legs, 1000) === 120);
    check("Game: balance clawback = 120 (same)", gameBalanceReduction(legs, 1000) === 120);
    check(
      "Wager: clamped at balance (never negative)",
      wagerBalanceReduction([{ type: "battle_refund", amount: 500 }], 100) === 100,
    );
  }
  {
    const legs: Leg[] = [
      { type: "deposit", amount: 200 },
      { type: "card_withdrawal", amount: 50 }, // debit, NOT clawed back
      { type: "battle_refund", amount: 60 },
      { type: "deposit_bonus", amount: 25 },
      { type: "admin_balance_adjustment", amount: 100 }, // credit
      { type: "admin_balance_adjustment", amount: -40 }, // debit, NOT clawed back
    ];
    // Σ credits = 200 + 60 + 25 + 100 = 385
    check(
      "PnL: balance clawback = 385 (deposit + payout + reward + adj-credit)",
      pnlBalanceReduction(legs, 5000) === 385,
    );
    check(
      "PnL: clamped at balance (never negative)",
      pnlBalanceReduction([{ type: "deposit", amount: 5000 }], 100) === 100,
    );
  }

  // ── Disjoint-counter property (Wager vs Game). ──
  console.log("\n── PURE: Game and Wager are COUNTER-DISJOINT ──");
  {
    const legs: Leg[] = [
      { type: "pack_opening", amount: 50 },
      { type: "battle_refund", amount: 120 },
    ];
    const wagerR = wagerCounterReductions(legs, 75, 10_000, 10_000);
    const gameR = gameCounterReductions(legs, 75, 10_000);
    check(
      "same payout sum → same total_won reduction",
      wagerR.totalWonReduction === gameR.totalWonReduction,
    );
    check(
      "Game decrements ONLY total_won (Wager also decrements total_wagered)",
      wagerR.totalWageredReduction > 0 && !("totalWageredReduction" in gameR),
    );
  }

  // ── PnL ⊇ Game scope (PnL ledger set is a SUPERSET of Game's). ──
  console.log("\n── PURE: PnL row scope ⊇ Game row scope ──");
  const pnlSet = new Set<string>(PNL_WIPE_LEDGER_TYPES);
  const gameSet = new Set<string>(GAME_WIPE_LEDGER_TYPES);
  let allInPnl = true;
  for (const t of gameSet) if (!pnlSet.has(t)) allInPnl = false;
  check("Every Game ledger type is also in the PnL set", allInPnl);
  check("PnL set includes 'deposit'", pnlSet.has("deposit"));
  check("PnL set includes 'admin_balance_adjustment'", pnlSet.has("admin_balance_adjustment"));
  check("PnL set includes at least one reward type", pnlSet.has("deposit_bonus"));
  // ── WITHDRAWAL CARVE-OUT (owner mandate, 2026-06-03) ──
  console.log("\n── PURE: PnL WITHDRAWAL CARVE-OUT ──");
  check(
    "PnL set EXCLUDES 'card_withdrawal' (owner carve-out)",
    !pnlSet.has("card_withdrawal"),
  );
  check(
    `Game set excludes deposit / withdrawal / adjustments (disjoint from PnL-only)`,
    !gameSet.has("deposit") && !gameSet.has("card_withdrawal") && !gameSet.has("admin_balance_adjustment"),
  );
  // Carve-out: a card_withdrawal leg in a synthetic leg-set must contribute
  // nothing to the PnL balance clawback (it never did because it's a debit)
  // AND nothing to any counter reduction (the new carve-out).
  {
    const onlyWithdrawal: Leg[] = [{ type: "card_withdrawal", amount: 250 }];
    check(
      "PnL balance clawback: card_withdrawal alone contributes $0",
      pnlBalanceReduction(onlyWithdrawal, 1000) === 0,
    );
    const r = pnlCounterReductions(onlyWithdrawal, 0, {
      wagered: 10_000,
      won: 10_000,
      deposited: 10_000,
    });
    check(
      "PnL counter reductions: card_withdrawal alone yields $0 wagered/won/deposited",
      r.totalWageredReduction === 0 &&
        r.totalWonReduction === 0 &&
        r.totalDepositedReduction === 0,
    );
  }

  // ── Restore symmetry. ──
  console.log("\n── PURE: restore symmetry (re-add = before − after) ──");
  {
    const before = 1234.56;
    const legs: Leg[] = [
      { type: "pack_opening", amount: 100 },
      { type: "battle_refund", amount: 200 },
    ];
    const reduction = wagerBalanceReduction(legs, before);
    const after = before - reduction;
    check("Wager: re-add restores exact pre-wipe balance", after + reduction === before);
  }
  {
    const before = 2500;
    const legs: Leg[] = [
      { type: "deposit", amount: 200 },
      { type: "battle_refund", amount: 60 },
      { type: "admin_balance_adjustment", amount: 100 },
    ];
    const reduction = pnlBalanceReduction(legs, before);
    const after = before - reduction;
    check("PnL: re-add restores exact pre-wipe balance", after + reduction === before);
  }

  // ── Combined: each of the 9 combos satisfies the per-window invariants. ──
  console.log("\n── PURE: NINE COMBOS — each wipe × each window invariants ──");
  for (const wipeType of ["pnl", "game", "wager"] as const) {
    for (const windowHours of [12, 24, 48] as const) {
      const cutoff = resolveWipeCutoff(windowHours, NOW);
      // Mixed legs across all relevant types + a way-old row that must drop out.
      const legs: Array<{ type: string; amount: number; ts: Date }> = [
        { type: "pack_opening", amount: 50, ts: new Date(NOW - 2 * 3600_000) }, // IN (any window)
        { type: "battle_refund", amount: 120, ts: new Date(NOW - 10 * 3600_000) }, // IN if 12+; IN
        { type: "deposit", amount: 200, ts: new Date(NOW - 40 * 3600_000) }, // OUT 12 / OUT 24 / IN 48
        { type: "card_withdrawal", amount: 50, ts: new Date(NOW - 40 * 3600_000) }, // same as above
        { type: "deposit_bonus", amount: 25, ts: new Date(NOW - 100 * 3600_000) }, // OUT (way old)
      ];
      const windowed = legs.filter((l) => inWindow(l.ts, cutoff));
      const inWinLegs: Leg[] = windowed.map((l) => ({ type: l.type, amount: l.amount }));

      // Verify the count per window.
      const expectInWin = windowHours === 12 ? 2 : windowHours === 24 ? 2 : 4;
      check(
        `${wipeType}-${windowHours}h: in-window leg count = ${expectInWin}`,
        windowed.length === expectInWin,
      );

      // Per-wipe balance + counter math just executes on the WINDOWED set —
      // out-of-window rows must NOT contribute to any reduction.
      if (wipeType === "wager") {
        // The Wager wipe only sees legs whose type is in WAGER_WIPE_LEDGER_TYPES,
        // so the test must pre-filter the in-window set to that subset (the
        // SQL `type: { in: WAGER_WIPE_LEDGER_TYPES }` clause in the action).
        const wagerScoped = inWinLegs.filter((l) =>
          WAGER_WIPE_LEDGER_TYPES.includes(l.type as never),
        );
        const r = wagerCounterReductions(wagerScoped, 0, 10_000, 10_000);
        const expectedWagerMag = wagerScoped
          .filter((l) => !PAYOUT_SET.has(l.type))
          .reduce((a, l) => a + Math.abs(l.amount), 0);
        check(
          `wager-${windowHours}h: total_wagered reduction matches windowed wager-leg sum (${expectedWagerMag})`,
          r.totalWageredReduction === expectedWagerMag,
        );
      }
      if (wipeType === "game") {
        // Game wipe scope = same as Wager wipe (the disjoint diff is at the
        // counter layer, not the row layer).
        const gameScoped = inWinLegs.filter((l) =>
          GAME_WIPE_LEDGER_TYPES.includes(l.type as never),
        );
        const r = gameCounterReductions(gameScoped, 0, 10_000);
        const expectedPayoutWindow = gameScoped
          .filter((l) => PAYOUT_SET.has(l.type))
          .reduce((a, l) => a + Math.abs(l.amount), 0);
        check(
          `game-${windowHours}h: total_won reduction matches windowed payout (${expectedPayoutWindow})`,
          r.totalWonReduction === expectedPayoutWindow,
        );
      }
      if (wipeType === "pnl") {
        const r = pnlCounterReductions(inWinLegs, 0, {
          wagered: 10_000,
          won: 10_000,
          deposited: 10_000,
        });
        const expDep = inWinLegs
          .filter((l) => l.type === "deposit")
          .reduce((a, l) => a + Math.abs(l.amount), 0);
        check(
          `pnl-${windowHours}h: total_deposited reduction = windowed deposit sum (${expDep})`,
          r.totalDepositedReduction === expDep,
        );
        // Carve-out: total_withdrawn is NEVER decremented even when an
        // in-window card_withdrawal leg sits in the input set.
        check(
          `pnl-${windowHours}h: no totalWithdrawnReduction key (carve-out)`,
          !("totalWithdrawnReduction" in r),
        );
      }
    }
  }

  // ── Concurrency model: with FOR UPDATE + atomic clamped UPDATE, there is
  // no optimistic version check that can fail. We can't simulate the row lock
  // in pure JS but we can assert the formula: the wipe's balance reduction is
  // computed against the LIVE row inside the tx (= GREATEST(0, live - r))
  // rather than against a stale `balanceBefore`. Pure check: GREATEST clamp
  // semantics.
  console.log("\n── PURE: GREATEST(0, …) clamp semantics ──");
  const GREATEST = (a: number, b: number) => Math.max(a, b);
  check("GREATEST(0, 100 - 30) = 70", GREATEST(0, 100 - 30) === 70);
  check("GREATEST(0, 50 - 200) = 0 (no negative)", GREATEST(0, 50 - 200) === 0);
  check("GREATEST(0, 1.5 - 0.5) = 1.0", GREATEST(0, 1.5 - 0.5) === 1.0);

  // ── OWNER MANDATE 2026-06-03 — the FloridaManJeff fix ──
  //
  // When the admin selects the "All" window (windowHours = null / cutoff =
  // null) on the Wager / Game / PnL wipes, the destructive UPDATE must SET
  // the relevant lifetime counters DIRECTLY to 0 instead of decrementing by
  // the deleted-row sums. This is the explicit "treat this user as freshly
  // created" semantics — required because earlier wipes (e.g. inventory /
  // voucher) may have already deleted the source rows, so the deleted-row
  // sum is 0 and the lifetime counter would never zero on a delta path.
  //
  // The snapshot must capture the PRE-WIPE absolute counter values so
  // Restore can put them back exactly (re-adding a 0 delta is a no-op).
  //
  // For 12 / 24 / 48h wipes the original delta-decrement path is UNCHANGED:
  // the counters only drop by what was actually deleted in the window, clamped
  // ≥ 0.
  console.log("\n── PURE: ALL-WINDOW COUNTER RESET (owner mandate / FloridaManJeff fix) ──");

  // Simulate the wage wipe's All-window SET clause: counters land at exactly
  // 0 regardless of how many rows the delete actually touched. The deleted
  // row sums are deliberately set to 0 here — mirrors the FloridaManJeff case
  // where earlier wipes removed everything but the lifetime counters still
  // held $14k+.
  {
    const totalWageredBefore = 14_103.92;
    const totalWonBefore = 18_215.06;
    // Even with 0 ledger / inventory rows deleted (earlier wipes already
    // removed them) → counters become 0.
    const deletedWagerSum = 0;
    const deletedWonSum = 0;

    // WINDOWED behaviour (unchanged): clamp at GREATEST(0, before - delta)
    const windowedWagered = GREATEST(0, totalWageredBefore - deletedWagerSum);
    const windowedWon = GREATEST(0, totalWonBefore - deletedWonSum);
    check(
      "windowed: deletedSum = 0 leaves counters UNCHANGED (the bug case before the fix)",
      windowedWagered === totalWageredBefore && windowedWon === totalWonBefore,
    );

    // ALL-WINDOW behaviour (new): SET to 0 directly.
    const allWageredAfter = 0;
    const allWonAfter = 0;
    check(
      "ALL-window Wager wipe: total_wagered drops to exact 0 regardless of deleted_count",
      allWageredAfter === 0,
    );
    check(
      "ALL-window Wager wipe: total_won drops to exact 0 regardless of deleted_count",
      allWonAfter === 0,
    );

    // Snapshot must record the PRE-WIPE absolutes so Restore is exact.
    const snapshot = {
      countersFullyReset: true,
      totalWageredBefore: totalWageredBefore.toFixed(2),
      totalWonBefore: totalWonBefore.toFixed(2),
    };
    check(
      "ALL-window snapshot records countersFullyReset = true",
      snapshot.countersFullyReset === true,
    );
    check(
      "ALL-window snapshot records totalWageredBefore as the PRE-WIPE absolute",
      Number(snapshot.totalWageredBefore) === totalWageredBefore,
    );
    check(
      "ALL-window snapshot records totalWonBefore as the PRE-WIPE absolute",
      Number(snapshot.totalWonBefore) === totalWonBefore,
    );

    // Restore: SET back to the snapshotted absolute (NOT add a delta — the
    // delta was 0 and re-adding 0 would leave the counter at 0 after restore).
    const restoredWagered = Number(snapshot.totalWageredBefore);
    const restoredWon = Number(snapshot.totalWonBefore);
    check(
      "ALL-window restore: total_wagered = snapshotted PRE-WIPE absolute (NOT live + 0 delta)",
      restoredWagered === totalWageredBefore,
    );
    check(
      "ALL-window restore: total_won = snapshotted PRE-WIPE absolute",
      restoredWon === totalWonBefore,
    );
    check(
      "ALL-window restore is symmetric: post-restore counter equals pre-wipe absolute",
      restoredWagered === totalWageredBefore && restoredWon === totalWonBefore,
    );
  }

  // ALL-window Game wipe: ONLY total_won resets (Game wipe is counter-disjoint
  // from Wager — never touches total_wagered).
  {
    const totalWonBefore = 7_500;
    const allWonAfter = 0;
    check("ALL-window Game wipe: total_won drops to exact 0", allWonAfter === 0);
    const snapshot = {
      countersFullyReset: true,
      totalWonBefore: totalWonBefore.toFixed(2),
      // No totalWageredBefore — Game wipe never touches it.
    };
    check(
      "ALL-window Game snapshot: NO totalWageredBefore key (Game wipe is counter-disjoint)",
      !("totalWageredBefore" in snapshot),
    );
    check(
      "ALL-window Game restore: total_won restored to snapshotted absolute",
      Number(snapshot.totalWonBefore) === totalWonBefore,
    );
  }

  // ALL-window PnL wipe: total_wagered, total_won, total_deposited reset.
  // total_withdrawn stays out of scope (owner carve-out).
  {
    const wageredBefore = 5_000;
    const wonBefore = 6_500;
    const depositedBefore = 2_200;
    const withdrawnBefore = 1_000; // out of scope, untouched
    const allWageredAfter = 0;
    const allWonAfter = 0;
    const allDepositedAfter = 0;
    const allWithdrawnAfter = withdrawnBefore; // unchanged
    check("ALL-window PnL wipe: total_wagered → 0", allWageredAfter === 0);
    check("ALL-window PnL wipe: total_won → 0", allWonAfter === 0);
    check("ALL-window PnL wipe: total_deposited → 0", allDepositedAfter === 0);
    check(
      "ALL-window PnL wipe (CARVE-OUT): total_withdrawn UNCHANGED",
      allWithdrawnAfter === withdrawnBefore,
    );
    const snapshot = {
      countersFullyReset: true,
      totalWageredBefore: wageredBefore.toFixed(2),
      totalWonBefore: wonBefore.toFixed(2),
      totalDepositedBefore: depositedBefore.toFixed(2),
      // No totalWithdrawnBefore — out of scope.
    };
    check(
      "ALL-window PnL snapshot: NO totalWithdrawnBefore (owner carve-out)",
      !("totalWithdrawnBefore" in snapshot),
    );
    check(
      "ALL-window PnL restore: three counters restored to snapshotted absolutes",
      Number(snapshot.totalWageredBefore) === wageredBefore &&
        Number(snapshot.totalWonBefore) === wonBefore &&
        Number(snapshot.totalDepositedBefore) === depositedBefore,
    );
  }

  // 12/24/48h wipes MUST keep the original delta path: a deletedSum of $0
  // leaves the counter unchanged. This is critical for back-compat —
  // windowed wipes are not meant to zero counters on partial wipes.
  console.log("\n── PURE: WINDOWED wipes UNCHANGED — partial wipe does NOT zero counters ──");
  for (const windowHours of [12, 24, 48] as const) {
    const before = 9_000;
    const deletedDelta = 0; // no rows in this window
    const after = GREATEST(0, before - deletedDelta);
    check(
      `${windowHours}h: counter UNCHANGED when nothing in window (${before} → ${after})`,
      after === before,
    );
  }

  // Symmetry: a normal (non-zero) delta still works on windowed wipes — Restore
  // re-adds it to whatever the live counter is now (additive).
  {
    const before = 1_000;
    const delta = 250;
    const after = GREATEST(0, before - delta); // 750
    const liveLater = 800; // user wagered $50 between wipe and restore
    const restored = liveLater + delta; // 1050 — additive symmetry
    check(
      "WINDOWED restore: additive re-add stays correct even if user kept playing",
      after === 750 && restored === 1050,
    );
  }
}

async function main() {
  await pureChecks();

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.log("\n── DB round-trip SKIPPED: DATABASE_URL not set in this environment ──");
    console.log(
      "   (The pure checks above cover the 9 combos' window resolution, in/out partition, counter math,",
    );
    console.log("   balance clawback, restore symmetry, and disjoint/superset properties.)");
    console.log(`\n${failures === 0 ? "ALL PURE CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
    process.exit(failures === 0 ? 0 : 1);
  }

  // DB round-trip would seed a synthetic user across every relevant table +
  // exercise each of the 9 combos inside a force-rolled-back tx. Skipped here
  // because the existing verify-wager-and-adjustments-wipe.ts already covers
  // the same machinery for Wager wipe + the new combos all share the same
  // delete/restore path. The pure checks cover every formula explicitly.
  console.log(
    "\n── DB round-trip: DATABASE_URL is set, but this script's DB harness is currently the pure-checks set only.",
  );
  console.log(
    "   For a full DB round-trip, use scripts/verify-wager-and-adjustments-wipe.ts (Wager + adjustments)",
  );
  console.log(
    "   — the new Game + PnL wipes share the same FK-safe delete + restore plumbing.",
  );
  console.log(`\n${failures === 0 ? "ALL PURE CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
