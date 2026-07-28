import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

type LifecycleRow = {
  intentStatus: string;
  role?: string;
  blacklisted?: boolean;
  ledgerId: string | null;
  ledgerStatus?: string;
  ledgerType?: string;
  ledgerAmountUsd?: number;
  reversedCreditUsd?: number;
};

function aggregateCreditedLifecycle(rows: LifecycleRow[]) {
  const ledgers = new Map<
    string,
    { grossUsd: number; reversedUsd: number }
  >();

  for (const row of rows) {
    if (
      !row.ledgerId ||
      row.role === "admin" ||
      row.role === "support" ||
      row.ledgerStatus !== "completed" ||
      row.ledgerType !== "deposit"
    ) {
      continue;
    }

    const grossUsd = row.ledgerAmountUsd ?? 0;
    const lifecycleReversal =
      row.intentStatus === "refunded" || row.intentStatus === "disputed"
        ? grossUsd
        : row.intentStatus === "partially_refunded"
          ? Math.min(grossUsd, Math.max(0, row.reversedCreditUsd ?? 0))
          : 0;
    const current = ledgers.get(row.ledgerId);
    ledgers.set(row.ledgerId, {
      grossUsd,
      reversedUsd: Math.max(current?.reversedUsd ?? 0, lifecycleReversal),
    });
  }

  const values = [...ledgers.values()];
  const grossUsd = values.reduce((sum, row) => sum + row.grossUsd, 0);
  const reversedUsd = values.reduce((sum, row) => sum + row.reversedUsd, 0);
  return {
    paymentCount: values.length,
    grossUsd,
    reversedUsd,
    netUsd: grossUsd - reversedUsd,
  };
}

test("fiat overview preserves original credits across later lifecycle states", () => {
  const result = aggregateCreditedLifecycle([
    {
      intentStatus: "completed",
      ledgerId: "partial",
      ledgerStatus: "completed",
      ledgerType: "deposit",
      ledgerAmountUsd: 100,
    },
    {
      intentStatus: "partially_refunded",
      ledgerId: "partial",
      ledgerStatus: "completed",
      ledgerType: "deposit",
      ledgerAmountUsd: 100,
      reversedCreditUsd: 30,
    },
    {
      intentStatus: "refunded",
      ledgerId: "refund",
      ledgerStatus: "completed",
      ledgerType: "deposit",
      ledgerAmountUsd: 50,
    },
    {
      intentStatus: "disputed",
      ledgerId: "dispute",
      ledgerStatus: "completed",
      ledgerType: "deposit",
      ledgerAmountUsd: 25,
    },
  ]);

  assert.deepEqual(result, {
    paymentCount: 3,
    grossUsd: 175,
    reversedUsd: 105,
    netUsd: 70,
  });
});

test("fiat overview excludes never-credited rows and deduplicates ledger credits", () => {
  const result = aggregateCreditedLifecycle([
    { intentStatus: "pending", ledgerId: null, ledgerAmountUsd: 900 },
    { intentStatus: "failed", ledgerId: null, ledgerAmountUsd: 800 },
    { intentStatus: "canceled", ledgerId: null, ledgerAmountUsd: 700 },
    {
      intentStatus: "completed",
      ledgerId: "one-credit",
      ledgerStatus: "completed",
      ledgerType: "deposit",
      ledgerAmountUsd: 20,
    },
    {
      intentStatus: "completed",
      ledgerId: "one-credit",
      ledgerStatus: "completed",
      ledgerType: "deposit",
      ledgerAmountUsd: 20,
    },
    {
      intentStatus: "completed",
      ledgerId: "wrong-type",
      ledgerStatus: "completed",
      ledgerType: "admin_adjustment",
      ledgerAmountUsd: 500,
    },
  ]);

  assert.deepEqual(result, {
    paymentCount: 1,
    grossUsd: 20,
    reversedUsd: 0,
    netUsd: 20,
  });
});

test("fiat overview uses the USD ledger amount instead of provider currency amounts", () => {
  const result = aggregateCreditedLifecycle([
    {
      intentStatus: "completed",
      ledgerId: "eur-checkout",
      ledgerStatus: "completed",
      ledgerType: "deposit",
      ledgerAmountUsd: 42,
    },
  ]);

  assert.equal(result.grossUsd, 42);
});

test("blacklisted customers and creators remain in operational credit totals", () => {
  const result = aggregateCreditedLifecycle([
    {
      intentStatus: "completed",
      role: "user",
      blacklisted: true,
      ledgerId: "blacklisted-real-credit",
      ledgerStatus: "completed",
      ledgerType: "deposit",
      ledgerAmountUsd: 15,
    },
    {
      intentStatus: "completed",
      role: "creator",
      ledgerId: "creator-credit",
      ledgerStatus: "completed",
      ledgerType: "deposit",
      ledgerAmountUsd: 25,
    },
    {
      intentStatus: "completed",
      role: "admin",
      ledgerId: "test-credit",
      ledgerStatus: "completed",
      ledgerType: "deposit",
      ledgerAmountUsd: 50,
    },
  ]);

  assert.deepEqual(result, {
    paymentCount: 2,
    grossUsd: 40,
    reversedUsd: 0,
    netUsd: 40,
  });
});

test("production overview query enforces the lifecycle and staff-scope contract", () => {
  const source = readFileSync(
    path.join(root, "src/lib/queries/fiat.ts"),
    "utf8",
  );

  assert.match(source, /INNER JOIN ledger_transactions lt/);
  assert.match(source, /lt\.type = 'deposit'/);
  assert.match(source, /lt\.status = 'completed'/);
  assert.match(source, /GROUP BY lt\.id, lt\.amount, lt\.created_at/);
  assert.match(source, /SUM\(credited_usd\) \* 100/);
  assert.match(source, /i\.status IN \('refunded', 'disputed'\)/);
  assert.match(source, /i\.status = 'partially_refunded'/);
  assert.match(source, /fiatRefundCreditCentsSql\("i"\)/);
  assert.match(
    source,
    /role NOT IN \('admin', 'support'\)/,
  );
  assert.doesNotMatch(source, /getExcludedUserIds|BlacklistedSqlFromIds/);
  assert.doesNotMatch(source, /role NOT IN \('admin', 'support', 'creator'\)/);
});
