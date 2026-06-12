/**
 * _credit-matrix-v2.ts — PURE reward-source crediting-matrix math
 * (Edge Plan 2.0, planner-only — nothing here exists in the backend).
 *
 * Concept (owner spec, 2026-06-12): money a user receives from a house
 * reward (rain win, race prize, rakeback claim, …) is usually re-wagered.
 * Today every re-wagered reward dollar EARNS the full set of loyalty
 * programs again (shards, XP, rakeback accrual, race points, leaderboard
 * volume) exactly like a fresh deposit dollar. The matrix lets the owner
 * plan a CREDIT % per (reward source × program): 100% = current behavior,
 * 0% = reward-funded wager earns nothing in that program.
 *
 *   savings(program) = rate(program) × reWagerRate × Σ_source volume × (1 − cell)
 *
 * where
 *   • rate(program)  = the program's house cost per $1 of wager, derived
 *     from the REAL baseline legs (rakebackCost ÷ wager, raceCost ÷ wager,
 *     leaderboard prizes ÷ wager, daily-pack XP cost ÷ wager) or, for
 *     shards, from the planned shard config (cost per wager $),
 *   • reWagerRate    = the planning assumption for how much of each reward
 *     dollar gets re-wagered (the HONEST knob — funding source per bet is
 *     untraceable in the ledger, so this is clearly labeled an assumption),
 *   • volume(source) = the REAL 30d $ paid through that reward source
 *     (already measured on the baseline — zero new scans).
 *
 * Savings reduce reward cost → the lever row is a cost REDUCTION (emerald,
 * house-POV). All cells default to 100% credit → savings $0 at mount.
 *
 * PURE: no DB, no React, no repo imports.
 */

// ─── Programs (matrix columns) ───────────────────────────────────────────────

export const CREDIT_MATRIX_PROGRAM_IDS = [
  "shards",
  "xp",
  "rakeback",
  "races",
  "leaderboards",
] as const;

export type CreditMatrixProgramId = (typeof CREDIT_MATRIX_PROGRAM_IDS)[number];

export const CREDIT_MATRIX_PROGRAM_LABELS: Record<CreditMatrixProgramId, string> = {
  shards: "Shards",
  xp: "XP / levels",
  rakeback: "Rakeback",
  races: "Races",
  leaderboards: "Leaderboards",
};

// ─── Reward sources (matrix rows) ────────────────────────────────────────────

/**
 * One reward source row: the measured 30d $ volume paid out through it.
 * Assembled on the baseline from legs that are ALREADY scanned (rain, race,
 * rakeback, affiliate, deposit bonus, motha) — the matrix adds no scans.
 */
export type RewardSourceVolume = {
  /** Stable id (ledger-type-ish key, e.g. "rain_win", "race_prize"). */
  sourceId: string;
  /** Display label. */
  label: string;
  /** Measured $ paid through this source over the window. */
  amountUsd: number;
};

// ─── Cells ───────────────────────────────────────────────────────────────────

/**
 * Sparse cell store: `${sourceId}:${programId}` → credit fraction (0..1).
 * A missing key means 100% credit (current behavior). Kept sparse so the
 * lever state stays small and presets round-trip cleanly.
 */
export type CreditMatrixCells = Record<string, number>;

export function matrixCellKey(
  sourceId: string,
  programId: CreditMatrixProgramId,
): string {
  return `${sourceId}:${programId}`;
}

/** Read one cell (0..1). Missing/invalid → 1 (full credit). */
export function getMatrixCell(
  cells: CreditMatrixCells,
  sourceId: string,
  programId: CreditMatrixProgramId,
): number {
  const v = cells[matrixCellKey(sourceId, programId)];
  if (v == null || !Number.isFinite(v)) return 1;
  return Math.min(1, Math.max(0, v));
}

/** Sanitize an arbitrary (persisted) cell payload into a clean sparse map. */
export function sanitizeMatrixCells(input: unknown): CreditMatrixCells {
  const out: CreditMatrixCells = {};
  if (input == null || typeof input !== "object") return out;
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    if (typeof key !== "string" || !key.includes(":")) continue;
    const programId = key.split(":").pop();
    if (!CREDIT_MATRIX_PROGRAM_IDS.includes(programId as CreditMatrixProgramId)) {
      continue;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) continue;
    const clamped = Math.min(1, Math.max(0, n));
    // Only persist non-default cells (sparse — 1 means full credit).
    if (clamped < 1) out[key] = clamped;
  }
  return out;
}

