// MAIN DB read. The request-scoped Drizzle resolver selects the
// prod/dev client from the admin's env cookie) — use it so this export
// follows whichever environment the calling admin has toggled on, same
// as the existing email-export query.
import { desc, eq, sql } from "drizzle-orm";
import { getReadDrizzleDb } from "@/lib/db";
import { balances, user } from "@/lib/db-schema/main/schema";

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
  const db = await getReadDrizzleDb();
  const rows = await db
    .select({
      email: user.email,
      username: user.username,
      // 1:1 relation on user_id; left join — null when the user has no
      // balances row, handled below as "0.00".
      deposit: sql<string>`COALESCE(${balances.total_deposited}, 0)::numeric(20,2)::text`,
    })
    .from(user)
    .leftJoin(balances, eq(balances.user_id, user.id))
    .orderBy(desc(user.created_at))
    .limit(500_000);

  return rows.map((r) => ({
    email: r.email ?? "",
    username: r.username ?? "",
    // total_deposited is selected as an exact numeric string, avoiding a
    // lossy JavaScript number conversion. Missing balances row → "0.00".
    deposit: r.deposit,
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
