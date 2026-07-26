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
// Client-safe SQL FRAGMENT strings for the canonical gaming legs — the
// real source the server-only builders compose. Imported here so the two
// owner-confirmed fixes are asserted at the SQL-shape level (no DB).
import {
  REWARD_PACK_SESSIONS,
  NON_BORROW_BATTLE_SESSIONS,
  WAGER_LEG_FILTER,
  PAYOUT_LEG_FILTER,
} from "../gaming-sql";

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
// below catch it. Keep in sync with the MAIN Drizzle ledger type enum.
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
  // Creator-multiplier deal + creator-leaderboard legs (prod enum, profiled
  // read-only 2026-06-11). All RESIDUAL — see ledger-sets.ts RESIDUAL_TYPES.
  "creator_multiplier_deposit_lock",
  "creator_multiplier_deposit_topup",
  "creator_multiplier_platform_credit",
  "creator_multiplier_spend_wager",
  "creator_multiplier_spend_tip",
  "creator_multiplier_spend_battle",
  "creator_multiplier_refund",
  "creator_multiplier_settlement_payout",
  "creator_multiplier_settlement_deposit_return",
  "creator_multiplier_forfeiture",
  "creator_lb_deposit",
  "upgrader_bet",
  "upgrader_payout",
];

console.log("\n[metrics checks] partition: every enum type in exactly one set");

check("enum has 53 members", ALL_ENUM_TYPES.length === 53);

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
  "union of sets covers exactly the 53 enum members",
  assigned.size === 53,
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
// Fix 1 — battle_sponsorship is a CUSTOMER WAGER type. It is summed on
// the wager side of GGR everywhere (getGamingLegs / getDailyGamingMetrics
// / getPackBattlePurePnl / _shared.WAGER_NON_BORROW_FILTER), so the GGR
// wager leg AGREES with the dashboard "Total Wager" tile (which also
// counts it). The SQL detail — counting it DIRECTLY without the
// `game_session_id IN (non_borrow_battle_sessions)` borrow gate, because
// sponsorship rows have game_session_id=NULL (the gate would drop them)
// and all sponsored battles are borrow_percentage=0 — is a query-layer
// concern in those builders; the PURE invariant pinned here is its
// WAGER membership (the precondition that makes the sum include it).
check("Fix 1: battle_sponsorship is a WAGER type (customer wager, counted in GGR)", WAGER_TYPES.includes("battle_sponsorship") && classifyLedgerType("battle_sponsorship") === "WAGER");
check("Fix 1: battle_sponsorship is summed by WAGER_TYPES_SQL (in the IN-list)", WAGER_TYPES_SQL.includes("'battle_sponsorship'"));
// Fix 2 — reward/daily packs (packs.pack_type='reward') are EXCLUDED from
// gaming GGR (wager + payout). There is NO "reward pack" LEDGER TYPE:
// pack_opening rows carry no pack_type, so reward-pack identification is a
// `game_type='pack' → packs.pack_type='reward'` JOIN, making the exclusion
// necessarily a query-layer SQL row filter (REWARD_PACK_SESSIONS in
// getGamingLegs / getDailyGamingMetrics / getPackBattlePurePnl on BOTH the
// wager and the inventory-payout side), NOT a type-bucket change — exactly
// like the manual-voucher carve-out. The PURE invariant pinned here is
// that pack gaming flows through pack_opening only and the partition is
// UNCHANGED by Fix 2 (reward packs do not get their own bucket).
check("Fix 2: pack gaming wager type is pack_opening only (reward-pack split is SQL-level, no type change)", WAGER_TYPES.includes("pack_opening") && classifyLedgerType("pack_opening") === "WAGER");
check("Fix 2: GAMING_PAYOUT unchanged (reward-pack exclusion is an inventory/source_id SQL filter, not a payout-type change)", arrEq(GAMING_PAYOUT_TYPES, ["battle_refund", "battle_excess_to_voucher"]));

