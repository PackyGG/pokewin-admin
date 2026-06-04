// MAIN DB read. `@/lib/db` exposes `getDb()` (async, resolves the
// prod/dev client from the admin's env cookie) — use it so this export
// follows whichever environment the calling admin has toggled on, same
// as the existing email-export query.
import { getDb } from "@/lib/db";

/**
 * One CSV row of the motha-only "all users" export: exactly the three
 * requested columns. `email` may be empty (the DB column is nullable);
 * `deposit` is a plain Decimal string from `balances.total_deposited`
 * (`Decimal(20,2)`), defaulting to "0.00" for users with no balances
 * row (left join).
 */
export type AllUsersRow = {
  email: string;
  username: string;
  deposit: string;
};

/**
 * Every user, projecting ONLY the three columns the export needs:
 * email, username, and total deposited. This is a raw export — NO
 * staff-exclusion and NO email/deposit filtering (the caller asked for
 * "all users"). Users with no `balances` row come back with deposit
 * "0.00".
 *
 * Capped at 500k rows as an OOM backstop — the whole table is read in
 * one shot and serialized into a single string, so the cap keeps a
 * pathological install from blowing the function's memory. Real user
 * counts are far below this.
 */
export async function getAllUsersForExport(): Promise<AllUsersRow[]> {
  const db = await getDb();
  const rows = await db.user.findMany({
    select: {
      email: true,
      username: true,
      // 1:1 relation on user_id; left join — null when the user has no
      // balances row, handled below as "0.00".
      balances: { select: { total_deposited: true } },
    },
    orderBy: { created_at: "desc" },
    take: 500_000,
  });

  return rows.map((r) => ({
    email: r.email ?? "",
    username: r.username ?? "",
    // total_deposited is a Prisma Decimal — `.toFixed(2)` keeps the
    // exact 2-dp value as a string WITHOUT going through a lossy JS
    // number. Missing balances row → "0.00".
    deposit: r.balances?.total_deposited?.toFixed(2) ?? "0.00",
  }));
}

/**
 * Serialize the rows to an RFC-4180 CSV with header
 * `email,username,deposit_amount`. Every field is quoted and embedded
 * quotes are doubled, so emails / usernames containing commas, quotes,
 * or newlines stay intact. Mirrors the escape used by the existing
 * `rowsToCsv` in `src/lib/queries/users-export.ts`.
 */
export function allUsersToCsv(rows: AllUsersRow[]): string {
  const lines: string[] = [
    ["email", "username", "deposit_amount"].map(csvEscape).join(","),
  ];
  for (const r of rows) {
    lines.push([r.email, r.username, r.deposit].map(csvEscape).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

function csvEscape(value: string): string {
  // Quote-wrap everything (portable across Excel / Sheets / Numbers /
  // CLI tools) and double any embedded quotes per RFC 4180.
  return `"${value.replace(/"/g, '""')}"`;
}
