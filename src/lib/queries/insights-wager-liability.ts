import "server-only";
import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { readDbEnv } from "@/lib/db-env";
import { getMetricsScope } from "@/lib/metrics/scope";

/**
 * insights-wager-liability.ts — PLATFORM-WIDE wager-requirement liability
 * snapshot for /insights/wager-liability (read-only).
 *
 * WHAT THIS IS
 * ────────────
 * The sweepstakes backend gates every balance withdrawal behind a lifetime
 * wager requirement and tracks, per user, how much of each source bucket is
 * still LOCKED (un-wagered) on the `balances` row — five `unwagered_*_usd`
 * columns the backend maintains directly. Each locked dollar is user money
 * we owe but which the user can't withdraw yet.
 *
 * Until now this was only visible PER USER (the wager-progress card on
 * /users/[id], see `users-wager-progress.ts`). This module rolls the same
 * backend-written columns up across the WHOLE customer base so the operator
 * can see, in one place: total gated liability, how many customers are
 * blocked, how many are exempt, and where the locked money sits by source.
 *
 * CURRENT-STATE SNAPSHOT (no period)
 * ──────────────────────────────────
 * `balances.unwagered_*_usd` and `wager_requirement_progress` are
 * POINT-IN-TIME counters the backend overwrites in place — there is NO
 * time-series here. So this is a "right now" dashboard with no period
 * selector; it always reflects the current balances snapshot.
 *
 * CUSTOMER SCOPE
 * ──────────────
 * Joins `balances.user_id` to the canonical customer population via
 * `getMetricsScope().userScopeSql` (staff + creators + blacklist dropped),
 * EXACTLY like every other money/analytics surface, so the liability total
 * is the real-customer figure (a staff/creator with a stray locked cent
 * never inflates it).
 *
 * ENV-ADAPTIVE / DRIFT-SAFE
 * ─────────────────────────
 * The admin queries ONE schema against both prod and dev game DBs via the
 * `admin_db_env` cookie. The `unwagered_*` / `wager_requirement_progress`
 * columns exist on DEV (verified read-only probe 2026-06-14) but may be
 * absent on a connected DB, so this probes `information_schema.columns`
 * first (mirrors `users-wager-progress.ts` / `shard-stats.ts`) and returns
 * `{ available: false }` → the page renders a muted "not available on this
 * database" state instead of throwing 42703. No `prisma/schema.prisma`
 * change — the read is raw SQL, so Prisma never selects an absent column.
 * READ-ONLY throughout (SELECT + catalog inspection only).
 */

