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
    "Main",
    "Guide",
    "Blacklists",
    "Admin",
    "System",
  ]) {
    assert.match(sidebar, new RegExp(`label="${section}"`));
  }

  for (const item of [
    "Dashboard",
    "Live events",
    "Account reviews",
    "Deposit reviews",
    "Deposits",
    "Refunds",
    "KYC reviews",
    "Discord routing",
    "Domains",
    "IPs",
    "Fingerprints",
    "Banned users",
    "Risk locations",
    "Signup Risk",
    "Account Review",
    "Blacklists & Bans",
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
  assert.match(
    sidebar,
    /const MAIN_NAV[\s\S]*?label: "KYC reviews"[\s\S]*?const BLACKLIST_NAV/,
  );
  assert.match(
    sidebar,
    /const SYSTEM_NAV[\s\S]*?label: "Refunds"[\s\S]*?label: "Settings"/,
  );
});

test("every Fraud guide route gates access and shares the guide primitives", () => {
  const routes = [
    "sign-up",
    "fiat-pre-payment",
    "fiat-deposits",
    "account-review",
    "refunds",
    "blacklists",
    "troubleshooting",
  ];

  for (const route of routes) {
    const page = read(`src/app/(antifraud)/antifraud/guide/${route}/page.tsx`);
    assert.match(page, /requireAntifraudPageAccess\(\)/);
    assert.match(page, /export const metadata/);
    // Built from the shared primitives, never hand-rolled section markup: that
    // divergence is what made the guide stop matching the rest of the app.
    assert.match(page, /from "\.\.\/_components\/guide-primitives"/);
    assert.match(page, /<GuidePage/);
    // A route-local skeleton — otherwise the guide inherits the Antifraud
    // DASHBOARD skeleton (KPI grid + charts) and flashes the wrong shape.
    const loading = read(
      `src/app/(antifraud)/antifraud/guide/${route}/loading.tsx`,
    );
    assert.match(loading, /GuideLoading/);
    // The skeleton must describe THIS page: one panel per section, or the
    // placeholder shape jumps when the real content arrives.
    const sections = (page.match(/<GuideSection/g) ?? []).length;
    const panels = Number(loading.match(/panels=\{(\d+)\}/)?.[1]);
    assert.equal(
      panels,
      sections,
      `${route}: loading.tsx renders ${panels} panels but the page has ${sections} sections`,
    );
    // Pages compose primitives only — no hand-rolled markup, no inline
    // classes. That divergence is what made the old guide pages drift.
    assert.doesNotMatch(page, /className=/);
    assert.doesNotMatch(page, /<(?:div|section|article|ul|ol|dl|table|h1|h2|h3) /);
  }
});

test("the pre-Fiat guide explains caller auth and checkout IP separately", () => {
  const page = read(
    "src/app/(antifraud)/antifraud/guide/fiat-pre-payment/page.tsx",
  );
  const sidebar = read(
    "src/app/(antifraud)/antifraud/_components/antifraud-sidebar.tsx",
  );

  assert.match(page, /No caller-IP allowlist/);
  assert.match(page, /customer's checkout IP|player's checkout IP/);
  assert.match(page, /Fingerprint and proxycheck\.io are mandatory/);
  assert.match(page, /Most denials do not lock, ban, refund, or change KYC/);
  assert.match(sidebar, /label: "Pre-Fiat Checks"/);
  assert.match(sidebar, /href: "\/antifraud\/guide\/fiat-pre-payment"/);
});

