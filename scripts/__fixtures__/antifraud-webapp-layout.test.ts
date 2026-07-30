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
    "Deposits",
    "Withdrawals",
    "Refunds",
    "KYC reviews",
    "Discord",
    "Domains",
    "IPs",
    "Fingerprints",
    "Banned users",
    "Risk locations",
    "Providers",
    "Risk engine",
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
  for (const route of [
    "/antifraud/ip-blacklist",
    "/antifraud/fingerprint-blacklist",
    "/antifraud/banned-users",
  ]) {
    assert.match(sidebar, new RegExp(`href: "${route}"`));
  }
  assert.doesNotMatch(sidebar, /\/antifraud\/(?:profiles|networks)/);
  assert.doesNotMatch(sidebar, /label="Accounts"|\/antifraud\/signups/);
  for (const removedItem of [
    "System health",
    "API",
    "Errors",
    "Access & permissions",
  ]) {
    assert.doesNotMatch(
      sidebar,
      new RegExp(
        `label: "${removedItem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`,
      ),
    );
  }
  assert.doesNotMatch(sidebar, /Fraud profile index is not available/);
  assert.doesNotMatch(sidebar, /Fraud-only banned-user index is not available/);
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

test("unrequested profile and connection indexes stay out of Fraud", () => {
  const sidebar = read(
    "src/app/(antifraud)/antifraud/_components/antifraud-sidebar.tsx",
  );
  const errorBoundary = read("src/app/(antifraud)/antifraud/error.tsx");

  assert.doesNotMatch(sidebar, /Profiles|Connections & clusters|Signups/);
  assert.match(errorBoundary, /correlation \{error\.digest\}/);
  assert.match(errorBoundary, /does not prove that a preceding action failed/);
});