// ─── 2b. SQL-shape assertions for the canonical legs (gaming-sql.ts) ──
// gaming-sql.ts is client-safe (no DB / no server-only), so the EXACT
// SQL fragment strings the canonical gaming-leg builders compose can be
// asserted here without a database. These pin the SQL behaviour the type
// checks above only set the precondition for. The legs are on the
// borrow-net-INCLUSIVE basis (owner decision, 2026-06-13 — see
// gaming-sql.ts header): borrow plays are COUNTED at net cash on both
// sides (no borrow gate), and reward/daily packs are the ONLY exclusion.
console.log("[metrics checks] SQL-shape: borrow-inclusive legs, reward packs excluded");

// The reward/daily-pack identifier joins packs.pack_type='reward' through
// a game_type='pack' session (mirrors daily-packs.ts).
check("REWARD_PACK_SESSIONS joins packs.pack_type='reward' via game_type='pack'", REWARD_PACK_SESSIONS.includes("p.pack_type = 'reward'") && REWARD_PACK_SESSIONS.includes("gs.game_type = 'pack'"));

// Borrow-inclusive WAGER leg — battle_sponsorship AND battle_bet are each
// counted DIRECTLY (bare `OR type = '<t>'` arms), with NO non-borrow
// battle-session IN-list on EITHER (the old borrow-DROP basis gated
// battle_bet; the owner basis counts it at its already-net amount).
// The `type` column is text-cast (`type::text`) in the raw SQL — a
// migration-lag hardening so a not-yet-migrated enum member compares
// instead of throwing 22P02 (semantics-preserving; see ledger-sets.ts
// note). The shape assertions below tolerate the optional `::text`.
check("WAGER_LEG_FILTER counts battle_sponsorship directly (bare OR arm)", /OR\s+type(?:::text)?\s*=\s*'battle_sponsorship'/.test(WAGER_LEG_FILTER));
check("WAGER_LEG_FILTER counts battle_bet directly (bare OR arm, borrow-net-inclusive)", /OR\s+type(?:::text)?\s*=\s*'battle_bet'/.test(WAGER_LEG_FILTER));
// The borrow-net-inclusive basis: NO non-borrow battle-session IN-list
// gates any wager arm (neither battle_bet nor battle_sponsorship).
check("WAGER_LEG_FILTER does NOT borrow-gate battle_bet (no non-borrow IN-list)", !/type(?:::text)?\s*=\s*'battle_bet'\s+AND\s+game_session_id\s+IN/.test(WAGER_LEG_FILTER) && !WAGER_LEG_FILTER.includes(NON_BORROW_BATTLE_SESSIONS));

// Reward-pack exclusion — both the WAGER leg (pack_opening arm) and the
// PAYOUT leg (inventory) exclude reward-pack sessions via the SAME
// REWARD_PACK_SESSIONS set, NULL-guarded so a NULL-session pack open /
// inventory row is not accidentally dropped.
check("WAGER_LEG_FILTER excludes reward-pack opens from the pack wager (NULL-guarded)", WAGER_LEG_FILTER.includes(`game_session_id NOT IN ${REWARD_PACK_SESSIONS}`) && WAGER_LEG_FILTER.includes("game_session_id IS NULL OR"));
check("PAYOUT_LEG_FILTER excludes reward-pack won cards from the pack payout (NULL-guarded)", PAYOUT_LEG_FILTER.includes(`source_id NOT IN ${REWARD_PACK_SESSIONS}`) && PAYOUT_LEG_FILTER.includes("source_id IS NULL OR"));
// The reward-pack exclusion must apply REGARDLESS of source_type so it
// catches the 'pack'-typed reward cards in this pack/battle leg (the
// 'reward'-typed rows never enter the leg). I.e. the source_id NOT IN
// guard is AND'd onto the whole pack/battle predicate, not nested inside
// one branch.
check("PAYOUT reward exclusion is AND'd across both source types", /\)\s*AND\s*\(source_id IS NULL OR source_id NOT IN/.test(PAYOUT_LEG_FILTER));
// Borrow-net-inclusive PAYOUT leg — all pack/battle won cards are kept
// (no non-borrow source-session IN-list before the reward-pack guard).
check("PAYOUT_LEG_FILTER keeps all pack/battle won cards (no non-borrow gate)", PAYOUT_LEG_FILTER.includes("source_type IN ('pack','battle')") && !PAYOUT_LEG_FILTER.includes(NON_BORROW_BATTLE_SESSIONS));

