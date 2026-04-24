// `@/lib/db` on main was refactored to export `getDb()` (async) +
// `getProdDb()` in place of the old `db` singleton — it now
// resolves the prod/dev DB per-request from a cookie. Use getDb()
// here so the email export follows whichever environment the
// calling admin has toggled on.
import { getDb } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";

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
  const db = await getDb();
  const rows = await db.$queryRawUnsafe<
    { country_code: string | null; country: string | null }[]
  >(`
    SELECT DISTINCT country_code, country
    FROM "user"
    WHERE country_code IS NOT NULL
    ORDER BY country ASC NULLS LAST
  `);
  return rows
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
  const where: Prisma.UserWhereInput = {};

  // Country filter
  const codes = [...new Set(
    filters.countryCodes
      .map((c) => c.trim().toUpperCase())
      .filter((c) => c.length > 0),
  )];
  if (filters.countryMode === "include" && codes.length > 0) {
    where.country_code = { in: codes };
  } else if (filters.countryMode === "exclude" && codes.length > 0) {
    // A user with a null country_code would match `notIn` in SQL via
    // Prisma — but we ALSO explicitly include those (no country data =
    // not one of the excluded) so the filter does what the admin expects.
    where.OR = [
      { country_code: null },
      { country_code: { notIn: codes } },
    ];
  }

  // Staff exclusion
  if (filters.excludeStaff) {
    where.role = { notIn: ["admin", "creator"] };
  }

  // Email requirement
  if (filters.requireEmail) {
    where.email = { not: null };
  }

  // Deposit filter
  if (filters.deposit === "has_deposited") {
    where.balances = {
      total_deposited: { gt: 0 },
    };
  } else if (filters.deposit === "no_deposit") {
    // Users with no deposits — either no balances row or
    // total_deposited = 0. Prisma's `is` + null combinator handles
    // the missing-row case via `none`; we express it via an OR.
    where.OR = [
      ...(where.OR ?? []),
      { balances: { is: null } },
      { balances: { is: { total_deposited: { equals: 0 } } } },
    ];
  }

  const db = await getDb();
  const rows = await db.user.findMany({
    where,
    select: {
      email: true,
      username: true,
      country: true,
      country_code: true,
      created_at: true,
      balances: {
        select: { total_deposited: true },
      },
    },
    orderBy: { created_at: "desc" },
    take: 200_000,
  });

  return rows
    .filter((r) => !filters.requireEmail || typeof r.email === "string")
    .map((r) => ({
      email: r.email ?? "",
      username: r.username,
      country: r.country,
      countryCode: r.country_code,
      totalDepositedUsd:
        r.balances?.total_deposited != null
          ? Number(r.balances.total_deposited)
          : 0,
      createdAt: r.created_at.toISOString(),
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
