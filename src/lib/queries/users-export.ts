import { pgArrayParam } from "@/lib/drizzle-array-param";
// Use the request-scoped Drizzle client so the export follows whichever
// environment the calling admin has toggled on.
import { sql, type SQL } from "drizzle-orm";
import { getDrizzleDb } from "@/lib/db";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";

export type ExportDepositFilter = "any" | "has_deposited" | "no_deposit";

export type ExportCountryMode = "any" | "include" | "exclude";

export type UserExportFilters = {
  countryCodes: string[]; // ISO-2 codes, upper or lower case
  countryMode: ExportCountryMode;
  deposit: ExportDepositFilter;
  /**
   * If true, only export real users (exclude admin + creator staff
   * accounts). The typical email-export use case is marketing
   * outreach — staff addresses shouldn't land there. Default true.
   */
  excludeStaff: boolean;
  /**
   * If true, only export users with an email set. CSVs go to mail-
   * ing tools that treat blank addresses as errors. Default true.
   */
  requireEmail: boolean;
};

export type ExportedUser = {
  email: string;
  username: string | null;
  country: string | null;
  countryCode: string | null;
  totalDepositedUsd: number;
  createdAt: string;
};

/**
 * Distinct (country_code, country) pairs actually present on the
 * users table. Used to populate the export dialog's country picker
 * — we only surface countries that would produce matches, so the
 * admin isn't scrolling past 200 empty options.
 */
export async function getDistinctUserCountries(): Promise<
  { code: string; name: string }[]
> {
  const db = await getDrizzleDb();
  const result = await db.execute<{
    country_code: string | null;
    country: string | null;
  }>(sql`
    SELECT DISTINCT country_code, country
    FROM "user"
    WHERE country_code IS NOT NULL
    ORDER BY country ASC NULLS LAST
  `);
  return result.rows
    .filter((r): r is { country_code: string; country: string | null } =>
      typeof r.country_code === "string" && r.country_code.length > 0,
    )
    .map((r) => ({
      code: r.country_code.toUpperCase(),
      name: r.country ?? r.country_code,
    }));
}

/**
 * Return every user row that matches `filters`, projecting just the
 * fields that go into the CSV. Capped at 200k rows to keep the
 * serialized response bounded — hitting the cap should be extremely
 * rare for an email export, but prevents a runaway OOM if someone
 * toggles all filters to "any" on a large install.
 */
export async function exportUsers(
  filters: UserExportFilters,
): Promise<ExportedUser[]> {
  const predicates: SQL[] = [];

  const excluded = await getExcludedUserIds();
  if (excluded.length > 0)
    predicates.push(sql`u.id <> ALL(${pgArrayParam(excluded)}::text[])`);

  // OR-groups that must be ANDed together. The country-exclude filter and
  // the no-deposit filter are EACH a 2-leg OR; the old code wrote both
  // straight onto `where.OR`, so combining them collapsed
  // (country AND no-deposit) into one flat 4-leg OR — a user matching
  // EITHER condition leaked into the export (e.g. a depositing user from
  // a non-excluded country passed because the country legs matched).
  // Collect each group here and AND them at the end instead.

  // Country filter
  const codes = [...new Set(
    filters.countryCodes
      .map((c) => c.trim().toUpperCase())
      .filter((c) => c.length > 0),
  )];
  if (filters.countryMode === "include" && codes.length > 0) {
    predicates.push(sql`u.country_code = ANY(${pgArrayParam(codes)}::text[])`);
  } else if (filters.countryMode === "exclude" && codes.length > 0) {
    // Explicitly include null country codes (no country data =
    // not one of the excluded) so the filter does what the admin expects.
    predicates.push(
      sql`(u.country_code IS NULL OR u.country_code <> ALL(${pgArrayParam(codes)}::text[]))`,
    );
  }

  // Staff exclusion — mirrors the canonical CUSTOMER_EXCLUDED_ROLES
  // (src/lib/metrics/scope.ts: admin/support/creator). `support` was
  // previously missing here, so marketing exports emailed support staff.
  if (filters.excludeStaff) {
    predicates.push(sql`u.role NOT IN ('admin', 'support', 'creator')`);
  }

  // Email requirement
  if (filters.requireEmail) {
    predicates.push(sql`u.email IS NOT NULL`);
  }

  // Deposit filter
  if (filters.deposit === "has_deposited") {
    predicates.push(sql`COALESCE(b.total_deposited, 0) > 0`);
  } else if (filters.deposit === "no_deposit") {
    // Users with no deposits — either no balances row or
    // total_deposited = 0. COALESCE handles the missing-row case.
    predicates.push(sql`COALESCE(b.total_deposited, 0) = 0`);
  }

  const whereSql =
    predicates.length > 0
      ? sql`WHERE ${sql.join(predicates, sql` AND `)}`
      : sql``;
  const db = await getDrizzleDb();
  const result = await db.execute<{
    email: string | null;
    username: string | null;
    country: string | null;
    country_code: string | null;
    total_deposited: string | null;
    created_at: Date | string;
  }>(sql`
    SELECT
      u.email,
      u.username,
      u.country,
      u.country_code,
      b.total_deposited::text AS total_deposited,
      u.created_at
    FROM "user" u
    LEFT JOIN balances b ON b.user_id = u.id
    ${whereSql}
    ORDER BY u.created_at DESC
    LIMIT 200000
  `);

  return result.rows
    .filter((r) => !filters.requireEmail || typeof r.email === "string")
    .map((r) => ({
      email: r.email ?? "",
      username: r.username,
      country: r.country,
      countryCode: r.country_code,
      totalDepositedUsd:
        r.total_deposited != null ? Number(r.total_deposited) : 0,
      createdAt: new Date(r.created_at).toISOString(),
    }));
}

/**
 * Serialize rows to an RFC-4180 CSV. Quotes every field to keep the
 * output portable across Excel / Numbers / Sheets / command-line
 * tools, and handles commas / quotes / newlines embedded inside
 * values via the standard double-quote doubling escape.
 */
export function rowsToCsv(rows: ExportedUser[]): string {
  const header = [
    "email",
    "username",
    "country",
    "country_code",
    "total_deposited_usd",
    "has_deposited",
    "created_at",
  ];
  const lines: string[] = [header.map(escape).join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.email,
        r.username ?? "",
        r.country ?? "",
        r.countryCode ?? "",
        r.totalDepositedUsd.toFixed(2),
        r.totalDepositedUsd > 0 ? "yes" : "no",
        r.createdAt,
      ]
        .map(escape)
        .join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}

function escape(value: string | number): string {
  const s = String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return `"${s}"`;
}
