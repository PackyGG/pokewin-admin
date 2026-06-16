import "server-only";

import { unstable_cache } from "next/cache";
import { Prisma } from "@/generated/prisma/client";
import { readDbEnv, type DbEnv } from "@/lib/db-env";
import { dbForEnv } from "@/lib/db";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "@/lib/queries/_blacklist";
import { resolveAdminRead } from "@/lib/clickhouse/resolve-read";
import { getSignupMethodStatsFromClickHouse } from "@/lib/clickhouse/queries/numbers/signup-methods";

export type SignupMethodKey =
  | "email"
  | "discord"
  | "google"
  | "steam"
  | "unknown"
  | "other";

export type SignupMethodRow = {
  key: SignupMethodKey;
  label: string;
  count: number;
  /** Share of all real-customer accounts (0–1). */
  share: number;
};

export type SignupMethodStats = {
  totalUsers: number;
  methods: SignupMethodRow[];
  /** Raw provider IDs rolled into the "other" bucket, when any. */
  otherBreakdown: { provider: string; count: number }[];
};

const METHOD_ORDER: SignupMethodKey[] = [
  "email",
  "discord",
  "google",
  "steam",
  "unknown",
  "other",
];

const METHOD_LABELS: Record<SignupMethodKey, string> = {
  email: "Email",
  discord: "Discord",
  google: "Google",
  steam: "Steam",
  unknown: "No linked account",
  other: "Other",
};

async function computeSignupMethodStats(
  blacklistIds: string[],
  env: DbEnv,
): Promise<SignupMethodStats> {
  const db = dbForEnv(env);
  const blacklistJoin = blacklistNotInClause("u.id", blacklistIds);

  // Single pass: the expensive `DISTINCT ON` provider pick (`primary_provider`)
  // and the per-customer classification (`classified`) are computed once and
  // reused for BOTH the method-count rollup and the "other"-bucket provider
  // breakdown. `classified` is referenced twice below, so Postgres materializes
  // it once instead of re-running the account scan per query (the previous
  // two-query Promise.all recomputed it twice). `row_kind` discriminates the
  // two UNION legs.
  type CombinedRow = {
    row_kind: "method" | "other";
    bucket: string;
    count: string;
  };

  const combinedRows = await db.$queryRaw<CombinedRow[]>`
    WITH customers AS (
      SELECT u.id
        FROM "user" u
       WHERE u.role NOT IN ('admin', 'support') ${Prisma.raw(blacklistJoin)}
    ),
    primary_provider AS (
      SELECT DISTINCT ON (a."userId")
             a."userId" AS user_id,
             a."providerId" AS provider
        FROM account a
        JOIN customers c ON c.id = a."userId"
       ORDER BY a."userId", a.created_at ASC NULLS LAST
    ),
    classified AS (
      SELECT
        c.id AS user_id,
        pp.provider AS provider,
        CASE
          WHEN pp.provider IS NULL THEN 'unknown'
          WHEN LOWER(pp.provider) IN ('credential', 'credentials', 'email', 'email-password') THEN 'email'
          WHEN LOWER(pp.provider) = 'discord' THEN 'discord'
          WHEN LOWER(pp.provider) = 'google' THEN 'google'
          WHEN LOWER(pp.provider) = 'steam' THEN 'steam'
          ELSE 'other'
        END AS method
      FROM customers c
      LEFT JOIN primary_provider pp ON pp.user_id = c.id
    )
    SELECT 'method'::text AS row_kind, method AS bucket, COUNT(*)::text AS count
      FROM classified
     GROUP BY method
    UNION ALL
    SELECT 'other'::text AS row_kind, provider AS bucket, COUNT(*)::text AS count
      FROM classified
     WHERE method = 'other'
     GROUP BY provider
  `;

  const counts = new Map<SignupMethodKey, number>();
  for (const key of METHOD_ORDER) counts.set(key, 0);
  const otherRows: { provider: string; count: number }[] = [];
  for (const row of combinedRows) {
    if (row.row_kind === "method") {
      counts.set(row.bucket as SignupMethodKey, Number(row.count));
    } else {
      otherRows.push({ provider: row.bucket, count: Number(row.count) });
    }
  }
  otherRows.sort((a, b) => b.count - a.count);

  const totalUsers = [...counts.values()].reduce((sum, n) => sum + n, 0);
  const methods: SignupMethodRow[] = METHOD_ORDER.map((key) => {
    const count = counts.get(key) ?? 0;
    return {
      key,
      label: METHOD_LABELS[key],
      count,
      share: totalUsers > 0 ? count / totalUsers : 0,
    };
  });

  return {
    totalUsers,
    methods,
    otherBreakdown: otherRows,
  };
}

const cachedSignupMethodStats = unstable_cache(
  computeSignupMethodStats,
  ["signup-method-stats-v1"],
  { revalidate: 300, tags: ["dashboard-lifetime"] },
);

export async function getSignupMethodStats(): Promise<SignupMethodStats> {
  const env = await readDbEnv();
  const blacklist = [...(await getExcludedUserIds())].sort();
  if (env !== "prod") {
    return computeSignupMethodStats(blacklist, env);
  }
  // CQRS serve-path: clickhouse mode serves the CH twin (SOLE read, throws
  // through on failure); off/comparison serve Postgres unchanged. The `numbers`
  // surface is shared with the pack-max-win leg; comparison-mode drift is logged
  // by the page's existing compareNumbers() call, so no compare thunk here.
  return resolveAdminRead<SignupMethodStats>("numbers", {
    pg: () => cachedSignupMethodStats(blacklist, env),
    ch: () => getSignupMethodStatsFromClickHouse(blacklist),
  });
}