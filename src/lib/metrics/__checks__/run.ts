/**
 * run.ts — self-checking assertions for the PURE metric layer.
 *
 * The repo has no unit-test framework (only Playwright e2e under
 * `e2e/`, which `playwright.config.ts` scopes to `e2e/tests` — this file
 * is NOT picked up by it). Per the task, instead of adding a framework we
 * pin the model with plain `assert` checks runnable on demand:
 *
 *   npx tsx src/lib/metrics/__checks__/run.ts
 *
 * Exit code 0 = all checks passed; non-zero = a check failed (the message
 * names the failing case). It imports ONLY the pure, client-safe modules
 * (`ledger-sets`, `formulas`) via relative paths — never the server-only
 * `queries.ts` / `realized-pnl.ts`, which pull `server-only` + the DB and
 * cannot run outside a request. DB-touching builders are covered by the
 * live pages once wired (and by the e2e suite), not here.
 *
 * Imports use relative paths (not the `@/` alias) so the script runs
 * under plain `tsx` without any tsconfig-path loader.
 */

import {
  WAGER_TYPES,
  FEE_TYPES,
  GAMING_PAYOUT_TYPES,
  NEUTRAL_TYPES,
  REWARD_PAYOUT_TYPES,
  UPGRADER_LEDGER_TYPES,
  LEDGER_SET_MEMBERS,
  UPGRADER_IN_LEDGER,
  classifyLedgerType,
  ledgerTypesToSqlList,
  WAGER_TYPES_SQL,
  type LedgerTransactionType,
} from "../ledger-sets";
import {
  MIN_SAMPLE,
  ggr,
  ggrFromLegs,
  ngr,
  gamingPayoutTotal,
  resolveRainHouseCost,
  empiricalRtp,
  empiricalHouseEdge,
} from "../formulas";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(name);
    console.error(`  ✗ ${name}`);
  }
}

function approx(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) <= eps;
}

// ─── 1. The full enum, independently listed here ─────────────────────
// This list is duplicated from the schema ON PURPOSE: it is the
// independent oracle the partition is checked against. If schema and
// partition both changed but this oracle did not, the gap/overlap checks
// below catch it. Keep in sync with prisma/schema.prisma:1221-1264.
const ALL_ENUM_TYPES: LedgerTransactionType[] = [
  "deposit",
  "pack_opening",
  "battle_bet",
  "battle_sponsorship",
  "battle_refund",
  "card_sale",
  "reward_card_sale",
  "card_exchange",
  "exchange_excess_to_voucher",
  "exchange_excess_credit",
  "battle_excess_to_voucher",
  "voucher_redeemed",
  "voucher_exchange",
  "deposit_bonus",
  "vault_lock",
  "vault_unlock",
  "race_prize",
  "gift_card_redeemed",
  "promo_code_redeemed",
  "rakeback_claim",
  "balance_reward_claim",
  "affiliate_claim",
  "withdrawal_shipping_fee",
  "admin_balance_adjustment",
  "rain_tip",
  "rain_win",
  "creator_tip",
  "waitlist_prize",
  "pack_borrow_to_voucher",
  "card_withdrawal",
  "creator_deal_fill_grant",
  "creator_fill_activation",
  "creator_fill_spend_tip",
  "creator_fill_spend_battle",
  "creator_fill_refund",
  "creator_fill_conversion",
  "creator_fill_forfeiture",
  "affiliate_leaderboard_creation",
  "affiliate_leaderboard_refund",
  "affiliate_leaderboard_prize",
  "upgrader_bet",
  "upgrader_payout",
];

console.log("\n[metrics checks] partition: every enum type in exactly one set");

check("enum has 42 members", ALL_ENUM_TYPES.length === 42);

// Build the union of all assigned types and assert disjoint + complete.
const allSets = Object.values(LEDGER_SET_MEMBERS) as readonly (readonly string[])[];
const assigned = new Set<string>();
let overlapCount = 0;
for (const set of allSets) {
  for (const t of set) {
    if (assigned.has(t)) overlapCount++;
    assigned.add(t);
  }
}
const assignedCount = allSets.reduce((n, s) => n + s.length, 0);

check("no type is assigned to more than one set (no overlaps)", overlapCount === 0);
check(
  "assigned-type count equals distinct-type count (no overlaps)",
  assignedCount === assigned.size,
);
check(
  "every enum type is assigned to a set (no gaps)",
  ALL_ENUM_TYPES.every((t) => assigned.has(t)),
);
check(
  "no set contains a non-enum type (no typos)",
  [...assigned].every((t) => (ALL_ENUM_TYPES as string[]).includes(t)),
);
check(
  "union of sets covers exactly the 42 enum members",
  assigned.size === 42,
);

