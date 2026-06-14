/**
 * Read-only SQL guard for the ClickHouse read layer (DEFENSE IN DEPTH).
 *
 * The runtime protects ClickHouse three ways; this guard is the first:
 *   1. This guard — rejects write/DDL/maintenance statements at the app
 *      boundary before a query ever reaches the server.
 *   2. The read helper only ever exposes `query()` — never `insert()`,
 *      `command()`, or `exec()` (see ./readonly-query.ts).
 *   3. Every statement runs with the ClickHouse session setting `readonly = 2`
 *      (reads + may set execution limits, but NO writes/DDL — see ./client.ts).
 *
 * PURE string module — intentionally NO `import "server-only"` and no other
 * imports — so it is unit-testable from the node:test parity harness
 * (scripts/__fixtures__/*.test.ts) without tripping the server-only barrier.
 */

export class ClickHouseReadOnlyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClickHouseReadOnlyError";
  }
}

// A normalized statement MUST start with one of these verbs. SHOW / DESC(RIBE)
// / EXPLAIN are inherently read-only meta-commands (they never mutate), so they
// skip the keyword scan below — this is what lets `SHOW CREATE TABLE x` through.
const ALLOWED_LEADING = ["SELECT", "WITH", "SHOW", "DESC", "DESCRIBE", "EXPLAIN"];
const META_LEADING = new Set(["SHOW", "DESC", "DESCRIBE", "EXPLAIN"]);

// Write / DDL / privilege verbs that must never appear as a standalone word in a
// SELECT/WITH statement. Deliberately excludes:
//   • SYSTEM / SET  → blocked as leading verbs (not in ALLOWED_LEADING); also
//     valid as the `system` database name / the `SETTINGS` clause in reads.
//   • REPLACE / MOVE / FREEZE / EXCHANGE / FETCH → either ClickHouse read
//     functions (replace(), …) or read clauses (OFFSET … FETCH), and their
//     dangerous forms are CREATE/ALTER/ATTACH-prefixed (already covered).
// `\b…\b` does NOT match inside identifiers (created_at, _peerdb_is_deleted,
// drop_rate), so legitimate columns are never false-positived.
const FORBIDDEN = [
  "INSERT", "UPDATE", "DELETE", "ALTER", "DROP", "TRUNCATE", "CREATE",
  "OPTIMIZE", "RENAME", "ATTACH", "DETACH", "GRANT", "REVOKE", "KILL",
];

/** Strip block + line comments and collapse whitespace so keywords can't hide. */
function normalizeSql(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Split on `;`, dropping empties (so a single trailing `;` is harmless). */
function splitStatements(normalized: string): string[] {
  return normalized
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function assertReadOnlySql(sql: string): void {
  if (typeof sql !== "string" || sql.trim().length === 0) {
    throw new ClickHouseReadOnlyError("Empty SQL is not allowed.");
  }

  const statements = splitStatements(normalizeSql(sql));
  if (statements.length === 0) {
    throw new ClickHouseReadOnlyError("No executable SQL statement found.");
  }
  // A read helper issues exactly one statement; `;`-chains are a write-piggyback
  // vector, so more than one statement is rejected outright.
  if (statements.length > 1) {
    throw new ClickHouseReadOnlyError(
      "Multiple statements are not allowed in a read query.",
    );
  }

  const stmt = statements[0];
  const upper = stmt.toUpperCase();
  const leading = upper.replace(/^\(+/, "").trimStart().split(/[\s(]/)[0];

  if (!ALLOWED_LEADING.includes(leading)) {
    throw new ClickHouseReadOnlyError(
      `Read query must start with one of ${ALLOWED_LEADING.join(", ")} (got "${leading || "?"}").`,
    );
  }

  // Meta-commands (SHOW/DESC/EXPLAIN) can't mutate — allow without the scan.
  if (META_LEADING.has(leading)) return;

  for (const kw of FORBIDDEN) {
    if (new RegExp(`\\b${kw}\\b`, "i").test(stmt)) {
      throw new ClickHouseReadOnlyError(
        `Forbidden keyword "${kw}" detected in read query.`,
      );
    }
  }

  // SELECT … INTO OUTFILE writes a file — not a permitted read.
  if (/\bINTO\s+OUTFILE\b/i.test(stmt)) {
    throw new ClickHouseReadOnlyError("INTO OUTFILE is not allowed.");
  }
}

export function isReadOnlySql(sql: string): boolean {
  try {
    assertReadOnlySql(sql);
    return true;
  } catch {
    return false;
  }
}
