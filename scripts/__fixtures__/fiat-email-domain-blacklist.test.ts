import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

test("Fraud System owns the manager-only email blacklist without a reason field", () => {
  const sidebar = read(
    "src/app/(antifraud)/antifraud/_components/antifraud-sidebar.tsx",
  );
  const hosts = read("src/lib/app-hosts.ts");
  const page = read(
    "src/app/(antifraud)/antifraud/email-blacklist/page.tsx",
  );
  const actions = read(
    "src/app/(antifraud)/antifraud/email-blacklist/actions.ts",
  );

  assert.match(sidebar, /SidebarGroupLabel>System/);
  assert.match(sidebar, /\/antifraud\/email-blacklist/);
  assert.match(hosts, /"email-blacklist"/);
  assert.match(page, /requireAntifraudManagerPage/);
  assert.match(actions, /requireAntifraudManager/);
  assert.match(actions, /fiat_email_domain_blacklisted/);
  const client = read(
    "src/app/(antifraud)/antifraud/email-blacklist/email-blacklist-client.tsx",
  );
  assert.doesNotMatch(client, /blacklist-reason|<Textarea|rule\.reason/);
  assert.match(page, /key=\{result\.data/);
  assert.match(page, /rule\.updatedAt/);
  assert.match(client, /isCheckingHistory/);
  assert.match(client, /setInterval\(\(\) => router\.refresh\(\), 3_000\)/);
});

test("blacklisted signup and Whop signals lock MAIN only through signed ingest", () => {
  const monitor = read(
    "services/antifraud-monitor/src/fiat-email-domains.ts",
  );
  const ingest = read("src/app/api/antifraud/ingest/route.ts");

  assert.match(monitor, /INSERT INTO risk_events/);
  assert.match(monitor, /fiat_blacklisted_email_domain/);
  assert.match(monitor, /persistSignupMatch/);
  assert.match(monitor, /match_source: "signup"/);
  assert.doesNotMatch(monitor, /UPDATE user_feature_locks/);
  assert.match(ingest, /getProdPrimaryDrizzleDb/);
  assert.match(ingest, /ARRAY\['all'\]::text\[\]/);
  assert.match(ingest, /locked_withdrawals_items = TRUE/);
  assert.match(ingest, /signal\.riskScore !== 100/);
});

test("Fraud Fiat deposits force blacklist matches to the critical score", () => {
  const risk = read("services/antifraud-monitor/src/fiat-risk.ts");

  assert.match(risk, /blacklisted_checkout_email_domain/);
  assert.match(risk, /riskScore: 100/);
  assert.match(risk, /verdict: "bad"/);
  assert.match(risk, /Keep crypto and item withdrawals locked/);
});