// ─── Program cost-rates per $1 wager ─────────────────────────────────────────

/** One program's house cost per $1 of wager (0..1 fraction). */
export type CreditMatrixProgramRate = {
  programId: CreditMatrixProgramId;
  /** House cost per wagered dollar (e.g. 0.003 = 0.3%). */
  ratePerWagerDollar: number;
  /** Where the rate comes from (display-honesty label). */
  source: string;
};

function safeRate(cost: number, wager: number): number {
  if (!Number.isFinite(cost) || !Number.isFinite(wager) || wager <= 0) return 0;
  return Math.max(0, cost) / wager;
}

/**
 * Derive every program's cost-per-wager-$ from the REAL baseline legs.
 * `shardRatePerWagerDollar` is supplied by the caller (from the planned
 * shard config — 0 when shards are disabled).
 */
export function deriveProgramRates(input: {
  /** Window wager (USD) — the rate denominator. */
  wager: number;
  /** Real Σ |rakeback_claim| over the window. */
  rakebackCost: number;
  /** Real Σ |race_prize| over the window. */
  raceCost: number;
  /** Real Σ |affiliate_leaderboard_prize| over the window. */
  affiliateLeaderboardCost: number;
  /** Real daily/free-pack giveaway cost (the XP-program payout channel). */
  dailyPacksCost: number;
  /** Planned shard cost per wagered $ (0 when shards disabled). */
  shardRatePerWagerDollar: number;
}): CreditMatrixProgramRate[] {
  return [
    {
      programId: "shards",
      ratePerWagerDollar: Math.max(0, input.shardRatePerWagerDollar),
      source: "planned shard config",
    },
    {
      programId: "xp",
      ratePerWagerDollar: safeRate(input.dailyPacksCost, input.wager),
      source: "daily-pack giveaway ÷ wager",
    },
    {
      programId: "rakeback",
      ratePerWagerDollar: safeRate(input.rakebackCost, input.wager),
      source: "rakeback claims ÷ wager",
    },
    {
      programId: "races",
      ratePerWagerDollar: safeRate(input.raceCost, input.wager),
      source: "race prizes ÷ wager",
    },
    {
      programId: "leaderboards",
      ratePerWagerDollar: safeRate(input.affiliateLeaderboardCost, input.wager),
      source: "leaderboard prizes ÷ wager",
    },
  ];
}

// ─── Savings math ────────────────────────────────────────────────────────────

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/**
 * Window savings (USD) one program realizes from de-crediting reward-funded
 * wager: rate × reWagerRate × Σ_source amount × (1 − cell). 0 when every
 * cell is at 100% credit. Bounded above by rate × reWagerRate × Σ volumes.
 */
export function programSavingsUsd(
  rate: CreditMatrixProgramRate,
  reWagerRate: number,
  sources: readonly RewardSourceVolume[],
  cells: CreditMatrixCells,
): number {
  const rw = clamp01(reWagerRate);
  if (rw <= 0 || rate.ratePerWagerDollar <= 0) return 0;
  let deCredited = 0;
  for (const s of sources) {
    const amount = Number.isFinite(s.amountUsd) ? Math.max(0, s.amountUsd) : 0;
    if (amount <= 0) continue;
    deCredited += amount * (1 - getMatrixCell(cells, s.sourceId, rate.programId));
  }
  return rate.ratePerWagerDollar * rw * deCredited;
}

/** Σ savings across every program (the credit-matrix lever's window $). */
export function totalMatrixSavingsUsd(
  rates: readonly CreditMatrixProgramRate[],
  reWagerRate: number,
  sources: readonly RewardSourceVolume[],
  cells: CreditMatrixCells,
): number {
  let total = 0;
  for (const r of rates) {
    total += programSavingsUsd(r, reWagerRate, sources, cells);
  }
  return total;
}