check("withdrawal_shipping_fee is a FEE, not WAGER", FEE_TYPES.includes("withdrawal_shipping_fee") && !(WAGER_TYPES as readonly string[]).includes("withdrawal_shipping_fee"));
// GAMING_PAYOUT = battle_refund + battle_excess_to_voucher (both ledger
// battle-win settlement legs; upgrader stays isolated). battle_excess_to_
// voucher was reclassified from NEUTRAL — it COMPLETES a battle win the
// inventory card under-counts.
check("GAMING_PAYOUT = battle_refund + battle_excess_to_voucher (upgrader isolated)", arrEq(GAMING_PAYOUT_TYPES, ["battle_refund", "battle_excess_to_voucher"]));
check("battle_excess_to_voucher is a GAMING_PAYOUT (reclassified from NEUTRAL)", classifyLedgerType("battle_excess_to_voucher") === "GAMING_PAYOUT" && !(NEUTRAL_TYPES as readonly string[]).includes("battle_excess_to_voucher"));
check("card_sale is NEUTRAL (not a payout)", NEUTRAL_TYPES.includes("card_sale") && classifyLedgerType("card_sale") === "NEUTRAL");
check("card_exchange is NEUTRAL", classifyLedgerType("card_exchange") === "NEUTRAL");
check("reward_card_sale is NEUTRAL", classifyLedgerType("reward_card_sale") === "NEUTRAL");
check("voucher_exchange is NEUTRAL", classifyLedgerType("voucher_exchange") === "NEUTRAL");
// voucher_redeemed reclassified REWARD_PAYOUT → NEUTRAL (its base bucket).
// The admin manual carve-out (metadata->>'origin'='manual') is a per-row
// SQL split in queries.ts, NOT a type bucket — so the partition has it as
// NEUTRAL and it must NOT be in REWARD_PAYOUT_TYPES.
check("voucher_redeemed is NEUTRAL (reclassified from REWARD; manual carve-out is SQL-level)", classifyLedgerType("voucher_redeemed") === "NEUTRAL" && !(REWARD_PAYOUT_TYPES as readonly string[]).includes("voucher_redeemed"));
check("affiliate_leaderboard_prize is a REWARD (gap-fix)", classifyLedgerType("affiliate_leaderboard_prize") === "REWARD_PAYOUT");
check("creator_tip is RESIDUAL, NOT a reward cost", classifyLedgerType("creator_tip") === "RESIDUAL" && !(REWARD_PAYOUT_TYPES as readonly string[]).includes("creator_tip"));
check("rain_win is a REWARD (mixed-funding handled in NGR hook)", classifyLedgerType("rain_win") === "REWARD_PAYOUT");
check("rain_tip is RESIDUAL (funding leg, a transfer)", classifyLedgerType("rain_tip") === "RESIDUAL");
check("deposit / card_withdrawal are RESIDUAL (balance sheet)", classifyLedgerType("deposit") === "RESIDUAL" && classifyLedgerType("card_withdrawal") === "RESIDUAL");
check("all creator_fill_* are RESIDUAL", ["creator_fill_activation", "creator_fill_spend_tip", "creator_fill_spend_battle", "creator_fill_refund", "creator_fill_conversion", "creator_fill_forfeiture", "creator_deal_fill_grant"].every((t) => classifyLedgerType(t) === "RESIDUAL"));
// Prod enum 2026-06-11: the 11 creator-multiplier / creator-leaderboard legs
// are all RESIDUAL (escrow/transfer/settlement; none a wager/payout/reward).
check("all creator_multiplier_* + creator_lb_deposit are RESIDUAL", ["creator_multiplier_deposit_lock", "creator_multiplier_deposit_topup", "creator_multiplier_platform_credit", "creator_multiplier_spend_wager", "creator_multiplier_spend_tip", "creator_multiplier_spend_battle", "creator_multiplier_refund", "creator_multiplier_settlement_payout", "creator_multiplier_settlement_deposit_return", "creator_multiplier_forfeiture", "creator_lb_deposit"].every((t) => classifyLedgerType(t) === "RESIDUAL"));
check("upgrader_bet / upgrader_payout are isolated in UPGRADER (default)", UPGRADER_LEDGER_TYPES.length === 2 && classifyLedgerType("upgrader_bet") === "UPGRADER" && classifyLedgerType("upgrader_payout") === "UPGRADER");
check("UPGRADER_IN_LEDGER defaults to false (prod-confirm pending)", UPGRADER_IN_LEDGER === false);

