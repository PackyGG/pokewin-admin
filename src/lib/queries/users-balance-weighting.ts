import "server-only";

import { queryMainRows } from "@/lib/drizzle-query";
import {
  getSourceWagerWeights,
  type FundingSourceWeights,
  type SourceWagerWeights,
} from "@/lib/backend-api/source-wager-weights";

/**
 * Per-user "where does my balance count, and how much" view (read-only).
 *
 * WHAT THIS IS
 * ────────────
 * The game backend applies a FUNDING-SOURCE wager weight: wager that was
 * funded by a bonus source (race/leaderboard prizes, rain + reward/balance
 * claims, rakeback, affiliate, tips) counts at a different rate toward the
 * WITHDRAWAL requirement, RAKEBACK and RACE LEADERBOARDS than
 * deposit-funded wager. Deposits + organic game winnings are the implicit
 * 100% (1×) baseline. All weights are basis points (10000 = 1×; 0 = that
 * source's wager doesn't count toward that destination at all). Source of the
 * weight matrix: `getSourceWagerWeights()` (backend admin API). Enforcement
 * lives in the game backend — this is a read-only admin projection.
 *
 * This composes the live weight matrix with THIS user's current balance
 * composition (the backend-written `unwagered_*_usd` columns: still-unwagered
 * bonus funds per source). The remainder of the available balance
 * (available − Σ unwagered) is the deposit/organic baseline that counts at 1×.
 * For each source we surface, per destination: the weight and the resulting
 * "$ that would count when this balance is wagered".
 *
 * IMPORTANT FRAMING: the weights apply AT WAGER TIME, so these figures are the
 * forward-looking "earning power" of each chunk of balance when it is wagered
 * — NOT a settled amount. The leaderboard destination further composes with
 * the per-game weights (packs/battles/upgrader); this view shows the
 * funding-source dimension only.
 *
 * ENV-ADAPTIVE / DRIFT-SAFE
 * ─────────────────────────
 * Probes `information_schema.columns` for `unwagered_bonus_other_usd` before
 * selecting the sweepstakes columns, returning `null` (→ muted card) if a
 * connected DB lacks them. READ-ONLY raw SQL; the query never selects an absent
 * column. The weight-matrix backend call is timeout-bounded and degrades to
 * `backendAvailable: false` (balance composition still shown, weights hidden).
 */

const BPS_PER_X = 10000;

/** Hard wall-clock budget for the OPTIONAL backend weight-matrix read. The
 *  balance composition is a pure column read and doesn't depend on it; a slow
 *  backend just degrades the weights to null. `backendApi`'s own per-attempt
 *  timeout + retry can otherwise burn >20s and blow the outer safeQuery. */
const WEIGHTING_BACKEND_BUDGET_MS = 6000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout>;
  const cap = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([
    p.then(
      (v) => v,
      () => null,
    ),
    cap,
  ]).finally(() => clearTimeout(timer));
}

/** Destinations a wager can count toward. `leaderboard` is optional in the
 *  backend payload, so it's only present when the config returns it. */
export type WeightDestinationKey =
  | "withdrawal"
  | "leaderboard"
  | "rakeback";

export type WeightDestination = {
  key: WeightDestinationKey;
  label: string;
};

/** A chunk of the user's current balance, tagged by funding source, with its
 *  per-destination weight (bps) + the resulting counted USD. */
export type BalanceWeightRow = {
  key:
    | "deposit_organic"
    | "race_prize"
    | "bonus_other"
    | "rakeback"
    | "affiliate"
    | "tips";
  label: string;
  /** How much of the user's CURRENT available balance is from this source. */
  balanceUsd: number;
  /** Per-destination weight in bps (10000 = 1×). null = the backend config
   *  for that destination wasn't reachable. */
  weightBps: Record<WeightDestinationKey, number | null>;
};

export type UserBalanceWeighting = {
  availableBalanceUsd: number;
  /** Destinations present in the live config (withdrawal + rakeback always;
   *  leaderboard when the backend returns it). */
  destinations: WeightDestination[];
  /** One row per funding source that this user currently holds balance in
   *  (zero-balance sources are dropped), with the deposit/organic baseline
   *  first. */
  rows: BalanceWeightRow[];
  /** False when the weight-matrix backend call failed → weights are null and
   *  only the balance composition is shown. */
  backendAvailable: boolean;
};