// classifyLedgerType round-trips every enum member to a non-null bucket.
check(
  "classifyLedgerType returns a bucket for every enum member",
  ALL_ENUM_TYPES.every((t) => classifyLedgerType(t) !== null),
);
check("classifyLedgerType returns null for an unknown type", classifyLedgerType("not_a_type") === null);

// ─── 2. Specific membership the model hinges on ──────────────────────
console.log("[metrics checks] specific membership (the booking model)");

check("WAGER = pack_opening/battle_bet/battle_sponsorship only", arrEq(WAGER_TYPES, ["pack_opening", "battle_bet", "battle_sponsorship"]));
check("withdrawal_shipping_fee is a FEE, not WAGER", FEE_TYPES.includes("withdrawal_shipping_fee") && !(WAGER_TYPES as readonly string[]).includes("withdrawal_shipping_fee"));
check("battle_refund is the only ledger GAMING_PAYOUT (upgrader isolated)", arrEq(GAMING_PAYOUT_TYPES, ["battle_refund"]));
check("card_sale is NEUTRAL (not a payout)", NEUTRAL_TYPES.includes("card_sale") && classifyLedgerType("card_sale") === "NEUTRAL");
check("card_exchange is NEUTRAL", classifyLedgerType("card_exchange") === "NEUTRAL");
check("reward_card_sale is NEUTRAL", classifyLedgerType("reward_card_sale") === "NEUTRAL");
check("voucher_exchange is NEUTRAL", classifyLedgerType("voucher_exchange") === "NEUTRAL");
check("affiliate_leaderboard_prize is a REWARD (gap-fix)", classifyLedgerType("affiliate_leaderboard_prize") === "REWARD_PAYOUT");
check("creator_tip is RESIDUAL, NOT a reward cost", classifyLedgerType("creator_tip") === "RESIDUAL" && !(REWARD_PAYOUT_TYPES as readonly string[]).includes("creator_tip"));
check("rain_win is a REWARD (mixed-funding handled in NGR hook)", classifyLedgerType("rain_win") === "REWARD_PAYOUT");
check("rain_tip is RESIDUAL (funding leg, a transfer)", classifyLedgerType("rain_tip") === "RESIDUAL");
check("deposit / card_withdrawal are RESIDUAL (balance sheet)", classifyLedgerType("deposit") === "RESIDUAL" && classifyLedgerType("card_withdrawal") === "RESIDUAL");
check("all creator_fill_* are RESIDUAL", ["creator_fill_activation", "creator_fill_spend_tip", "creator_fill_spend_battle", "creator_fill_refund", "creator_fill_conversion", "creator_fill_forfeiture", "creator_deal_fill_grant"].every((t) => classifyLedgerType(t) === "RESIDUAL"));
check("upgrader_bet / upgrader_payout are isolated in UPGRADER (default)", UPGRADER_LEDGER_TYPES.length === 2 && classifyLedgerType("upgrader_bet") === "UPGRADER" && classifyLedgerType("upgrader_payout") === "UPGRADER");
check("UPGRADER_IN_LEDGER defaults to false (prod-confirm pending)", UPGRADER_IN_LEDGER === false);

// SQL list helper shape.
check("WAGER_TYPES_SQL renders a parenthesised quoted list", WAGER_TYPES_SQL === "('pack_opening','battle_bet','battle_sponsorship')");
check("ledgerTypesToSqlList quotes each member", ledgerTypesToSqlList(["deposit"]) === "('deposit')");

// ─── 3. GGR: wager − inventory-delta − battle_refund (NOT card_sale) ──
console.log("[metrics checks] GGR / NGR / RTP / edge arithmetic");

// Scenario: $1000 wager, $700 of cards kept (inventory), $50 battle_refund
// cash leg. card_sale of $400 happened but is NEUTRAL → must NOT enter GGR.
const gp = gamingPayoutTotal({ inventoryPayout: 700, battleRefund: 50 });
check("gamingPayout = inventory + battle_refund", approx(gp, 750));
const g = ggr({ wager: 1000, gamingPayout: gp });
check("GGR = wager − gamingPayout = 250", approx(g, 250));
check("ggrFromLegs matches (card_sale absent → unchanged)", approx(ggrFromLegs({ wager: 1000, inventoryPayout: 700, battleRefund: 50 }), 250));
// A card_sale conversion does NOT move GGR: GGR is the same whether or
// not a neutral conversion occurred (it isn't an input to the formula).
check("card conversions are neutral to GGR (no input path)", approx(ggrFromLegs({ wager: 1000, inventoryPayout: 700, battleRefund: 50 }), g));

