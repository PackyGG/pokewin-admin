import "server-only";

import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { readDbEnv } from "@/lib/db-env";
import { getMetricsScope } from "@/lib/metrics/scope";
import { toNumber } from "@/lib/utils/decimal";

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

export function parseChallengesPeriod(
  value: string | undefined,
): ChallengesPeriod {
  switch (value) {
    case "24h":
    case "7d":
    case "30d":
    case "all":
      return value;
    default:
      return "30d";
  }
}

export function challengesPeriodLabel(p: ChallengesPeriod): string {
  switch (p) {
    case "24h":
      return "Last 24 hours";
    case "7d":
      return "Last 7 days";
    case "30d":
      return "Last 30 days";
    case "all":
      return "All time";
  }
}

/**
 * Lifetime lookback cap (days) for the time-series sweep, mirroring the
 * rewards-insights `INSIGHTS_LIFETIME_LOOKBACK_DAYS`. The challenge program
 * is brand-new (first prize 2026-06-11) so this is academic today, but it
 * keeps the `all` window from ever issuing an unbounded ledger scan as the
 * data grows — the active-timeframe-only / no-unbounded-lifetime rule.
 */
const LIFETIME_LOOKBACK_DAYS = 365;

/** Day count for the period; `null` for the (capped) lifetime window. */
function daysForPeriod(p: ChallengesPeriod): number | null {
  switch (p) {
    case "24h":
      return 1;
    case "7d":
      return 7;
    case "30d":
      return 30;
    case "all":
      return null;
  }
}

function cacheTtl(p: ChallengesPeriod): number {
  return p === "all" ? 300 : 60;
}

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

const EMPTY: ChallengesOverview = {
  available: false,
  totalChallenges: 0,
  activeChallenges: 0,
  totalPrizeCost: 0,
  prizeLineCount: 0,
  totalClaims: 0,
  avgClaimsPerChallenge: 0,
  overallCompletionRate: 0,
  dailyCost: [],
  challenges: [],
};

// ─── Compute ──────────────────────────────────────────────────────────

