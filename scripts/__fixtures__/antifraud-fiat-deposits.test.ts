import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  getStaffCheckedWithdrawalUserIds,
  type StaffWithdrawalReviewEvent,
} from "../../src/lib/antifraud/withdrawal-review-status";

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
    "src/app/(antifraud)/antifraud/fiat-deposits/[id]/review-workspace.tsx",
  );
  const api = read("src/lib/antifraud/fiat-deposits-api.ts");
  const actions = read(
    "src/app/(antifraud)/antifraud/fiat-deposits/actions.ts",
  );
  const kycAction = read(
    "src/app/(antifraud)/antifraud/fiat-deposits/fiat-kyc-action.tsx",
  );
  assert.match(sidebar, /label: "Deposits"/);
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
  assert.match(page, /Checkout email/);
  assert.match(page, /label="Card"/);
  assert.match(page, /cardLast4/);
  assert.match(page, /label="Fees"/);
  assert.match(page, /score_breakdown/);
  assert.match(page, /TransactionRailTabs/);
  assert.match(page, /method: "crypto"/);
  assert.match(page, /Fraud tagged/);
  assert.match(page, /whopPaymentMethodLabel/);
  assert.match(page, /Show KYC required/);
  assert.match(page, /Hide KYC required/);
  assert.match(page, /includeKycRequired: value\("includeKycRequired"\) === "true"/);
  assert.match(
    page,
    /excludeKycRequired: !state\.includeKycRequired && !state\.search/,
  );
  assert.match(api, /params\.set\("excludeKycRequired", "true"\)/);
  assert.match(detail, /Payment option/);
  assert.match(detail, /whopPaymentMethodLabel/);
  assert.match(api, /checkoutEmail/);
  assert.match(api, /cardBrand/);
  assert.match(api, /cardLast4/);
  assert.match(page, /Six-point flow/);
  assert.match(page, /Risk score guide/);
  assert.match(page, /Good[\s\S]*0–29/);
  assert.match(page, /Review[\s\S]*30–59/);
  assert.match(page, /High risk[\s\S]*60–100/);
  assert.match(page, /xl:grid-cols-5/);
  assert.match(page, /canManageAntifraud\(session\)/);
  assert.match(page, /<FiatKycAction/);
  assert.match(page, /getFiatStaffCheckedWithdrawalUserIds/);
  assert.match(page, /staffChecked=\{checkedWithdrawalUsers\.has\(item\.user_id\)\}/);
  assert.match(page, /Account previously checked by staff/);
  assert.match(page, /BadgeCheck/);
  assert.match(kycAction, /requireFiatDepositKyc/);
  assert.match(kycAction, /KYC is now required for this locked account/);
  assert.match(kycAction, /const isRequired = required \|\| currentlyRequired/);
  assert.match(kycAction, /result\.readbackConfirmed/);
  assert.match(kycAction, /A Sumsub result never unlocks/);
  assert.match(actions, /requireAntifraudManager\(/);
  assert.match(actions, /assessment\.data\.assessment\.user_id !== parsed\.data\.userId/);
  assert.match(actions, /getUserKyc\(/);
  assert.match(actions, /current\.kycRequired/);
  assert.match(
    actions,
    /isLockedAccountEligibleForKyc\(parsed\.data\.userId\)/,
  );
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

test("fiat rows mark only a completed staff withdrawal-lock review", () => {
  const event = (
    targetUserId: string,
    eventType: StaffWithdrawalReviewEvent["eventType"],
    createdAt: string,
  ): StaffWithdrawalReviewEvent => ({
    targetUserId,
    eventType,
    createdAt,
  });
  const events: StaffWithdrawalReviewEvent[] = [
    event("checked", "locked_withdrawals_crypto_enabled", "2026-07-01T10:00:00Z"),
    event("checked", "locked_withdrawals_items_enabled", "2026-07-01T10:00:00Z"),
    event("checked", "locked_withdrawals_items_disabled", "2026-07-01T10:30:00Z"),
    event("checked", "locked_withdrawals_crypto_disabled", "2026-07-01T10:31:00Z"),
    event("partial", "locked_withdrawals_crypto_enabled", "2026-07-01T10:00:00Z"),
    event("partial", "locked_withdrawals_crypto_disabled", "2026-07-01T10:30:00Z"),
    event("relocked", "locked_withdrawals_crypto_enabled", "2026-07-01T10:00:00Z"),
    event("relocked", "locked_withdrawals_items_enabled", "2026-07-01T10:00:00Z"),
    event("relocked", "locked_withdrawals_crypto_disabled", "2026-07-01T10:30:00Z"),
    event("relocked", "locked_withdrawals_items_disabled", "2026-07-01T10:30:00Z"),
    event("relocked", "locked_withdrawals_crypto_enabled", "2026-07-01T11:00:00Z"),
  ];

  assert.deepEqual(getStaffCheckedWithdrawalUserIds(events), ["checked"]);
});

test("fiat staff-check history is one bounded ADMIN audit query", () => {
  const query = read("src/lib/queries/fiat-withdrawal-review.ts");
  assert.match(query, /adminDrizzle/);
  assert.match(query, /inArray\(admin_audit_events\.target_user_id, distinctUserIds\)/);
  assert.match(query, /STAFF_WITHDRAWAL_REVIEW_EVENT_TYPES/);
  assert.doesNotMatch(query, /getPrimaryDrizzleDb|getReadDrizzleDb/);
});

test("fiat assessment API enforces exclusions and persists review state", () => {
  const api = read("src/lib/antifraud/fiat-deposits-api.ts");
  const routes = read(
    "services/antifraud-monitor/src/fiat-routes.ts",
  );
  const service = read(
    "services/antifraud-monitor/src/fiat-risk.ts",
  );
  const alerts = read(
    "services/antifraud-monitor/src/fiat-alerts.ts",
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
  assert.match(routes, /provider_evidence->>'paymentMethodType'/);
  assert.match(routes, /provider_evidence->>'checkoutEmail'/);
  assert.match(routes, /normalizeWhopPaymentMethod\(query\.search\)/);
  assert.match(routes, /view: z\.enum\(\["normal", "fraud", "refunded"\]\)/);
  assert.match(routes, /status IN \('refunded','partially_refunded'\)/);
  assert.match(service, /payment_webhook_events checkout_event/);
  assert.match(service, /payload#>>'\{data,user,email\}'/);
  assert.match(service, /paid\.checkout_email/);
  assert.match(routes, /excludeKycRequired: z/);
  assert.match(
    routes,
    /COALESCE\(\(account_evidence->>'kycRequired'\)::boolean,false\)=false/,
  );
  assert.match(alerts, /name: "Payment option"/);
  assert.match(alerts, /whopPaymentMethodLabel/);
  // The dashboard resolves refund state per deposit through the provider
  // payment id, so it must be stored, upserted, and selected — a missing
  // column silently broke the whole queue once.
  assert.match(
    read(
      "services/antifraud-monitor/migrations/045_fiat_assessment_provider_payment_id.sql",
    ),
    /ADD COLUMN IF NOT EXISTS provider_payment_id text/,
  );
  assert.match(routes, /provider_payment_id, provider_payment_status/);
  assert.match(service, /provider_payment_id=EXCLUDED\.provider_payment_id/);
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