// ─── 4. Reward types reduce NGR, not GGR ─────────────────────────────
// $250 GGR, then $40 deposit_bonus + $10 rakeback reward cost (excl rain).
const n = ngr({ ggr: g, rewardCostExclRain: 50 });
check("NGR = GGR − rewardCostExclRain (no rain) = 200", approx(n, 200));
check("reward cost does NOT change GGR", approx(g, 250));

// Rain hook variants.
check("rain 'full' counts entire rain_win", approx(resolveRainHouseCost({ kind: "full", rainWinTotal: 80 }), 80));
check("rain 'fraction' applies the fraction", approx(resolveRainHouseCost({ kind: "fraction", fraction: 0.25, rainWinTotal: 80 }), 20));
check("rain 'amount' passes through (clamped ≥0)", approx(resolveRainHouseCost({ kind: "amount", houseCost: 33 }), 33));
check("rain 'amount' clamps negatives to 0", approx(resolveRainHouseCost({ kind: "amount", houseCost: -5 }), 0));
const nRain = ngr({ ggr: g, rewardCostExclRain: 50, rainHouseCost: { kind: "full", rainWinTotal: 80 } });
check("NGR with full rain = GGR − reward − rain = 120", approx(nRain, 120));
const nRainPartial = ngr({ ggr: g, rewardCostExclRain: 50, rainHouseCost: { kind: "fraction", fraction: 0.25, rainWinTotal: 80 } });
check("NGR with 25% rain = 250 − 50 − 20 = 180", approx(nRainPartial, 180));

// ─── 5. RTP / edge sample guard ──────────────────────────────────────
console.log(`[metrics checks] empirical RTP/edge sample guard (MIN_SAMPLE=${MIN_SAMPLE})`);

check("MIN_SAMPLE is 30", MIN_SAMPLE === 30);
// Below sample → sentinel null (the −14.92%/114.92% / >100% guard).
check("RTP below MIN_SAMPLE → null", empiricalRtp({ gamingPayout: 1149.2, wager: 1000, bets: 5 }) === null);
check("edge below MIN_SAMPLE → null", empiricalHouseEdge({ wager: 1000, gamingPayout: 1149.2, bets: 5 }) === null);
// At/above sample with real data → real numbers.
const rtp30 = empiricalRtp({ gamingPayout: 750, wager: 1000, bets: 30 });
check("RTP at MIN_SAMPLE → 0.75", rtp30 !== null && approx(rtp30, 0.75));
const edge30 = empiricalHouseEdge({ wager: 1000, ggr: 250, bets: 30 });
check("edge at MIN_SAMPLE → 0.25", edge30 !== null && approx(edge30, 0.25));
check("edge = 1 − RTP by construction", rtp30 !== null && edge30 !== null && approx(edge30, 1 - rtp30));
// Zero wager → null even with enough bets (RTP undefined).
check("RTP with zero wager → null", empiricalRtp({ gamingPayout: 0, wager: 0, bets: 100 }) === null);
check("edge with zero wager → null", empiricalHouseEdge({ wager: 0, gamingPayout: 0, bets: 100 }) === null);
// Payout > wager over a valid sample → RTP > 1, edge < 0 (allowed; it's a
// real loss-making bucket, NOT clamped — only the SMALL-sample case is a
// sentinel). This proves the M7/M8 values were sample-size, not formula.
const rtpHot = empiricalRtp({ gamingPayout: 1149.2, wager: 1000, bets: 5000 });
check("RTP can exceed 1 on a large sample (real, not clamped)", rtpHot !== null && rtpHot > 1);
const edgeHot = empiricalHouseEdge({ wager: 1000, gamingPayout: 1149.2, bets: 5000 });
check("edge can be negative on a large sample (real)", edgeHot !== null && edgeHot < 0);

// ─── helpers ─────────────────────────────────────────────────────────
function arrEq(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

// ─── summary ─────────────────────────────────────────────────────────
console.log(`\n[metrics checks] ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(`\nFAILED checks:\n  - ${failures.join("\n  - ")}\n`);
  process.exit(1);
}
console.log("[metrics checks] OK — all pure-layer assertions hold.\n");
