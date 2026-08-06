import { sql } from "drizzle-orm";

import { getReadDrizzleDb } from "@/lib/db";
import { fiatRefundCreditUsdSql } from "@/lib/queries/fiat-refund-credits";
import { neutralizeCsvFormula } from "@/lib/utils/export-csv";

export type AllUsersRow = {
  email: string;
  username: string;
  deposit: string;
};

/**
 * Raw all-user export. Deposit values are net of finalized fiat refunds,
 * matching every dashboard and user-facing lifetime deposit total.
 */
export async function getAllUsersForExport(): Promise<AllUsersRow[]> {
  const db = await getReadDrizzleDb();
  const rows = (await db.execute<{
    email: string | null;
    username: string | null;
    deposit: string;
  }>(sql`
    SELECT u.email, u.username,
      GREATEST(0, COALESCE(b.total_deposited, 0) - COALESCE(fr.amount, 0))
        ::numeric(20,2)::text AS deposit
    FROM "user" u
    LEFT JOIN balances b ON b.user_id = u.id
    LEFT JOIN (
      SELECT i.user_id, SUM(${sql.raw(fiatRefundCreditUsdSql("i"))}) AS amount
      FROM fiat_deposit_intents i
      WHERE i.status IN ('partially_refunded', 'refunded')
      GROUP BY i.user_id
    ) fr ON fr.user_id = u.id
    ORDER BY u.created_at DESC
    LIMIT 500000
  `)).rows;

  return rows.map((r) => ({
    email: r.email ?? "",
    username: r.username ?? "",
    deposit: r.deposit,
  }));
}

export function allUsersToCsv(rows: AllUsersRow[]): string {
  const lines: string[] = [
    ["email", "username", "deposit_amount"].map(csvEscape).join(","),
  ];
  for (const r of rows) {
    lines.push([r.email, r.username, r.deposit].map(csvEscape).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

/**
 * Always-quote escaping PLUS formula neutralization. `email` / `username`
 * are player-controlled, and RFC 4180 quoting does not stop Excel / Sheets
 * evaluating a cell that starts with `=`, `+`, `-` or `@` — see
 * {@link neutralizeCsvFormula}.
 */
function csvEscape(value: string): string {
  const safe = neutralizeCsvFormula(value);
  return `"${safe.replace(/"/g, '""')}"`;
}
