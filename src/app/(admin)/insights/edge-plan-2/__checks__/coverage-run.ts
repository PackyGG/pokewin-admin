/**
 * Edge Plan 2.0 — pack coverage + incremental profit checks (standalone).
 *
 * Run with:
 *   npx tsx "src/app/(admin)/insights/edge-plan-2/__checks__/coverage-run.ts"
 *
 * Standalone on purpose: does NOT touch (or import) the existing
 * `__checks__/run.ts`, and imports ONLY the pure `_pack-coverage-v2` module
 * (no DB, no React, no `_model-v2` / `_baseline-v2`). Pins:
 *
 *   1. Owner example: 1% re-lock requirement vs 0.25% giveback → coverage
 *      EXACTLY 4.0 (per pack, per user, and on the aggregate).
 *   2. Profit monotone increasing in `incrementality`.
 *   3. Profit monotone increasing in `relockPct`.
 *   4. incrementality = 0 → incremental profit = −giveback exactly. This is
 *      the HONEST FLOOR, not a bug: with zero credited loss (every gated
 *      dollar would have been lost anyway and already sits in GGR), the
 *      program's only marginal effect is paying out its giveback — so the
 *      program costs exactly its giveback. Clamping this to $0 would hide
 *      that the most conservative read of the program is a pure cost.
 *   5. coverageRatio is null when giveback is $0 (never Infinity/NaN).
 *   6. Every output stays finite on degenerate inputs (NaN/Infinity/negative
 *      fields, windowDays 0, zero claimers/opens, relock 0, eligible <
 *      claimers).
 *   7. Aggregate = exact sum of the per-pack outputs (and the aggregate
 *      profit equals incrementality × Σ requiredLoss − Σ giveback).
 *
 * Exit code 0 = every check passed; 1 = at least one failure (printed).
 */

import {
  type PackCoverageInput,
  RELOCK_WINDOW_DAYS,
  computePackCoverage,
  computePackCoverageAggregate,
} from "../_pack-coverage-v2";

// ─── Tiny check harness (mirrors __checks__/run.ts, kept standalone) ────────

let passes = 0;
const failures: string[] = [];