// SQL list helper shape.
check("WAGER_TYPES_SQL renders a parenthesised quoted list", WAGER_TYPES_SQL === "('pack_opening','battle_bet','battle_sponsorship')");
check("ledgerTypesToSqlList quotes each member", ledgerTypesToSqlList(["deposit"]) === "('deposit')");

// ─── 3. GGR: wager − inventory-delta − battle_refund (NOT card_sale) ──
console.log("[metrics checks] GGR / NGR / RTP / edge arithmetic");

// Scenario: $1000 wager, $700 of cards kept (inventory), $50 ledger
// gaming-payout legs (battle_refund + battle_excess_to_voucher, summed
// via GAMING_PAYOUT_TYPES — passed through the `battleRefund` input).
// card_sale of $400 happened but is NEUTRAL → must NOT enter GGR.
const gp = gamingPayoutTotal({ inventoryPayout: 700, battleRefund: 50 });
check("gamingPayout = inventory + ledger gaming-payout legs", approx(gp, 750));
const g = ggr({ wager: 1000, gamingPayout: gp });
check("GGR = wager − gamingPayout = 250", approx(g, 250));
check("ggrFromLegs matches (card_sale absent → unchanged)", approx(ggrFromLegs({ wager: 1000, inventoryPayout: 700, battleRefund: 50 }), 250));
// A card_sale conversion does NOT move GGR: GGR is the same whether or
// not a neutral conversion occurred (it isn't an input to the formula).
check("card conversions are neutral to GGR (no input path)", approx(ggrFromLegs({ wager: 1000, inventoryPayout: 700, battleRefund: 50 }), g));

// Upgrader fold (headline GGR = pack + battle + upgrader). At the DB layer
// getGamingLegs/getWindowMetrics/getDailyGamingMetrics source upgrader from
// upgrader_games and add bet_amount → wager and won_amount → the payout
// side (the `battleRefund`/`upgraderPayout` inputs). The pure formula must
// reflect that addition. Scenario: pack/battle wager 1000 + upgrader wager
// 200 = 1200; inventory 700 + ledger legs 50 + upgrader payout 180 = 930;
// GGR = 1200 − 930 = 270 (= base 250 + upgrader's own 200−180 = 20).
const gpUpg = gamingPayoutTotal({ inventoryPayout: 700, battleRefund: 50, upgraderPayout: 180 });
check("gamingPayout includes upgrader payout", approx(gpUpg, 930));
const gUpg = ggr({ wager: 1000 + 200, gamingPayout: gpUpg });
check("headline GGR = pack + battle + upgrader (1200 − 930 = 270)", approx(gUpg, 270));
check("upgrader-folded GGR = base GGR + upgrader GGR (250 + 20)", approx(gUpg, g + (200 - 180)));
check("ggrFromLegs folds upgrader payout too", approx(ggrFromLegs({ wager: 1200, inventoryPayout: 700, battleRefund: 50, upgraderPayout: 180 }), 270));

