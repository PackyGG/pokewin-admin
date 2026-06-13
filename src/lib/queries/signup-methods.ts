import "server-only";

import { unstable_cache } from "next/cache";
import { Prisma } from "@/generated/prisma/client";
import { readDbEnv, type DbEnv } from "@/lib/db-env";
import { dbForEnv } from "@/lib/db";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "@/lib/queries/_blacklist";

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

  type Row = { method: SignupMethodKey; count: string };
  type OtherRow = { provider: string; count: string };

  const [methodRows, otherRows] = await Promise.all([
    db.$queryRaw<Row[]>`
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
      SELECT method, COUNT(*)::text AS count
        FROM classified
       GROUP BY method
    `,
    db.$queryRaw<OtherRow[]>`
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
      )
      SELECT pp.provider, COUNT(*)::text AS count
        FROM customers c
        JOIN primary_provider pp ON pp.user_id = c.id
       WHERE LOWER(pp.provider) NOT IN (
         'credential', 'credentials', 'email', 'email-password',
         'discord', 'google', 'steam'
       )
       GROUP BY pp.provider
       ORDER BY COUNT(*) DESC
    `,
  ]);

  const counts = new Map<SignupMethodKey, number>();
  for (const key of METHOD_ORDER) counts.set(key, 0);
  for (const row of methodRows) {
    counts.set(row.method, Number(row.count));
  }

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
    otherBreakdown: otherRows.map((row) => ({
      provider: row.provider,
      count: Number(row.count),
    })),
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
  return cachedSignupMethodStats(blacklist, env);
}