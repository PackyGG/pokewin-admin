import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import type {
  SignupMethodKey,
  SignupMethodRow,
  SignupMethodStats,
} from "@/lib/queries/signup-methods";

import { CH_DB } from "../_shared";

/**
 * ClickHouse twin of the /numbers signup-method breakdown (Phase 2B
 * comparison-mode). Returns the SAME `SignupMethodStats` shape as the canonical
 * Postgres twin `getSignupMethodStats` (`src/lib/queries/signup-methods.ts`).
 *
 * PARITY with the Postgres definition:
 *   • customers — `role NOT IN ('admin','support')` (creators are KEPT, the
 *     2-role scope this surface uses — NOT the wholesale 3-role customer scope)
 *     + the dynamic `excluded_users` blacklist (`u.id NOT IN (...)`).
 *   • primary_provider — the EARLIEST linked account per customer
 *     (`DISTINCT ON (userId) ORDER BY created_at ASC NULLS LAST`). The CH twin
 *     reproduces "earliest, nulls last" with
 *     `argMin(providerId, ifNull(created_at, <far-future sentinel>))`.
 *   • classified — every customer bucketed by lower(provider): credential/email
 *     variants → email, discord/google/steam direct, anything else → other, and
 *     a customer with NO account row → unknown. In ClickHouse a LEFT JOIN fills
 *     an unmatched right side with the column DEFAULT (empty string for String,
 *     `join_use_nulls=0`), so the no-account case is detected as
 *     `provider = ''` — which is unambiguous because `account.providerId` is
 *     NOT NULL and never empty in the source (mirrors PG `provider IS NULL`).
 *   • otherBreakdown — raw provider ids rolled into the "other" bucket, ordered
 *     by count desc (mirrors the PG `ORDER BY COUNT(*) DESC`).
 *
 * ClickHouse correctness (PeerDB / ReplacingMergeTree mirrors): dedup latest row
 * per id with FINAL, drop soft-deleted rows with `_peerdb_is_deleted = 0`. There
 * is no money here — every measure is an exact integer count. The blacklist is
 * passed IN by the caller (fetched from the admin DB via getExcludedUserIds) so
 * this module never imports a Postgres/Prisma client — it is a pure ClickHouse
 * read.
 *
 * METHOD_ORDER / METHOD_LABELS are duplicated from the PG twin (rather than
 * imported) because that module is Prisma-coupled (`@/lib/db`) and the CH read
 * graph must never reach a Postgres client — the parity script proves the two
 * stay in lock-step.
 */

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

/**
 * Shared customer + earliest-provider CTE chain, mirroring the PG `customers`
 * and `primary_provider` CTEs. `argMin(providerId, ifNull(created_at, sentinel))`
 * reproduces `DISTINCT ON (userId) ORDER BY created_at ASC NULLS LAST` (NULL
 * created_at sorts last, so the earliest non-null linked account wins).
 */
function ctes(hasBlacklist: boolean): string {
  return `
    real_users AS (
      SELECT id
      FROM ${CH_DB}.public_user FINAL
      WHERE _peerdb_is_deleted = 0
        AND role NOT IN ('admin','support')
        ${hasBlacklist ? "AND id NOT IN {blacklist:Array(String)}" : ""}
    ),
    primary_provider AS (
      SELECT
        a.userId AS user_id,
        argMin(a.providerId, ifNull(a.created_at, toDateTime64('2999-12-31 00:00:00.000', 6))) AS provider
      FROM ${CH_DB}.public_account AS a FINAL
      WHERE a._peerdb_is_deleted = 0
        AND a.userId IN (SELECT id FROM real_users)
      GROUP BY a.userId
    )`;
}

// Classification expression — the CH twin of the PG CASE. Note the leading
// `provider = ''` branch catches the LEFT-JOIN no-match (no linked account →
// PG `provider IS NULL`).
const METHOD_EXPR = `multiIf(
    pp.provider = '', 'unknown',
    lower(pp.provider) IN ('credential','credentials','email','email-password'), 'email',
    lower(pp.provider) = 'discord', 'discord',
    lower(pp.provider) = 'google', 'google',
    lower(pp.provider) = 'steam', 'steam',
    'other'
  )`;

type MethodRow = { method: SignupMethodKey; count: string };
type OtherRow = { provider: string; count: string };

export async function getSignupMethodStatsFromClickHouse(
  blacklist: string[],
): Promise<SignupMethodStats> {
  const hasBlacklist = blacklist.length > 0;
  const params: Record<string, unknown> = { blacklist };
  const cteSql = ctes(hasBlacklist);

  const [methodRows, otherRows] = await Promise.all([
    clickhouseRead.query<MethodRow>({
      queryName: "numbers.signup_methods.by_method",
      sql: `
        WITH ${cteSql}
        SELECT
          ${METHOD_EXPR} AS method,
          toString(count()) AS count
        FROM real_users AS ru
        LEFT JOIN primary_provider AS pp ON pp.user_id = ru.id
        GROUP BY method`,
      params,
    }),
    clickhouseRead.query<OtherRow>({
      queryName: "numbers.signup_methods.other_breakdown",
      sql: `
        WITH ${cteSql}
        SELECT
          pp.provider AS provider,
          toString(count()) AS count
        FROM primary_provider AS pp
        WHERE lower(pp.provider) NOT IN (
          'credential','credentials','email','email-password',
          'discord','google','steam'
        )
        GROUP BY pp.provider
        ORDER BY count() DESC`,
      params,
    }),
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
