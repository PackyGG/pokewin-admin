import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

test("Fraud Transactions owns the permission-gated canonical Fiat Fraud page", () => {
  const adminPage = read("src/app/(admin)/transactions/deposits/page.tsx");
  const page = read("src/app/(antifraud)/antifraud/fiat-fraud/page.tsx");
  const sidebar = read(
    "src/app/(antifraud)/antifraud/_components/antifraud-sidebar.tsx",
  );
  const hosts = read("src/lib/app-hosts.ts");
  assert.match(page, /requireAntifraudPageAccess\(\)/);
  assert.match(page, /<FiatFraudContent/);
  assert.match(sidebar, /label: "Fiat Fraud"/);
  assert.match(sidebar, /href: "\/antifraud\/fiat-fraud"/);
  assert.match(hosts, /"fiat-fraud"/);
  assert.doesNotMatch(adminPage, /value: "fiat-fraud"/);
  assert.doesNotMatch(adminPage, /<FiatFraud(?:Tab|Content)/);
});

test("The retired Admin deep link redirects to Fraud with query state intact", () => {
  const adminPage = read("src/app/(admin)/transactions/deposits/page.tsx");
  assert.match(adminPage, /firstValue\("tab"\) === "fiat-fraud"/);
  assert.match(adminPage, /absoluteOriginForBasePath\("\/antifraud"\)/);
  assert.match(adminPage, /new URL\(\s*"\/fiat-fraud"/);
  assert.match(adminPage, /key === "tab"/);
  assert.match(adminPage, /destination\.searchParams\.append\(key, value\)/);
  assert.match(adminPage, /redirect\(destination\.toString\(\)\)/);
});

test("Fiat Fraud reads durable caught history with server-side controls", () => {
  const api = read("src/lib/antifraud/fiat-email-catches-api.ts");
  const content = read(
    "src/app/(antifraud)/antifraud/fiat-fraud/fiat-fraud-content.tsx",
  );
  const table = read(
    "src/app/(antifraud)/antifraud/fiat-fraud/fiat-fraud-table.tsx",
  );

  assert.match(api, /\/v1\/fiat-email-catches/);
  assert.match(api, /userId: z\.string\(\)\.trim\(\)\.min\(1\)\.max\(200\)/);
  assert.match(
    api,
    /depositIntentId: z\.string\(\)\.trim\(\)\.min\(1\)\.max\(200\)\.nullable\(\)/,
  );
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
  assert.match(content, /<Suspense/);
  assert.match(content, /TableSkeleton/);
  assert.match(content, /DataTablePagination/);
  assert.match(table, /No fraudulent fiat deposits found/);
  assert.match(content, /Fiat fraud history is unavailable/);
  assert.match(content, /Durable fraud catches remain here/);
});

test("Fiat Fraud rows link to exact users and deposits without MAIN writes", () => {
  const table = read(
    "src/app/(antifraud)/antifraud/fiat-fraud/fiat-fraud-table.tsx",
  );
  const query = read("src/lib/queries/fiat-fraud.ts");

  assert.match(table, /`https:\/\/\$\{ROOT_DOMAIN\}\$\{path\}`/);
  assert.match(table, /adminHref\(`\/users\/\$\{row\.userId\}`\)/);
  assert.match(
    table,
    /adminHref\(\s*`\/transactions\/card-payments\/\$\{row\.depositIntentId\}`/,
  );
  assert.match(table, /Blocked email domain/);
  assert.match(table, /Suspicious deposit cluster/);
  assert.match(query, /getReadDrizzleDb/);
  assert.match(query, /fiat_deposit_intents/);
  assert.match(query, /slice\(0, 200\)/);
  assert.doesNotMatch(query, /\b(INSERT|UPDATE|DELETE)\b/);
});
