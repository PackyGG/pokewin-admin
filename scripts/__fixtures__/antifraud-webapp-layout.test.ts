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
    "Guide",
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
    "Refunds",
    "KYC reviews",
    "Discord routing",
    "Domains",
    "IPs",
    "Fingerprints",
    "Banned users",
    "Risk locations",
    "Sign Up & Monitor",
    // System group — one Settings page (every config section is a tab on it)
    // plus the staff audit log.
    "Settings",
    "Config",
    "Audit log",
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
    "/antifraud/guide/sign-up",
    "/antifraud/ip-blacklist",
    "/antifraud/fingerprint-blacklist",
    "/antifraud/banned-users",
  ]) {
    assert.match(sidebar, new RegExp(`href: "${route}"`));
  }
  assert.doesNotMatch(sidebar, /\/antifraud\/(?:profiles|networks)/);
  assert.doesNotMatch(sidebar, /label="Accounts"|\/antifraud\/signups/);
  assert.doesNotMatch(sidebar, /label: "Providers"/);
  assert.doesNotMatch(sidebar, /label="Notifications"|NOTIFICATION_NAV/);
  assert.doesNotMatch(sidebar, /Dashboard inbox|\/antifraud\/notifications/);
  // System is Settings (every config section is a tab on it), Config (the
  // global Fiat switch, its own page) and the audit log. "Risk engine" stays
  // retired.
  assert.doesNotMatch(sidebar, /label: "Risk engine"/);
  assert.doesNotMatch(sidebar, /fiat-perks|Screening/);
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

test("Fraud guide keeps access control and documents signup risk actions", () => {
  const page = read(
    "src/app/(antifraud)/antifraud/guide/sign-up/page.tsx",
  );

  assert.match(page, /requireAntifraudPageAccess\(\)/);
  assert.match(page, /<PageHero>/);
  assert.doesNotMatch(page, />\s*Sign Up &amp; Monitor\s*</);
  assert.doesNotMatch(page, />\s*Guide\s*</);
  assert.match(page, /Low risk/);
  assert.match(page, /High risk/);
  assert.match(page, /Critical risk/);
  assert.match(page, /Discord/);
  assert.match(page, /Review/);
  assert.match(page, /Monitor flow/);
  assert.doesNotMatch(page, /Critical containment/);
});

test("deposit reviews preserve their queue in a URL-driven drawer", () => {
  const deposits = read("src/app/(antifraud)/antifraud/fiat-deposits/page.tsx");
  const drawer = read(
    "src/app/(antifraud)/antifraud/_components/review-drawer.tsx",
  );

  assert.match(
    deposits,
    /review=\$\{encodeURIComponent\(item\.deposit_intent_id\)\}/,
  );
  assert.match(deposits, /<QueueReviewDrawer/);
  assert.match(deposits, /<FiatReview[\s\S]*?embedded/);
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

test("all four webapps route browser and React failures with source context", () => {
  const route = read("src/app/api/antifraud/webapp-errors/route.ts");
  const reporter = read("src/lib/errors/report-webapp-error.ts");
  const routeBoundary = read("src/app/(antifraud)/antifraud/error.tsx");
  const panelBoundary = read(
    "src/app/(antifraud)/antifraud/_components/panel-error-boundary.tsx",
  );
  const instrumentation = read("src/instrumentation-client.ts");

  assert.match(route, /verifySession\(\)/);
  assert.match(route, /"admin" \| "marketing" \| "packs" \| "fraud"/);
  assert.match(route, /name: "Webapp"/);
  assert.match(route, /name: "Server"/);
  assert.match(route, /sec-fetch-site/);
  assert.match(route, /rateLimit/);
  assert.match(route, /eventKey: "antifraud\.error\.webapp"/);
  assert.match(route, /Raw messages and stack traces were intentionally excluded/);
  assert.doesNotMatch(route, /report\.message|report\.stack/);
  assert.match(reporter, /source: "window-error"/);
  assert.match(reporter, /source: "unhandled-rejection"/);
  assert.match(routeBoundary, /reportWebappError/);
  assert.match(panelBoundary, /info\.componentStack/);
  assert.match(instrumentation, /registerWebappErrorListeners\(\)/);
});
