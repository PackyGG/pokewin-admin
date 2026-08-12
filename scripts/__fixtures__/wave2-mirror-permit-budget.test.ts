import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { isTransientPostgresReadError } from "@/lib/postgres-read-retry";

const read = (path: string) => readFileSync(path, "utf8");

/** `55_000` / `180_000` style literals -> number. */
function numericLiteral(source: string, pattern: RegExp): number {
  const captured = source.match(pattern)?.[1];
  if (!captured) throw new Error(`could not read ${pattern} from source`);
  return Number(captured.replaceAll("_", ""));
}

/**
 * The mirror pool has two slots and one process-wide permit per slot
 * (`withReadAdmissionControl`). A timeboxed transaction holds ONE permit for
 * its whole duration, so its worst case is the raised per-statement budget
 * times the number of statements it runs. If the permit watchdog can fire
 * before that, it hands out a permit whose pool slot is still busy, the
 * limiter over-admits into a two-slot pool, and the extra reader dies on
 * `connectionTimeoutMillis` with `timeout exceeded when trying to connect` —
 * the exact failure admission control was added to remove.
 */
test("mirror permit watchdog outlasts the longest sanctioned transaction hold", () => {
  const db = read("src/lib/db.ts");
  const creatorPnl = read("src/lib/queries/creators-pnl.ts");

  const watchdogMs = numericLiteral(
    db,
    /const READ_PERMIT_WATCHDOG_MS = ([\d_]+);/,
  );
  const perStatementMs = numericLiteral(
    creatorPnl,
    /export const CREATOR_PNL_STATEMENT_TIMEOUT_MS = ([\d_]+);/,
  );

  // Statements issued on the single checkout `queryMainRowsInTimeboxedTx`
  // opens in `getCreatorPnl` — the widest raised-budget transaction in the app.
  const statements = creatorPnl.match(/await query</g)?.length ?? 0;
  assert.equal(statements, 3);

  assert.ok(
    watchdogMs >= perStatementMs * statements,
    `READ_PERMIT_WATCHDOG_MS (${watchdogMs}ms) must cover ${statements} x ` +
      `CREATOR_PNL_STATEMENT_TIMEOUT_MS (${perStatementMs}ms)`,
  );
});

/**
 * Re-pins the documented contract of `withTransientPostgresReadRetry`: a
 * second connection attempt during capacity exhaustion amplifies the outage,
 * so no admission-refusal error may be classified as transient. A wave-1 audit
 * finding claimed the classifier retried pg's pool-acquire failure; these cases
 * are the counter-evidence, including the SQLSTATEs a shared 30-session mirror
 * role actually raises.
 */
test("capacity and admission refusals are never treated as transient", () => {
  const capacityFailures: Array<[string, string]> = [
    ["53300", "sorry, too many clients already"],
    ["53300", 'too many connections for role "fraud_app"'],
    ["53300", 'too many connections for database "packy"'],
    [
      "53300",
      "remaining connection slots are reserved for non-replication superuser connections",
    ],
    ["53400", "configuration limit exceeded"],
    ["53200", "out of memory"],
    // node-postgres' pool-acquire failure carries no SQLSTATE.
    ["", "timeout exceeded when trying to connect"],
  ];

  for (const [code, message] of capacityFailures) {
    const error = code
      ? Object.assign(new Error(message), { code })
      : new Error(message);
    assert.equal(
      isTransientPostgresReadError(error),
      false,
      `${code || "no code"} ${message} must not be retried`,
    );
    assert.equal(
      isTransientPostgresReadError(new Error("Failed query", { cause: error })),
      false,
      `${code || "no code"} ${message} must not be retried when wrapped`,
    );
  }

  // Control: a dropped connection stays retryable, so the assertions above
  // cannot pass by accident on a regex that matches nothing.
  assert.equal(
    isTransientPostgresReadError(
      Object.assign(new Error("terminating connection due to administrator command"), {
        code: "57P01",
      }),
    ),
    true,
  );
});