const num = (v: string | number | null | undefined): number => {
  if (v == null) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Round to cents — the columns are Decimal(20,2); JS-float SUM round-trips
 *  can leave a sub-cent drift, so each surfaced figure is cent-rounded so
 *  the source breakdown adds up exactly to the headline total. */
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** One locked-by-source bucket for the breakdown panel. */
export type WagerLiabilitySource = {
  key: "bonus" | "affiliate" | "rakeback" | "tips";
  label: string;
  /** Total still-locked USD across all in-scope customers for this source. */
  lockedUsd: number;
  /** Distinct in-scope customers with > 0 locked from this source. */
  users: number;
};

/** One blocked-customer size bucket for the cohort breakdown. */
export type WagerLiabilityBucket = {
  label: string;
  /** Number of blocked customers whose total locked balance falls in range. */
  users: number;
  /** Σ locked USD of the customers in this bucket. */
  lockedUsd: number;
};

export type WagerLiabilityAvailable = {
  available: true;
  /** Σ of every `unwagered_*_usd` across in-scope customers. */
  totalGatedUsd: number;
  /** Distinct in-scope customers with ANY locked balance (> 0). */
  blockedUsers: number;
  /** In-scope customers with a per-user override of 0 bps (fully exempt). */
  exemptUsers: number;
  /** Σ `wager_requirement_progress` (weighted wager cleared) across scope. */
  totalProgress: number;
  /** Total in-scope customers carrying a `balances` row (the cohort base). */
  totalCustomers: number;
  /** Per-source locked breakdown, biggest first. */
  sources: WagerLiabilitySource[];
  /** Blocked-customer cohort bucketed by locked-balance size. */
  buckets: WagerLiabilityBucket[];
};

export type WagerLiabilityResult =
  | WagerLiabilityAvailable
  | { available: false };

type RawAggRow = {
  bonus_other: string | null;
  race_prize: string | null;
  affiliate: string | null;
  rakeback: string | null;
  tips: string | null;
  wr_progress: string | null;
  // distinct-user counts per source
  bonus_users: bigint | number | null;
  affiliate_users: bigint | number | null;
  rakeback_users: bigint | number | null;
  tips_users: bigint | number | null;
  // cohort counts
  blocked_users: bigint | number | null;
  total_customers: bigint | number | null;
};

type RawBucketRow = {
  bucket: number;
  users: bigint | number | null;
  locked: string | null;
};

/**
 * Probe for the snapshot column on the CURRENTLY-connected DB. Returns false
 * when it lacks `balances.wager_requirement_progress`, so the page degrades
 * to the muted "not available" state instead of a 42703.
 *
 * Deliberately NOT `unstable_cache`d: that cache is NOT env-keyed, so a prod
 * request (column ABSENT on the live prod DB) would poison the entry and a
 * later dev request (column PRESENT) would wrongly get the muted state. It is
 * a single cheap indexed catalog read, run inside `queryWagerLiability` which
 * always executes in the correct per-env scope (direct on dev; via the
 * env-keyed prod cache on prod), so an inline read is both correct and cheap.
 */
async function probeWagerColumn(db: Awaited<ReturnType<typeof getDb>>): Promise<boolean> {
  try {
    const r = await db.$queryRaw<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'balances'
           AND column_name = 'wager_requirement_progress'
      ) AS exists`;
    return Boolean(r[0]?.exists);
  } catch (err) {
    console.error(
      "[insights-wager-liability] column probe failed, treating as absent:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/**
 * Core read. Customer-scoped aggregate over `balances` + the exempt count
 * from `user_wager_requirements`. All identifiers in the interpolated
 * `userScopeSql` come from `getMetricsScope()` (trusted, hardcoded subquery)
 * — no user input is concatenated into SQL.
 */
async function queryWagerLiability(): Promise<WagerLiabilityResult> {
  const db = await getDb();
  const hasColumns = await probeWagerColumn(db);
  if (!hasColumns) return { available: false };

  const scope = await getMetricsScope();
  // `userScopeSql` = (SELECT id FROM "user" u WHERE role NOT IN
  // ('admin','support','creator') <blacklist>). Inlined verbatim — it is a
  // trusted, code-built subquery, never user input.
  const scopeSql = scope.userScopeSql;

  // ── Headline aggregate + per-source distinct users + cohort counts ──────
  // One pass over the in-scope `balances` rows. `bonus` merges the two
  // bonus-family columns (bonus_other + race_prize) exactly as the per-user
  // card does. A user counts toward a source's distinct-user tally only when
  // that source's locked amount is > 0.
  const aggRows = await db.$queryRawUnsafe<RawAggRow[]>(
    `
    SELECT
      COALESCE(SUM(b.unwagered_bonus_other_usd), 0)::text  AS bonus_other,
      COALESCE(SUM(b.unwagered_race_prize_usd), 0)::text   AS race_prize,
      COALESCE(SUM(b.unwagered_affiliate_usd), 0)::text    AS affiliate,
      COALESCE(SUM(b.unwagered_rakeback_usd), 0)::text     AS rakeback,
      COALESCE(SUM(b.unwagered_tips_usd), 0)::text         AS tips,
      COALESCE(SUM(b.wager_requirement_progress), 0)::text AS wr_progress,
      COUNT(*) FILTER (WHERE
        COALESCE(b.unwagered_bonus_other_usd, 0) > 0
        OR COALESCE(b.unwagered_race_prize_usd, 0) > 0
      )::bigint AS bonus_users,
      COUNT(*) FILTER (WHERE COALESCE(b.unwagered_affiliate_usd, 0) > 0)::bigint AS affiliate_users,
      COUNT(*) FILTER (WHERE COALESCE(b.unwagered_rakeback_usd, 0) > 0)::bigint  AS rakeback_users,
      COUNT(*) FILTER (WHERE COALESCE(b.unwagered_tips_usd, 0) > 0)::bigint      AS tips_users,
      COUNT(*) FILTER (WHERE
        COALESCE(b.unwagered_bonus_other_usd, 0) > 0
        OR COALESCE(b.unwagered_race_prize_usd, 0) > 0
        OR COALESCE(b.unwagered_affiliate_usd, 0) > 0
        OR COALESCE(b.unwagered_rakeback_usd, 0) > 0
        OR COALESCE(b.unwagered_tips_usd, 0) > 0
      )::bigint AS blocked_users,
      COUNT(*)::bigint AS total_customers
    FROM balances b
    WHERE b.user_id IN ${scopeSql}
  `,
  );
  const a = aggRows[0];
  if (!a) return { available: false };

  const bonusLocked = round2(num(a.bonus_other) + num(a.race_prize));
  const affiliateLocked = round2(num(a.affiliate));
  const rakebackLocked = round2(num(a.rakeback));
  const tipsLocked = round2(num(a.tips));

  const sources: WagerLiabilitySource[] = [
    {
      key: "bonus",
      label: "Bonus & race prizes",
      lockedUsd: bonusLocked,
      users: Number(a.bonus_users ?? 0),
    },
    {
      key: "affiliate",
      label: "Affiliate",
      lockedUsd: affiliateLocked,
      users: Number(a.affiliate_users ?? 0),
    },
    {
      key: "rakeback",
      label: "Rakeback",
      lockedUsd: rakebackLocked,
      users: Number(a.rakeback_users ?? 0),
    },
    {
      key: "tips",
      label: "Tips",
      lockedUsd: tipsLocked,
      users: Number(a.tips_users ?? 0),
    },
  ];
  sources.sort((x, y) => y.lockedUsd - x.lockedUsd);

  const totalGatedUsd = round2(
    bonusLocked + affiliateLocked + rakebackLocked + tipsLocked,
  );

  // ── Exempt count: per-user override of 0 bps, within customer scope ─────
  // `user_wager_requirements.wager_requirement_bps = 0` ⇒ fully exempt from
  // the entire requirement (backend doc semantics, mirrored in
  // users-wager-progress.ts). Scoped to the same customer population.
  const exemptRows = await db.$queryRawUnsafe<{ exempt: bigint | number }[]>(
    `
    SELECT COUNT(*)::bigint AS exempt
      FROM user_wager_requirements uwr
     WHERE uwr.wager_requirement_bps = 0
       AND uwr.user_id IN ${scopeSql}
  `,
  );
  const exemptUsers = Number(exemptRows[0]?.exempt ?? 0);

  // ── Cohort: blocked customers bucketed by total locked-balance size ─────
  // Buckets the blocked customers (any locked > 0) by their per-user total
  // locked across the five columns. Fixed, readable size bands.
  const bucketRows = await db.$queryRawUnsafe<RawBucketRow[]>(
    `
    WITH per_user AS (
      SELECT
        COALESCE(b.unwagered_bonus_other_usd, 0)
          + COALESCE(b.unwagered_race_prize_usd, 0)
          + COALESCE(b.unwagered_affiliate_usd, 0)
          + COALESCE(b.unwagered_rakeback_usd, 0)
          + COALESCE(b.unwagered_tips_usd, 0) AS locked
      FROM balances b
      WHERE b.user_id IN ${scopeSql}
    ),
    blocked AS (
      SELECT locked,
        CASE
          WHEN locked < 100 THEN 0
          WHEN locked < 1000 THEN 1
          WHEN locked < 10000 THEN 2
          ELSE 3
        END AS bucket
      FROM per_user
      WHERE locked > 0
    )
    SELECT bucket, COUNT(*)::bigint AS users, COALESCE(SUM(locked), 0)::text AS locked
      FROM blocked
     GROUP BY bucket
     ORDER BY bucket
  `,
  );

  const BUCKET_LABELS = [
    "Under $100",
    "$100 – $1k",
    "$1k – $10k",
    "$10k+",
  ];
  const byBucket = new Map<number, { users: number; locked: number }>();
  for (const r of bucketRows) {
    byBucket.set(Number(r.bucket), {
      users: Number(r.users ?? 0),
      locked: round2(num(r.locked)),
    });
  }
  const buckets: WagerLiabilityBucket[] = BUCKET_LABELS.map((label, i) => {
    const row = byBucket.get(i);
    return {
      label,
      users: row?.users ?? 0,
      lockedUsd: row?.locked ?? 0,
    };
  });

  return {
    available: true,
    totalGatedUsd,
    blockedUsers: Number(a.blocked_users ?? 0),
    exemptUsers,
    totalProgress: round2(num(a.wr_progress)),
    totalCustomers: Number(a.total_customers ?? 0),
    sources,
    buckets,
  };
}

// ─── Env-keyed cache wrapper ──────────────────────────────────────────
//
// `unstable_cache` runs its callback OUTSIDE the request's dynamic scope,
// so `cookies()` (and thus `readDbEnv` inside `getDb()`) falls back to
// "prod". Caching a dev-toggled request would serve PROD data to a dev
// admin (and the prod-keyed entry would be wrong). So: cache ONLY on prod
// (the default + hot path); a dev-toggled admin runs the query directly so
// they always see live dev data. Identical reasoning to
// `users-detail-cache.ts` / `shard-stats.ts`.
const cachedWagerLiability = unstable_cache(
  queryWagerLiability,
  ["insights-wager-liability-snapshot-v1"],
  { revalidate: 60, tags: ["insights-wager-liability"] },
);

/**
 * Public entry point. Current-state wager-requirement liability snapshot,
 * customer-scoped. Cached 60s on prod; direct (uncached) on a dev-toggled
 * admin so they see live dev data.
 */
export async function getWagerLiability(): Promise<WagerLiabilityResult> {
  const env = await readDbEnv();
  if (env !== "prod") return queryWagerLiability();
  return cachedWagerLiability();
}
