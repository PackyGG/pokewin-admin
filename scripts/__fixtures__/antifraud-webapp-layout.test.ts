import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

test("Fraud navigation follows the owner workspace hierarchy", () => {
  const sidebar = read(
    "src/app/(antifraud)/antifraud/_components/antifraud-sidebar.tsx",
  );

  for (const section of [
    "Overview",
    "Accounts",
    "Transactions",
    "KYC",
    "Notifications",
    "Blacklists",
    "System",
  ]) {
    assert.match(sidebar, new RegExp(`label="${section}"`));
  }

  for (const item of [
    "Dashboard",
    "Live events",
    "Account reviews",
    "Profiles",
    "Signups",
    "Connections & clusters",
    "Deposits",
    "Withdrawals",
    "Refunds",
    "KYC reviews",
    "Discord",
    "Domains",
    "Risk locations",
    "System health",
    "Providers",
    "Risk engine",
    "API",
    "Errors",
    "Access & permissions",
    "Settings",
  ]) {
    assert.match(
      sidebar,
      new RegExp(`label: "${item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`),
    );
  }

  assert.match(sidebar, /window\.localStorage\.setItem\(storageKey/);
  assert.match(sidebar, /antifraud-nav:v1:/);
  assert.match(sidebar, /group-data-\[collapsible=icon\]:block/);
  assert.doesNotMatch(sidebar, /href:\s*"\/users/);
  assert.match(
    sidebar,
    /label: "Profiles"[\s\S]*disabledReason: "The Fraud profile index is not available yet"/,
  );
  assert.match(
    sidebar,
    /label: "Banned users"[\s\S]*disabledReason: "The Fraud-only banned-user index is not available yet"/,
  );
});

test("deposit and withdrawal reviews preserve their queues in URL-driven drawers", () => {
  const deposits = read("src/app/(antifraud)/antifraud/fiat-deposits/page.tsx");
  const withdrawals = read(
    "src/app/(antifraud)/antifraud/withdrawals/page.tsx",
  );
  const withdrawalDialog = read(
    "src/app/(antifraud)/antifraud/withdrawals/review-dialog.tsx",
  );
  const drawer = read(
    "src/app/(antifraud)/antifraud/_components/review-drawer.tsx",
  );

  assert.match(
    deposits,
    /review=\$\{encodeURIComponent\(item\.deposit_intent_id\)\}/,
  );
  assert.match(deposits, /<QueueReviewDrawer/);
  assert.match(deposits, /<FiatReview[\s\S]*?embedded/);
  assert.match(
    withdrawals,
    /review=\$\{encodeURIComponent\(withdrawal\.withdrawal_id\)\}/,
  );
  assert.match(withdrawals, /getWithdrawalAssessment\(withdrawalId\)/);
  assert.doesNotMatch(withdrawalDialog, /DialogTrigger/);
  assert.match(
    withdrawalDialog,
    /router\.replace\(hrefForCurrentHost\(closeHref\)/,
  );
  assert.match(drawer, /router\.replace\(hrefForCurrentHost\(closeHref\)/);
  assert.match(drawer, /overflow-y-auto/);
});

test("connections and route errors recover locally", () => {
  const networks = read("src/app/(antifraud)/antifraud/networks/page.tsx");
  const errorBoundary = read("src/app/(antifraud)/antifraud/error.tsx");

  assert.doesNotMatch(networks, /if \(!userId\) notFound/);
  assert.match(networks, /Find connections/);
  assert.match(errorBoundary, /correlation \{error\.digest\}/);
  assert.match(errorBoundary, /does not prove that a preceding action failed/);
});
