import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(path, "utf8");

test("fiat deposits are a first-class Fraud transaction workspace", () => {
  const sidebar = read(
    "src/app/(antifraud)/antifraud/_components/antifraud-sidebar.tsx",
  );
  const hosts = read("src/lib/app-hosts.ts");
  const page = read(
    "src/app/(antifraud)/antifraud/fiat-deposits/page.tsx",
  );
  const detail = read(
    "src/app/(antifraud)/antifraud/fiat-deposits/[id]/page.tsx",
  );
  const api = read("src/lib/antifraud/fiat-deposits-api.ts");
  const actions = read(
    "src/app/(antifraud)/antifraud/fiat-deposits/actions.ts",
  );
  const kycAction = read(
    "src/app/(antifraud)/antifraud/fiat-deposits/fiat-kyc-action.tsx",
  );
  assert.match(sidebar, /Fiat Deposits/);
  assert.match(sidebar, /\/antifraud\/fiat-deposits/);
  assert.match(hosts, /"fiat-deposits"/);
  assert.match(page, /All paid/);
  assert.match(page, /Paid · reconciliation failed/);
  assert.match(page, /Expected credit/);
  assert.match(
    page,
    /Country:[\s\S]*?item\.account_evidence\.countryCode\?\.toUpperCase\(\)\s*\?\?\s*"Unknown"/,
  );
  assert.doesNotMatch(page, /checkout_ready/);
  assert.match(page, /Prior crypto/);
  assert.match(page, /Whop checkout:/);
  assert.match(api, /checkoutEmail/);
  assert.match(page, /Six-point flow/);
  assert.match(page, /Risk score guide/);
  assert.match(page, /Good[\s\S]*0–29/);
  assert.match(page, /Review[\s\S]*30–59/);
  assert.match(page, /High risk[\s\S]*60–100/);
  assert.match(page, /xl:grid-cols-5/);
  assert.match(page, /canManageAntifraud\(session\)/);
  assert.match(page, /<FiatKycAction/);
  assert.match(kycAction, /requireFiatDepositKyc/);
  assert.match(kycAction, /KYC is now required and withdrawals are locked/);
  assert.match(kycAction, /const isRequired = required \|\| currentlyRequired/);
  assert.match(kycAction, /result\.readbackConfirmed/);
  assert.match(kycAction, /A Sumsub result never unlocks/);
  assert.match(actions, /requireAntifraudManager\(/);
  assert.match(actions, /assessment\.data\.assessment\.user_id !== parsed\.data\.userId/);
  assert.match(actions, /getUserKyc\(/);
  assert.match(actions, /current\.kycRequired/);
  assert.match(actions, /requireUserKyc\(/);
  assert.match(
    actions,
    /confirmed\.kycRequired[\s\S]*confirmed\.verificationCycle === verificationCycle/,
  );
  assert.match(actions, /source: "antifraud_fiat_deposits"/);
  assert.match(detail, /Money trail/);
  assert.match(detail, /Whop risk signals/);
  assert.doesNotMatch(detail, /redirect\(["']\/fiat/);
});

test("fiat assessment API enforces exclusions and persists review state", () => {
  const api = read("src/lib/antifraud/fiat-deposits-api.ts");
  const routes = read(
    "services/antifraud-monitor/src/fiat-routes.ts",
  );
  const service = read(
    "services/antifraud-monitor/src/fiat-risk.ts",
  );
  const migration = read(
    "services/antifraud-monitor/migrations/012_fiat_deposit_assessments.sql",
  );
  assert.match(api, /getExcludedUserIdsStrict/);
  assert.match(api, /x-antifraud-excluded-users/);
  assert.match(routes, /userIsCreator/);
  assert.match(routes, /excluded\.has\(row\.user_id\)/);
  assert.match(routes, /FIAT_ASSESSMENT_STATUSES/);
  assert.match(service, /role::text,''\)<>'creator'/);
  assert.match(service, /payment_reconciliation_failed/);
  assert.match(service, /event_type='payment\.succeeded'/);
  assert.match(service, /provider_evidence/);
  assert.match(migration, /fiat_deposit_review_events/);
  assert.match(migration, /idempotency_key uuid NOT NULL UNIQUE/);
});

test("Antifraud stores sanitized provider evidence instead of raw Whop payloads", () => {
  const service = read(
    "services/antifraud-monitor/src/fiat-risk.ts",
  );
  const migration = read(
    "services/antifraud-monitor/migrations/012_fiat_deposit_assessments.sql",
  );
  assert.match(service, /SAFE_WHOP_SIGNALS/);
  assert.match(service, /parseWhopEvidence/);
  assert.doesNotMatch(migration, /\bpayload\b/);
  assert.doesNotMatch(migration, /billing_address/);
  assert.doesNotMatch(migration, /last4/);
});
