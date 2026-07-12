import "server-only";

/**
 * Data layer for the standalone /insights/challenges analytics page.
 *
 * Source tables (MAIN game DB, STRICTLY READ-ONLY — SELECT only):
 *   - `challenges`        — one row per challenge (id, name, type, status,
 *                           prize_amount, max_claims, claimed_count,
 *                           created_at). Current-state metadata table.
 *   - `challenge_claims`  — one row per (user, challenge) claim attempt;
 *                           status ∈ {eligible, claimed}, timestamped via
 *                           `claimed_at`. The claimed rows are the realized
 *                           claims.
 *   - `ledger_transactions` type `challenge_prize` — the cash leg of a
 *                           claimed prize (positive amount credited to the
 *                           user = money paid OUT = house COST). This is the
 *                           authoritative cost figure (one ledger row per
 *                           paid prize). Verified: $129 across 7 rows on dev.
 *
 * Why direct SQL and not the backend `challengesApi`: the CRUD page goes
 * through the backend (it MUTATES challenges, which the admin panel must do
 * via the backend). This page only READS, and two of the three inputs
 * (`challenge_claims` time-series and the `challenge_prize` ledger cost)
 * have no backend admin endpoint — they are ledger/claim aggregates, exactly
 * the kind of read every other /insights/* surface does against the Main DB
 * via `getDb()`. No game-DB writes are performed here.
 *
 * House-POV (CLAUDE.md, strict): a challenge prize is money paid TO the user
 * → a house COST → rendered ROSE. Counts / rates are neutral (blue / cyan).
 *
 * Drift-guard: the `challenges` / `challenge_claims` tables and the
 * `challenge_prize` ledger enum member may be ABSENT on an un-migrated DB
 * (the feature is dev-only today — prod has neither yet). We probe
 * `to_regclass` for the tables (→ `available:false`, the page shows a muted
 * "not available" instead of a 42P01 crash) and probe the ledger enum on the
 * SAME `db` client (so the check tracks the connected DB under the dev/prod
 * toggle, NOT the prod-pinned `filterLedgerTxTypesLive` whose inner cache
 * always resolves to prod). The cost SQL also uses `type::text = '…'`, which
 * is inherently 22P02-safe, so a missing enum member can never crash — the
 * cost simply degrades to 0.
 *
 * Caching: `unstable_cache` keyed on (env, period) so the prod and dev DB
 * toggles never share an entry and each window caches independently. TTL is
 * 60s for live windows, 5 min for the lifetime view.
 */

// ─── Period ───────────────────────────────────────────────────────────

export type ChallengesPeriod = "24h" | "7d" | "30d" | "all";

// ─── Result shapes ────────────────────────────────────────────────────

export type ChallengeRow = {
  id: string;
  name: string;
  type: string;
  status: string;
  prizeAmount: number;
  claimedCount: number;
  maxClaims: number;
  completionRate: number; // claimedCount / maxClaims, 0 when maxClaims=0
  createdAt: string; // ISO
};

export type ChallengeCostPoint = {
  date: string; // yyyy-mm-dd
  total: number;
  count: number;
};

export type ChallengesOverview = {
  /** Schema present on the connected DB. When false, render "not available". */
  available: boolean;

  // Overview KPIs (current-state metadata)
  totalChallenges: number;
  activeChallenges: number;

  // Total prize cost = sum of customer-scoped `challenge_prize` ledger rows in
  // window (same population as `dailyCost` below). Headline house cost.
  totalPrizeCost: number;
  prizeLineCount: number;

  // Claims = `challenge_claims` rows with status='claimed'.
  totalClaims: number;
  avgClaimsPerChallenge: number; // totalClaims / totalChallenges
  overallCompletionRate: number; // Σ claimed_count / Σ max_claims

  // Time-series (period-filtered, customer-scoped — see module doc)
  dailyCost: ChallengeCostPoint[];

  // Per-challenge table (current-state; NOT period-filtered)
  challenges: ChallengeRow[];
};