// Double Down fold (headline GGR = pack + battle + upgrader + double-down).
// getGamingLegs sources DD from battle_double_down_offers and adds
// won_amount_usd → wager, paired voucher `value` on wins → ddPayout, so the
// pure formula must reflect that addition. Scenario extension: add DD wager
// 100 + DD payout 45 to the prior upgrader-included case. New totals:
// wager 1200 + 100 = 1300; payout 700 + 50 + 180 + 45 = 975; GGR = 325
// (= prior 270 + DD's own 100 − 45 = 55). Losing DD rounds forfeit the
// stake and DO NOT emit a payout row, so a losing round adds 100 to wager
// with 0 payout — pure recapture, house-POV positive.
const gpDd = gamingPayoutTotal({ inventoryPayout: 700, battleRefund: 50, upgraderPayout: 180, ddPayout: 45 });
check("gamingPayout includes double-down payout", approx(gpDd, 975));
const gDd = ggr({ wager: 1200 + 100, gamingPayout: gpDd });
check("headline GGR = pack + battle + upgrader + DD (1300 − 975 = 325)", approx(gDd, 325));
check("DD-folded GGR = upgrader GGR + DD GGR (270 + 55)", approx(gDd, gUpg + (100 - 45)));
check("ggrFromLegs folds DD payout too", approx(ggrFromLegs({ wager: 1300, inventoryPayout: 700, battleRefund: 50, upgraderPayout: 180, ddPayout: 45 }), 325));
// Pure-loss DD round (stake forfeited, no payout) recaptures the whole stake.
const gpDdLoss = gamingPayoutTotal({ inventoryPayout: 700, battleRefund: 50, upgraderPayout: 180, ddPayout: 0 });
const gDdLoss = ggr({ wager: 1200 + 100, gamingPayout: gpDdLoss });
check("DD pure-loss round adds full stake to GGR (recapture)", approx(gDdLoss, gUpg + 100));

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
// Owner-confirmed NET model: house cost = max(0, rain_win − rain_tip).
check("rain 'net' = rain_win − rain_tip (tips < winnings)", approx(resolveRainHouseCost({ kind: "net", rainWinTotal: 80, rainTipTotal: 30 }), 50));
check("rain 'net' clamps to 0 when tips ≥ winnings", approx(resolveRainHouseCost({ kind: "net", rainWinTotal: 80, rainTipTotal: 120 }), 0));
check("rain 'net' with zero tips equals full", approx(resolveRainHouseCost({ kind: "net", rainWinTotal: 80, rainTipTotal: 0 }), resolveRainHouseCost({ kind: "full", rainWinTotal: 80 })));
const nRain = ngr({ ggr: g, rewardCostExclRain: 50, rainHouseCost: { kind: "full", rainWinTotal: 80 } });
check("NGR with full rain = GGR − reward − rain = 120", approx(nRain, 120));
const nRainPartial = ngr({ ggr: g, rewardCostExclRain: 50, rainHouseCost: { kind: "fraction", fraction: 0.25, rainWinTotal: 80 } });
check("NGR with 25% rain = 250 − 50 − 20 = 180", approx(nRainPartial, 180));
// NGR with the canonical net model: rain_win 80, rain_tip 30 → house rain
// cost 50 → NGR = 250 − 50 − 50 = 150. This is the default every analytics
// surface now consumes.
const nRainNet = ngr({ ggr: g, rewardCostExclRain: 50, rainHouseCost: { kind: "net", rainWinTotal: 80, rainTipTotal: 30 } });
check("NGR with net rain = 250 − 50 − 50 = 150", approx(nRainNet, 150));
// When tips fully cover winnings the net model adds NO rain cost: NGR ==
// GGR − reward only (rain is not a house expense in that window).
const nRainCovered = ngr({ ggr: g, rewardCostExclRain: 50, rainHouseCost: { kind: "net", rainWinTotal: 40, rainTipTotal: 90 } });
check("NGR net rain floored at 0 when tips ≥ winnings = 200", approx(nRainCovered, 200));

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