async function compute(period: ChallengesPeriod): Promise<ChallengesOverview> {
  const db = await getDb();

  // 1) Drift-guard: both tables must exist, else degrade to "not available"
  //    (never let a 42P01 take the page down on an un-migrated DB).
  const reg = await db.$queryRaw<
    { challenges: string | null; claims: string | null }[]
  >`
    SELECT to_regclass('public.challenges')::text       AS challenges,
           to_regclass('public.challenge_claims')::text AS claims
  `;
  const present = reg[0]?.challenges != null && reg[0]?.claims != null;
  if (!present) return EMPTY;

  // 2) Does the `challenge_prize` ledger enum member exist on THIS db?
  //    Probed on the SAME `db` client (not the prod-pinned
  //    `filterLedgerTxTypesLive`, whose inner `unstable_cache` always
  //    resolves to the PROD enum — see module doc) so the result tracks the
  //    actual connected DB under the dev/prod toggle. On a DB lacking the
  //    member the cost legs are skipped and degrade to 0 (the SQL below also
  //    uses `type::text = '…'`, which is inherently 22P02-safe — comparing a
  //    text-cast column to a string literal never coerces the literal into a
  //    missing enum — so this probe is belt-and-braces, not the only guard).
  const enumRows = await db.$queryRaw<{ ok: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'ledger_transaction_type'
        AND e.enumlabel = 'challenge_prize'
    ) AS ok
  `;
  const hasPrizeType = enumRows[0]?.ok === true;

  const scope = await getMetricsScope();
  const days = daysForPeriod(period);
  // Lifetime caps at LIFETIME_LOOKBACK_DAYS for the time-series scan.
  const seriesDays = days ?? LIFETIME_LOOKBACK_DAYS;

  // 3) Headline cost = sum of customer-scoped challenge_prize ledger rows in
  //    window. Customer-scoped (getMetricsScope) so the headline KPI and the
  //    daily-cost chart below share ONE population — staff/creator/blacklisted
  //    prizes never inflate the headline while being excluded from the chart.
  //    Window-filtered.
  const dateFilter =
    days !== null ? `AND lt.created_at >= NOW() - INTERVAL '${days} days'` : "";

  // 4) Per-challenge metadata (current-state, all challenges).
  // 5) Claims rollup from challenge_claims (status='claimed').
  // 6) Customer-scoped daily cost series (getMetricsScope) for the chart.
  const [costRows, challengeRows, claimsRows, seriesRows] = await Promise.all([
    hasPrizeType
      ? db.$queryRawUnsafe<{ total: string; cnt: string }[]>(`
          SELECT COALESCE(SUM(lt.amount::numeric), 0)::text AS total,
                 COUNT(*)::text AS cnt
          FROM ledger_transactions lt
          WHERE lt.type::text = 'challenge_prize'
            AND lt.user_id IN ${scope.userScopeSql}
          ${dateFilter}
        `)
      : Promise.resolve([{ total: "0", cnt: "0" }]),

    db.$queryRawUnsafe<
      {
        id: string;
        name: string;
        type: string;
        status: string;
        prize_amount: string;
        claimed_count: number;
        max_claims: number;
        created_at: Date;
      }[]
    >(`
      SELECT id, name, type::text AS type, status::text AS status,
             prize_amount::text AS prize_amount,
             claimed_count, max_claims, created_at
      FROM challenges
      ORDER BY created_at DESC
    `),

    // Total claims = a CLEAN count of claimed `challenge_claims` rows. (The
    // Σ-claimed / Σ-max completion-rate inputs are derived in JS from the
    // per-challenge `challenges` rows below — NOT from a join here, which
    // would fan `claimed_count` / `max_claims` out by the number of claim
    // rows per challenge and inflate the totals.)
    db.$queryRawUnsafe<{ total: string }[]>(`
      SELECT COUNT(*)::text AS total
      FROM challenge_claims
      WHERE status::text = 'claimed'
    `),

    hasPrizeType
      ? db.$queryRawUnsafe<{ date: Date; total: string; cnt: string }[]>(`
          SELECT DATE(lt.created_at) AS date,
                 COALESCE(SUM(lt.amount::numeric), 0)::text AS total,
                 COUNT(*)::text AS cnt
          FROM ledger_transactions lt
          WHERE lt.type::text = 'challenge_prize'
            AND lt.created_at >= NOW() - INTERVAL '${seriesDays} days'
            AND lt.user_id IN ${scope.userScopeSql}
          GROUP BY DATE(lt.created_at)
          ORDER BY date ASC
        `)
      : Promise.resolve([]),
  ]);

  const cost = costRows[0];
  const totalPrizeCost = toNumber(cost?.total);
  const prizeLineCount = Number(cost?.cnt ?? 0);

  const challenges: ChallengeRow[] = challengeRows.map((r) => {
    const claimed = Number(r.claimed_count ?? 0);
    const max = Number(r.max_claims ?? 0);
    return {
      id: r.id,
      name: r.name,
      type: r.type,
      status: r.status,
      prizeAmount: toNumber(r.prize_amount),
      claimedCount: claimed,
      maxClaims: max,
      completionRate: max > 0 ? claimed / max : 0,
      createdAt: new Date(r.created_at).toISOString(),
    };
  });

  const totalChallenges = challenges.length;
  const activeChallenges = challenges.filter((c) => c.status === "active").length;

  const totalClaims = Number(claimsRows[0]?.total ?? 0);
  // Completion-rate inputs from the per-challenge rows (no join → no fan-out).
  const sumClaimed = challenges.reduce((acc, c) => acc + c.claimedCount, 0);
  const sumMax = challenges.reduce((acc, c) => acc + c.maxClaims, 0);
  const avgClaimsPerChallenge =
    totalChallenges > 0 ? totalClaims / totalChallenges : 0;
  const overallCompletionRate = sumMax > 0 ? sumClaimed / sumMax : 0;

  const dailyCost: ChallengeCostPoint[] = seriesRows.map((row) => ({
    date: new Date(row.date).toISOString().split("T")[0],
    total: toNumber(row.total),
    count: Number(row.cnt),
  }));

  return {
    available: true,
    totalChallenges,
    activeChallenges,
    totalPrizeCost,
    prizeLineCount,
    totalClaims,
    avgClaimsPerChallenge,
    overallCompletionRate,
    dailyCost,
    challenges,
  };
}

// ─── Cached entry points (env-keyed) ──────────────────────────────────

const cachedShort = unstable_cache(
  async (period: ChallengesPeriod) => compute(period),
  ["insights-challenges-overview-v1"],
  { revalidate: 60, tags: ["insights-challenges"] },
);

const cachedLong = unstable_cache(
  async (period: ChallengesPeriod) => compute(period),
  ["insights-challenges-overview-lifetime-v1"],
  { revalidate: 300, tags: ["insights-challenges"] },
);

/**
 * Challenges overview — cached on PROD, direct (uncached) on a dev-toggled
 * admin.
 *
 * Why the dev bypass (matches `users-detail-cache.ts`): `compute` resolves
 * its client through `getDb()` → `readDbEnv()` → `cookies()`. But an
 * `unstable_cache` callback runs OUTSIDE the request's dynamic scope, so
 * `cookies()` throws there and `readDbEnv` falls back to "prod" — meaning a
 * cached `compute` ALWAYS queries the prod client regardless of the caller's
 * toggle. To avoid ever serving prod data to a dev-toggled admin we cache
 * ONLY on prod (the default path) and run the query directly on dev so the
 * dev admin always sees live dev numbers. The dev toggle is a rare debugging
 * affordance, so the missing cache layer there is acceptable.
 */
export async function getChallengesOverview(
  period: ChallengesPeriod,
): Promise<ChallengesOverview> {
  const env = await readDbEnv();
  if (env !== "prod") return compute(period);
  const ttl = cacheTtl(period);
  return ttl >= 300 ? cachedLong(period) : cachedShort(period);
}
