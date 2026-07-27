import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

test("withdrawals are exposed as their own Fraud transaction section", () => {
  const sidebar = read(
    "src/app/(antifraud)/antifraud/_components/antifraud-sidebar.tsx",
  );
  const hosts = read("src/lib/app-hosts.ts");
  assert.match(sidebar, /SidebarGroupLabel>Transactions/);
  assert.match(sidebar, /\/antifraud\/withdrawals/);
  assert.match(hosts, /"withdrawals"/);
});

test("the page reads the monitor service and never imports MAIN DB access", () => {
  const page = read("src/app/(antifraud)/antifraud/withdrawals/page.tsx");
  const api = read("src/lib/antifraud/withdrawals-api.ts");
  assert.match(page, /listWithdrawalAssessments/);
  assert.doesNotMatch(page, /@\/lib\/db/);
  assert.match(api, /\/v1\/withdrawals/);
  assert.doesNotMatch(api, /@\/lib\/db/);
});

test("the monitor service keeps the source pool read-only and persists assessments", () => {
  const database = read("services/antifraud-monitor/src/db.ts");
  const risk = read("services/antifraud-monitor/src/withdrawal-risk.ts");
  const migration = read(
    "services/antifraud-monitor/migrations/009_withdrawal_assessments.sql",
  );
  assert.match(database, /default_transaction_read_only=on/);
  assert.match(risk, /INSERT INTO withdrawal_assessments/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS withdrawal_assessments/);
});