const num = (v: string | number | null | undefined): number => {
  if (v == null) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

type RawRow = {
  available_balance: string | null;
  unwagered_race_prize_usd: string | null;
  unwagered_bonus_other_usd: string | null;
  unwagered_rakeback_usd: string | null;
  unwagered_affiliate_usd: string | null;
  unwagered_tips_usd: string | null;
};

/** All destinations the matrix can carry, with display labels + which key on
 *  the `SourceWagerWeights` object holds that destination's per-source row. */
const DESTINATIONS: {
  key: WeightDestinationKey;
  label: string;
  pick: (m: SourceWagerWeights) => FundingSourceWeights | undefined;
}[] = [
  { key: "withdrawal", label: "Withdrawal unlock", pick: (m) => m.withdrawal },
  { key: "leaderboard", label: "Races / Leaderboards", pick: (m) => m.leaderboard },
  { key: "rakeback", label: "Rakeback", pick: (m) => m.rakeback },
];

export async function getUserBalanceWeighting(
  userId: string,
): Promise<UserBalanceWeighting | null> {
  // ── ENV-GUARD: column presence probe (read-only catalog lookup) ──────
  const colCheck = await queryMainRows<{ exists: boolean }[]>(`
    SELECT EXISTS (
      SELECT 1
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'balances'
         AND column_name = 'unwagered_bonus_other_usd'
    ) AS exists`);
  if (!colCheck[0]?.exists) return null;

  const rows = await queryMainRows<RawRow[]>(
    `
    SELECT
      available_balance::text          AS available_balance,
      unwagered_race_prize_usd::text   AS unwagered_race_prize_usd,
      unwagered_bonus_other_usd::text  AS unwagered_bonus_other_usd,
      unwagered_rakeback_usd::text     AS unwagered_rakeback_usd,
      unwagered_affiliate_usd::text    AS unwagered_affiliate_usd,
      unwagered_tips_usd::text         AS unwagered_tips_usd
    FROM balances
    WHERE user_id = $1
    LIMIT 1`,
    userId,
  );
  const row = rows[0];
  if (!row) return null;

  const matrix = await withTimeout(
    getSourceWagerWeights(),
    WEIGHTING_BACKEND_BUDGET_MS,
  );
  const backendAvailable = matrix !== null;

  // Destinations present in the live config (withdrawal + rakeback are always
  // returned; leaderboard only on a newer backend). When the matrix
  // is unreachable we still show all three labels with null weights.
  const destinations: WeightDestination[] = DESTINATIONS.filter(
    (d) => !matrix || d.pick(matrix) != null,
  ).map((d) => ({ key: d.key, label: d.label }));

  const available = round2(num(row.available_balance));

  // Per-source still-unwagered (bonus-funded) balance. These map 1:1 to the
  // matrix source keys.
  const bonusFunded: {
    key: Exclude<BalanceWeightRow["key"], "deposit_organic">;
    label: string;
    balanceUsd: number;
    src: keyof FundingSourceWeights;
  }[] = [
    {
      key: "race_prize",
      label: "Race / leaderboard prizes",
      balanceUsd: round2(num(row.unwagered_race_prize_usd)),
      src: "race_prize",
    },
    {
      key: "bonus_other",
      label: "Bonus / reward claims",
      balanceUsd: round2(num(row.unwagered_bonus_other_usd)),
      src: "bonus_other",
    },
    {
      key: "rakeback",
      label: "Rakeback claims",
      balanceUsd: round2(num(row.unwagered_rakeback_usd)),
      src: "rakeback",
    },
    {
      key: "affiliate",
      label: "Affiliate claims",
      balanceUsd: round2(num(row.unwagered_affiliate_usd)),
      src: "affiliate",
    },
    {
      key: "tips",
      label: "Tips received",
      balanceUsd: round2(num(row.unwagered_tips_usd)),
      src: "tips",
    },
  ];

  const totalBonusFunded = round2(
    bonusFunded.reduce((acc, s) => acc + s.balanceUsd, 0),
  );
  // Whatever isn't tagged as still-unwagered bonus funds is deposit / organic
  // game winnings — the implicit 1× baseline (clamped ≥ 0 in case the columns
  // momentarily over-count vs available).
  const depositOrganic = round2(Math.max(0, available - totalBonusFunded));

  const weightFor = (
    src: keyof FundingSourceWeights | null,
  ): Record<WeightDestinationKey, number | null> => {
    const out = {} as Record<WeightDestinationKey, number | null>;
    for (const d of DESTINATIONS) {
      if (!matrix) {
        out[d.key] = null;
        continue;
      }
      const dest = d.pick(matrix);
      if (!dest) continue; // destination not present → not in `destinations`
      // Baseline (deposit/organic) counts at 1× toward every destination.
      out[d.key] = src === null ? BPS_PER_X : dest[src];
    }
    return out;
  };

  const allRows: BalanceWeightRow[] = [
    {
      key: "deposit_organic",
      label: "Deposits & game winnings",
      balanceUsd: depositOrganic,
      weightBps: weightFor(null),
    },
    ...bonusFunded.map((s) => ({
      key: s.key,
      label: s.label,
      balanceUsd: s.balanceUsd,
      weightBps: weightFor(s.src),
    })),
  ];

  // Drop sources the user holds no balance in (keeps the table to what's real)
  // — but always keep the baseline row so the table is never empty.
  const rowsOut = allRows.filter(
    (r) => r.key === "deposit_organic" || r.balanceUsd > 0,
  );

  return {
    availableBalanceUsd: available,
    destinations,
    rows: rowsOut,
    backendAvailable,
  };
}