function check(name: string, fn: () => void): void {
  try {
    fn();
    passes += 1;
    console.log(`PASS  ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`FAIL  ${name}`);
    console.error(`      ${err instanceof Error ? err.message : String(err)}`);
  }
}

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function exact(actual: number | null, expected: number | null, what: string): void {
  if (actual !== expected) {
    throw new Error(`${what}: expected exactly ${expected}, got ${actual}`);
  }
}

function approx(actual: number, expected: number, eps: number, what: string): void {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > eps) {
    throw new Error(`${what}: expected ≈${expected} (±${eps}), got ${actual}`);
  }
}

function assertAllFinite(result: ReturnType<typeof computePackCoverage>, label: string): void {
  const numeric: Record<string, number> = {
    requiredLossFlowUsd30d: result.requiredLossFlowUsd30d,
    oneTimeUnlockLossUsd: result.oneTimeUnlockLossUsd,
    givebackUsd30d: result.givebackUsd30d,
    theoreticalIncrementalProfitUsd30d: result.theoreticalIncrementalProfitUsd30d,
    "perUser.requiredLossUsd30d": result.perUser.requiredLossUsd30d,
    "perUser.givebackUsd30d": result.perUser.givebackUsd30d,
    "perUser.incrementalProfitUsd30d": result.perUser.incrementalProfitUsd30d,
    "perUser.oneTimeUnlockLossUsd": result.perUser.oneTimeUnlockLossUsd,
  };
  for (const [key, value] of Object.entries(numeric)) {
    assert(Number.isFinite(value), `${label}: ${key} not finite (${value})`);
  }
  assert(
    result.coverageRatio === null || Number.isFinite(result.coverageRatio),
    `${label}: coverageRatio neither null nor finite (${result.coverageRatio})`,
  );
  assert(
    result.perUser.claimRate === null || Number.isFinite(result.perUser.claimRate),
    `${label}: perUser.claimRate neither null nor finite (${result.perUser.claimRate})`,
  );
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

/**
 * Owner's worked example. Level requirement $40,000; re-lock gate 1% of the
 * level per 30d ($400/claimer); planned giveback 0.25% of the level per 30d
 * ($100/claimer = $25 EV × 4 opens over a 30-day window). 250 of 1,000
 * eligible users claim.
 *   requiredLossFlowUsd30d = 250 × 0.01 × 40,000 = $100,000
 *   givebackUsd30d         = 250 × 25 × 4 × 30/30 = $25,000
 *   coverageRatio          = 100,000 / 25,000 = 4.0 EXACTLY
 *   profit @ incr 0.35     = 0.35 × 100,000 − 25,000 = $10,000 / 30d
 */
const OWNER_PACK: PackCoverageInput = {
  id: "owner-example",
  levelRequirementUsd: 40_000,
  relockPct: 0.01,
  evPerOpenUsd: 25,
  opensPerWindow: 4,
  claimers: 250,
  eligibleUsers: 1_000,
  windowDays: 30,
};

// ─── 1. Owner example pinned ─────────────────────────────────────────────────

check("owner example: 1% requirement vs 0.25% giveback → coverage 4.0 exactly", () => {
  const r = computePackCoverage(OWNER_PACK, { incrementality: 0.35 });
  exact(r.requiredLossFlowUsd30d, 100_000, "requiredLossFlowUsd30d");
  exact(r.givebackUsd30d, 25_000, "givebackUsd30d");
  exact(r.coverageRatio, 4.0, "coverageRatio");
  exact(r.theoreticalIncrementalProfitUsd30d, 10_000, "profit @ incrementality 0.35");
  // Unlock-vs-relock distinction: the one-time unlock stock is reported
  // separately and is NOT the recurring flow.
  exact(r.oneTimeUnlockLossUsd, 250 * 40_000, "oneTimeUnlockLossUsd");
  assert(
    r.oneTimeUnlockLossUsd !== r.requiredLossFlowUsd30d,
    "one-time unlock must not equal (leak into) the recurring re-lock flow",
  );
  // Per-user view carries the same 4.0× story at unit scale.
  exact(r.perUser.requiredLossUsd30d, 400, "perUser.requiredLossUsd30d");
  exact(r.perUser.givebackUsd30d, 100, "perUser.givebackUsd30d");
  exact(r.perUser.incrementalProfitUsd30d, 0.35 * 400 - 100, "perUser profit");
  exact(r.perUser.claimRate, 0.25, "perUser.claimRate");
});

check("owner example: windowDays normalization (7d window → same 30d giveback)", () => {
  // Same $100/claimer/30d giveback expressed over a 7-day window:
  // EV $25 × (14/15 opens per 7d) × 30/7 = $100 per 30d.
  const weekly = computePackCoverage(
    { ...OWNER_PACK, opensPerWindow: 14 / 15, windowDays: 7 },
    { incrementality: 0.35 },
  );
  approx(weekly.givebackUsd30d, 25_000, 1e-6, "givebackUsd30d (7d window)");
  approx(weekly.coverageRatio ?? NaN, 4.0, 1e-9, "coverageRatio (7d window)");
  exact(RELOCK_WINDOW_DAYS, 30, "RELOCK_WINDOW_DAYS");
});

// ─── 2./3. Monotonicity ──────────────────────────────────────────────────────

check("profit is strictly increasing in incrementality", () => {
  const grid = [0, 0.1, 0.25, 0.5, 0.75, 1];
  let prev = -Infinity;
  for (const incrementality of grid) {
    const r = computePackCoverage(OWNER_PACK, { incrementality });
    assert(
      r.theoreticalIncrementalProfitUsd30d > prev,
      `profit not increasing at incrementality=${incrementality}: ` +
        `${r.theoreticalIncrementalProfitUsd30d} ≤ ${prev}`,
    );
    prev = r.theoreticalIncrementalProfitUsd30d;
  }
});

check("profit is strictly increasing in relockPct", () => {
  const grid = [0, 0.0025, 0.005, 0.01, 0.02, 0.05, 1];
  let prev = -Infinity;
  for (const relockPct of grid) {
    const r = computePackCoverage({ ...OWNER_PACK, relockPct }, { incrementality: 0.35 });
    assert(
      r.theoreticalIncrementalProfitUsd30d > prev,
      `profit not increasing at relockPct=${relockPct}: ` +
        `${r.theoreticalIncrementalProfitUsd30d} ≤ ${prev}`,
    );
    prev = r.theoreticalIncrementalProfitUsd30d;
  }
});

// ─── 4. Honest floor at incrementality 0 ─────────────────────────────────────

check("incrementality 0 → incremental profit = −giveback exactly (honest floor)", () => {
  // Why this is the floor and why we do NOT clamp it to $0: at
  // incrementality 0 the model credits NONE of the gated loss to the program
  // (every gated dollar would have been lost anyway — it already lives in
  // GGR). The program's only marginal effect is then the EV it pays out, so
  // its incremental P&L is exactly −giveback. Showing that negative number is
  // what keeps the model double-count-free: coverage may be 4.0× while the
  // honestly-credited profit is still a cost.
  const r = computePackCoverage(OWNER_PACK, { incrementality: 0 });
  exact(r.theoreticalIncrementalProfitUsd30d, -r.givebackUsd30d, "profit @ incr 0");
  exact(r.theoreticalIncrementalProfitUsd30d, -25_000, "profit @ incr 0 (absolute)");
  exact(r.coverageRatio, 4.0, "coverage is unchanged by incrementality");
  exact(r.perUser.incrementalProfitUsd30d, -r.perUser.givebackUsd30d, "perUser floor");
});

// ─── 5. Null-safe coverage ───────────────────────────────────────────────────

check("coverageRatio is null when giveback is $0 (no fake Infinity)", () => {
  const noOpens = computePackCoverage({ ...OWNER_PACK, opensPerWindow: 0 }, { incrementality: 0.35 });
  exact(noOpens.coverageRatio, null, "coverage with 0 opens");
  exact(noOpens.givebackUsd30d, 0, "giveback with 0 opens");
  // With $0 giveback the profit is pure credited loss — still finite.
  exact(noOpens.theoreticalIncrementalProfitUsd30d, 0.35 * 100_000, "profit with 0 opens");

  const noEv = computePackCoverage({ ...OWNER_PACK, evPerOpenUsd: 0 }, { incrementality: 0.35 });
  exact(noEv.coverageRatio, null, "coverage with $0 EV");

  const noClaimers = computePackCoverage({ ...OWNER_PACK, claimers: 0 }, { incrementality: 0.35 });
  exact(noClaimers.coverageRatio, null, "coverage with 0 claimers");
});

// ─── 6. Edge cases stay finite + honest ──────────────────────────────────────

check("zero claimers → $0 flows but per-user unit economics survive", () => {
  const r = computePackCoverage({ ...OWNER_PACK, claimers: 0 }, { incrementality: 0.35 });
  exact(r.requiredLossFlowUsd30d, 0, "requiredLossFlowUsd30d");
  exact(r.givebackUsd30d, 0, "givebackUsd30d");
  exact(r.theoreticalIncrementalProfitUsd30d, 0, "profit");
  exact(r.oneTimeUnlockLossUsd, 0, "oneTimeUnlockLossUsd");
  exact(r.perUser.requiredLossUsd30d, 400, "perUser.requiredLossUsd30d");
  exact(r.perUser.givebackUsd30d, 100, "perUser.givebackUsd30d");
  exact(r.perUser.claimRate, 0, "perUser.claimRate");
  assertAllFinite(r, "zero claimers");
});

check("relockPct 0 → coverage 0 and profit = −giveback (program is pure cost)", () => {
  const r = computePackCoverage({ ...OWNER_PACK, relockPct: 0 }, { incrementality: 1 });
  exact(r.requiredLossFlowUsd30d, 0, "requiredLossFlowUsd30d");
  exact(r.coverageRatio, 0, "coverageRatio (0 required / positive giveback)");
  exact(r.theoreticalIncrementalProfitUsd30d, -25_000, "profit");
  assertAllFinite(r, "relock 0");
});

check("eligible < claimers → claimRate > 1 reported as-is (no silent clamp)", () => {
  const r = computePackCoverage(
    { ...OWNER_PACK, claimers: 250, eligibleUsers: 100 },
    { incrementality: 0.35 },
  );
  exact(r.perUser.claimRate, 2.5, "claimRate");
  assertAllFinite(r, "eligible < claimers");
});

check("degenerate inputs (NaN/Infinity/negatives/zero window) → all outputs finite", () => {
  const degenerates: Array<[string, PackCoverageInput]> = [
    [
      "all NaN",
      {
        levelRequirementUsd: NaN, relockPct: NaN, evPerOpenUsd: NaN, opensPerWindow: NaN,
        claimers: NaN, eligibleUsers: NaN, windowDays: NaN,
      },
    ],
    [
      "all Infinity fractions+window",
      {
        levelRequirementUsd: 40_000, relockPct: Infinity, evPerOpenUsd: 25, opensPerWindow: 4,
        claimers: 250, eligibleUsers: 1_000, windowDays: Infinity,
      },
    ],
    [
      "negatives",
      {
        levelRequirementUsd: -40_000, relockPct: -0.5, evPerOpenUsd: -25, opensPerWindow: -4,
        claimers: -250, eligibleUsers: -1_000, windowDays: -30,
      },
    ],
    [
      "zero window",
      { ...OWNER_PACK, windowDays: 0 },
    ],
    [
      "all zero",
      {
        levelRequirementUsd: 0, relockPct: 0, evPerOpenUsd: 0, opensPerWindow: 0,
        claimers: 0, eligibleUsers: 0, windowDays: 0,
      },
    ],
  ];
  for (const [label, input] of degenerates) {
    for (const incrementality of [NaN, -1, 0, 0.5, 1, Infinity]) {
      const r = computePackCoverage(input, { incrementality });
      assertAllFinite(r, `${label} @ incrementality ${incrementality}`);
    }
  }
  // windowDays 0 specifically: no valid window → $0 giveback, null coverage.
  const zeroWindow = computePackCoverage({ ...OWNER_PACK, windowDays: 0 }, { incrementality: 0.35 });
  exact(zeroWindow.givebackUsd30d, 0, "giveback @ windowDays 0");
  exact(zeroWindow.coverageRatio, null, "coverage @ windowDays 0");
});

// ─── 7. Aggregate = sum of per-pack ──────────────────────────────────────────

check("aggregate = exact sum of per-pack outputs (incl. profit linearity)", () => {
  const incrementality = 0.35;
  const packs: PackCoverageInput[] = [
    OWNER_PACK,
    {
      id: "small-pack",
      levelRequirementUsd: 5_000, relockPct: 0.02, evPerOpenUsd: 4, opensPerWindow: 10,
      claimers: 1_200, eligibleUsers: 6_000, windowDays: 30,
    },
    {
      id: "dead-pack (no giveback)",
      levelRequirementUsd: 100_000, relockPct: 0.005, evPerOpenUsd: 50, opensPerWindow: 0,
      claimers: 10, eligibleUsers: 40, windowDays: 30,
    },
  ];
  const agg = computePackCoverageAggregate(packs, { incrementality });
  assert(agg.packs.length === 3, "aggregate carries all per-pack results");

  const sum = (pick: (p: (typeof agg.packs)[number]) => number): number =>
    agg.packs.reduce((s, p) => s + pick(p), 0);

  exact(agg.requiredLossFlowUsd30d, sum((p) => p.requiredLossFlowUsd30d), "Σ requiredLoss");
  exact(agg.givebackUsd30d, sum((p) => p.givebackUsd30d), "Σ giveback");
  exact(agg.oneTimeUnlockLossUsd, sum((p) => p.oneTimeUnlockLossUsd), "Σ one-time unlock");
  exact(
    agg.theoreticalIncrementalProfitUsd30d,
    sum((p) => p.theoreticalIncrementalProfitUsd30d),
    "Σ profit",
  );
  // Linearity: summed profit === profit of the summed flows (global incrementality).
  approx(
    agg.theoreticalIncrementalProfitUsd30d,
    incrementality * agg.requiredLossFlowUsd30d - agg.givebackUsd30d,
    1e-9,
    "profit linearity",
  );
  // Aggregate coverage is Σ/Σ, not a mean of ratios.
  approx(
    agg.coverageRatio ?? NaN,
    agg.requiredLossFlowUsd30d / agg.givebackUsd30d,
    1e-12,
    "aggregate coverage = Σ required / Σ giveback",
  );
  exact(agg.totalClaimers, 250 + 1_200 + 10, "Σ claimers");
  exact(agg.totalEligibleUsers, 1_000 + 6_000 + 40, "Σ eligible");
});

check("aggregate coverage null when every pack gives back $0", () => {
  const agg = computePackCoverageAggregate(
    [
      { ...OWNER_PACK, opensPerWindow: 0 },
      { ...OWNER_PACK, id: "no-ev", evPerOpenUsd: 0 },
    ],
    { incrementality: 0.35 },
  );
  exact(agg.givebackUsd30d, 0, "Σ giveback");
  exact(agg.coverageRatio, null, "aggregate coverage");
});

check("empty pack list → all-zero aggregate, null coverage", () => {
  const agg = computePackCoverageAggregate([], { incrementality: 0.5 });
  exact(agg.requiredLossFlowUsd30d, 0, "Σ requiredLoss");
  exact(agg.givebackUsd30d, 0, "Σ giveback");
  exact(agg.theoreticalIncrementalProfitUsd30d, 0, "Σ profit");
  exact(agg.coverageRatio, null, "coverage");
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log("");
console.log(`${passes} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error(`Failed: ${failures.join(", ")}`);
  process.exit(1);
}
