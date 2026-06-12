/**
 * _shards-v2.ts — PURE shard-economy math for Edge Plan 2.0 (planner-only).
 *
 * Owner spec (2026-06-12):
 *   • Users earn 1 shard per $X wagered (default $20 / shard — an input).
 *   • Each shard carries an expected house cost of $Y (default $0.06 — an
 *     input; the shard-shop packs are priced so EV/shard ≈ this).
 *   • Target giveback = 0.3% of wager (the reference line the effective
 *     giveback is compared against — emerald when at/below target).
 *   • Per-gamemode earn weights (0..1) — the owner wants upgrader wager to
 *     earn LESS than packs/battles. Weight 1 = full earn, 0 = no earn.
 *
 *   monthlyShardCost = (Σ typeWager × weight) ÷ wagerPerShard × evPerShard
 *
 * Identity (the __checks__ assert this EXACTLY): at weights 1/1/1, $20 per
 * shard and $0.06 EV → cost = wager × (0.06 / 20) = wager × 0.003, i.e. an
 * effective giveback of exactly 0.3000% of total wager.
 *
 * No DB, no React, no repo imports — safe for both the server baseline and
 * the "use client" planner sections.
 */

// ─── Spec defaults ───────────────────────────────────────────────────────────

/** Default wager required to earn one shard (USD). Owner spec. */
export const SHARDS_DEFAULT_WAGER_PER_SHARD_USD = 20 as const;

/** Default expected house cost (EV) of one shard when redeemed (USD). */
export const SHARDS_DEFAULT_EV_PER_SHARD_USD = 0.06 as const;

/** Target giveback as a fraction of wager (0.3%). The reference line. */
export const SHARDS_TARGET_GIVEBACK = 0.003 as const;

// ─── Types ───────────────────────────────────────────────────────────────────

/** Per-gamemode shard-earn weights (0..1). 1 = full earn on that wager. */
export type ShardGameWeights = {
  packs: number;
  battles: number;
  upgrader: number;
};

/** Window wager per game type (USD) — from the real baseline gameTypes. */
export type ShardTypeWager = {
  packs: number;
  battles: number;
  upgrader: number;
};

/** The full shard lever config the planner tunes. */
export type ShardLeverConfig = {
  /** Master switch — false contributes $0 (the default mount state). */
  enabled: boolean;
  /** Wager (USD) required to earn one shard. */
  wagerPerShardUsd: number;
  /** Expected house cost (USD) per shard earned. */
  evPerShardUsd: number;
  /** Per-gamemode earn weights (0..1). */
  weights: ShardGameWeights;
};

// ─── The fixed shard-case table (display + sanity context) ───────────────────

/**
 * The 10 fixed shard-shop cases. Endpoints are owner-pinned (Starter Kit at
 * 2 shards ⇒ $0.12, Eternal Fortune at 10,000 shards ⇒ $600 at the default
 * $0.06 EV/shard); the intermediate tiers are a planning ladder between them.
 * USD values are NEVER stored — always derived as `shards × evPerShardUsd`
 * so the table re-prices live when the EV input moves (the __checks__ assert
 * value === shards × 0.06 at the spec default).
 */
export type ShardCase = {
  /** Display name of the shard-shop case. */
  name: string;
  /** Shard cost to open this case. */
  shards: number;
};

export const SHARD_CASES: readonly ShardCase[] = [
  { name: "Starter Kit", shards: 2 },
  { name: "Pocket Stash", shards: 5 },
  { name: "Bronze Cache", shards: 10 },
  { name: "Silver Cache", shards: 25 },
  { name: "Gold Cache", shards: 50 },
  { name: "Collector's Trove", shards: 100 },
  { name: "Vault Box", shards: 500 },
  { name: "Royal Hoard", shards: 1500 },
  { name: "Mythic Reserve", shards: 4000 },
  { name: "Eternal Fortune", shards: 10000 },
] as const;

/** Expected house cost of one case = shards × EV per shard. */
export function shardCaseValueUsd(
  shardCase: ShardCase,
  evPerShardUsd: number,
): number {
  return shardCase.shards * Math.max(0, evPerShardUsd);
}

// ─── Pure math ───────────────────────────────────────────────────────────────

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function nonNeg(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Σ typeWager × weight — the shard-earning wager base (USD). */
export function weightedShardWager(
  typeWager: ShardTypeWager,
  weights: ShardGameWeights,
): number {
  return (
    nonNeg(typeWager.packs) * clamp01(weights.packs) +
    nonNeg(typeWager.battles) * clamp01(weights.battles) +
    nonNeg(typeWager.upgrader) * clamp01(weights.upgrader)
  );
}

/** Shards earned over the window at the planned config (0 when disabled). */
export function shardsEarnedInWindow(
  typeWager: ShardTypeWager,
  config: ShardLeverConfig,
): number {
  if (!config.enabled) return 0;
  const perShard = nonNeg(config.wagerPerShardUsd);
  if (perShard <= 0) return 0;
  return weightedShardWager(typeWager, config.weights) / perShard;
}

/**
 * House cost of the shard program over the WINDOW (USD):
 *   (Σ typeWager × weight) ÷ wagerPerShard × evPerShard.
 * 0 when disabled (the default mount state — preserves the $0-delta invariant).
 */
export function shardCostInWindow(
  typeWager: ShardTypeWager,
  config: ShardLeverConfig,
): number {
  return shardsEarnedInWindow(typeWager, config) * nonNeg(config.evPerShardUsd);
}

/** Window cost scaled to a 30-day month. */
export function shardMonthlyCost(
  typeWager: ShardTypeWager,
  config: ShardLeverConfig,
  periodDays: number,
): number {
  const days = Number.isFinite(periodDays) && periodDays > 0 ? periodDays : 30;
  return (shardCostInWindow(typeWager, config) / days) * 30;
}

/**
 * Effective giveback = shard cost ÷ TOTAL wager (unweighted denominator).
 * At weights 1/1/1, $20/shard, $0.06 EV this is exactly 0.003 (0.3000%).
 * Down-weighting a mode lowers it below the target. 0 when disabled or no
 * wager.
 */
export function effectiveShardGiveback(
  typeWager: ShardTypeWager,
  config: ShardLeverConfig,
): number {
  const totalWager =
    nonNeg(typeWager.packs) + nonNeg(typeWager.battles) + nonNeg(typeWager.upgrader);
  if (totalWager <= 0) return 0;
  return shardCostInWindow(typeWager, config) / totalWager;
}

/** Positive = effective giveback exceeds the 0.3% target (rose); ≤ 0 emerald. */
export function shardGivebackVsTarget(
  typeWager: ShardTypeWager,
  config: ShardLeverConfig,
): number {
  return effectiveShardGiveback(typeWager, config) - SHARDS_TARGET_GIVEBACK;
}