test("the guide primitives stay flat — no hue-filled surfaces", () => {
  const primitives = read(
    "src/app/(antifraud)/antifraud/guide/_components/guide-primitives.tsx",
  );

  // Accent belongs on the icon and the number; the surface stays `bg-card`.
  // The old guide pages violated this with `bg-rose-500/5` tinted headers and
  // whole-card hue fills.
  assert.doesNotMatch(primitives, /bg-(?:rose|cyan|emerald|amber|orange|violet|purple|blue)-500\//);
  assert.doesNotMatch(primitives, /bg-gradient-to|shadow-\[0_0|blur-/);
  // Dark mode must be paired, never a bare -400.
  assert.match(primitives, /text-cyan-600 dark:text-cyan-400/);
  // `violet` is not in TILE_COLORS; `purple` is.
  assert.doesNotMatch(primitives, /violet/);
});

test("the operator guide uses the available canvas instead of stacked section cards", () => {
  const primitives = read(
    "src/app/(antifraud)/antifraud/guide/_components/guide-primitives.tsx",
  );

  assert.match(primitives, /max-w-\[1600px\]/);
  assert.match(
    primitives,
    /lg:grid-cols-\[minmax\(220px,0\.7fr\)_minmax\(0,1\.3fr\)\]/,
  );
  assert.match(primitives, /lg:sticky lg:top-5 lg:self-start/);
  assert.match(primitives, /sm:grid-cols-2/);
  assert.match(primitives, /<aside className=/);
  assert.doesNotMatch(
    primitives,
    /<section className="[^"]*rounded-xl[^"]*border/,
  );
});

test("the signup guide reconciles the band name with the badge an operator sees", () => {
  const page = read("src/app/(antifraud)/antifraud/guide/sign-up/page.tsx");

  // The catalog calls 21-49 "Low risk" but the severity key is `medium`, so
  // the badge reads "Medium". The guide must state both, not repeat one.
  assert.match(page, /Low risk/);
  assert.match(page, /Medium/);
  assert.match(page, /Read the badge, not the name/);
  // The window is fixed once it opens.
  assert.match(page, /It never extends/);
});

test("the fiat guide does not resurrect the 60-second allow", () => {
  const page = read(
    "src/app/(antifraud)/antifraud/guide/fiat-deposits/page.tsx",
  );
  const policy = read(
    "services/antifraud-monitor/src/fiat-deposit-identity-policy.ts",
  );
  const automation = read(
    "src/app/(antifraud)/antifraud/settings/_lib/automation-catalog.ts",
  );

  // DECISION_TTL_MS is "never a reusable grant" and is not returned by the
  // API — the response is only {decisionId, allowed, timestamp}.
  assert.doesNotMatch(page, /valid for 60 seconds|allow is valid/);
  assert.match(page, /A pass cannot be reused/);
  // Deny (50) and contain (70) are different thresholds.
  assert.match(page, /Deny floor/);
  assert.match(page, /Contain floor/);
  // Post-payment identity copy must mirror the live time-based policy.
  assert.match(policy, /CARD_CHANGE_LOCK_WINDOW_MS = 2 \* 60 \* 60 \* 1000/);
  assert.match(policy, /CARD_CHANGE_REVIEW_WINDOW_MS = 24 \* 60 \* 60 \* 1000/);
  assert.match(policy, /key: "checkout_email_changed"[\s\S]{0,250}action: "review"/);
  assert.match(page, /2h \/ 24h/);
  assert.match(page, /different payer email opens staff review/i);
  assert.doesNotMatch(page, /Card grace|3 deposits|three authorized/);
  assert.match(page, /KYC is always a staff decision/);
  assert.doesNotMatch(page, /only automation in the system that requires KYC/i);
  assert.match(page, /immediately previous authorized Fiat deposit/);
  assert.doesNotMatch(automation, /short-lived allow or deny decision/);
});

test("deposit credit reviews keep staff on the active decision queue", () => {
  const deposits = read(
    "src/app/(antifraud)/antifraud/fiat-deposits/credit-review-page.tsx",
  );
  const retiredDetail = read(
    "src/app/(antifraud)/antifraud/fiat-deposits/[id]/page.tsx",
  );

  assert.doesNotMatch(
    deposits,
    /fiat-deposits\/\$\{encodeURIComponent\(item\.id\)\}/,
  );
  assert.match(deposits, /FiatReviewEvidence/);
  assert.match(retiredDetail, /redirect\("\/antifraud\/fiat-deposits"\)/);
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
