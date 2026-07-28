import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

test("Transactions exposes a permission-gated, active-only Fiat Fraud tab", () => {
  const page = read("src/app/(admin)/transactions/deposits/page.tsx");
  const tab = read(
    "src/app/(admin)/transactions/deposits/fiat-fraud-tab.tsx",
  );
  assert.match(page, /requirePageAccess\("\/transactions\/deposits"\)/);
  assert.match(page, /value: "fiat-fraud"/);
  assert.match(page, /<FiatFraudTab/);
  assert.match(page, /prefetch=\{false\}/);
  assert.match(tab, /<Suspense/);
  assert.match(tab, /TableSkeleton/);
});

test("Fiat Fraud reads durable caught history with server-side controls", () => {
  const api = read("src/lib/antifraud/fiat-email-catches-api.ts");
  const tab = read(
    "src/app/(admin)/transactions/deposits/fiat-fraud-tab.tsx",
  );
  const table = read(
    "src/app/(admin)/transactions/deposits/fiat-fraud-table.tsx",
  );

  assert.match(api, /\/v1\/fiat-email-catches/);
  assert.match(api, /page: String/);
  assert.match(api, /limit: String/);
  assert.match(api, /pagination: z\.object/);
  assert.match(api, /Math\.min\(10_000/);
  assert.match(api, /Math\.min\(100/);
  assert.match(api, /slice\(0, 100\)/);
  assert.match(api, /searchParams\.set\("search"/);
  assert.match(api, /searchParams\.set\("riskType"/);
  assert.match(api, /searchParams\.set\("source"/);
  assert.match(api, /"whop_checkout"/);
  assert.match(api, /"signup"/);
  assert.match(api, /searchParams\.set\("lockStatus"/);
  assert.match(api, /cache: "no-store"/);
  assert.match(tab, /DataTablePagination/);
  assert.match(table, /No fraudulent fiat deposits found/);
  assert.match(tab, /Fiat fraud history is unavailable/);
  assert.match(tab, /Durable fraud catches remain here/);
});

test("Fiat Fraud rows link to exact users and deposits without MAIN writes", () => {
  const table = read(
    "src/app/(admin)/transactions/deposits/fiat-fraud-table.tsx",
  );
  const query = read("src/lib/queries/fiat-fraud.ts");

  assert.match(table, /href=\{`\/users\/\$\{row\.userId\}`\}/);
  assert.match(
    table,
    /href=\{`\/transactions\/card-payments\/\$\{row\.depositIntentId\}`\}/,
  );
  assert.match(table, /Blocked email domain/);
  assert.match(table, /Suspicious deposit cluster/);
  assert.match(query, /getReadDrizzleDb/);
  assert.match(query, /fiat_deposit_intents/);
  assert.match(query, /slice\(0, 200\)/);
  assert.doesNotMatch(query, /\b(INSERT|UPDATE|DELETE)\b/);
});
