import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(path, "utf8");

const SETTINGS = "src/app/(antifraud)/antifraud/settings";

test("Fraud Settings is one page with a tab per System section", () => {
  const page = read(`${SETTINGS}/page.tsx`);
  const sidebar = read(
    "src/app/(antifraud)/antifraud/_components/antifraud-sidebar.tsx",
  );
  const appHosts = read("src/lib/app-hosts.ts");

  // Every section is a URL-addressable tab on ONE page, so a deep link and a
  // refresh land on the same view an operator was sent.
  for (const tab of [
    "overview",
    "automation",
    "scoring",
    "flows",
    "events",
    "alerts",
    "integrations",
    "health",
  ]) {
    assert.match(page, new RegExp(`\\{ value: "${tab}", label: `));
  }
  assert.match(page, /paramKey="tab"/);
  // No eyebrow, page title or blurb: the sidebar names the page, the tab bar
  // names the section.
  assert.doesNotMatch(page, /Control center/);
  assert.doesNotMatch(page, /<h1/);

  // The System group is the one Settings entry plus the audit log; a
  // regression that re-splits the sections into their own nav entries is the
  // shape this replaced.
  assert.match(sidebar, /label: "Settings",\s*href: "\/antifraud\/settings"/);
  assert.match(sidebar, /label: "Audit log",\s*href: "\/antifraud\/audit"/);
  assert.match(sidebar, /label: "Config",\s*href: "\/antifraud\/config"/);
  for (const gone of [
    "/antifraud/automation",
    "/antifraud/points",
    "/antifraud/events",
    "/antifraud/flows",
  ]) {
    assert.doesNotMatch(
      sidebar,
      new RegExp(`href: "${gone}"`),
      `${gone} is a tab now, not a nav entry`,
    );
  }
  assert.match(
    appHosts,
    /host:\s*`fraud\.\$\{ROOT_DOMAIN\}`[\s\S]*?segmentRoutes:\s*\[[\s\S]*?"settings"/,
  );
});

test("the retired section routes redirect to their tab", () => {
  for (const [route, target] of [
    ["automation", "/antifraud/settings\\?tab=automation"],
    ["events", "/antifraud/settings\\?tab=events"],
    ["flows", "/antifraud/settings\\?tab=flows"],
  ] as const) {
    const source = read(`src/app/(antifraud)/antifraud/${route}/page.tsx`);
    // Still gated: a redirect is a route, and an ungated one leaks the
    // existence of the workspace to a viewer who cannot reach it.
    assert.match(source, /requireAntifraudManagerPage\(\)/, route);
    assert.match(source, new RegExp(`redirect\\("${target}"\\)`), route);
  }

  // `/points?tab=flows` was the link the catalog and the flow editor handed
  // out, so it must keep landing on the builder rather than on scoring.
  const points = read("src/app/(antifraud)/antifraud/points/page.tsx");
  assert.match(points, /requireAntifraudManagerPage\(\)/);
  assert.match(points, /requested === "flows"/);
  assert.match(points, /"\/antifraud\/settings\?tab=flows"/);
  assert.match(points, /"\/antifraud\/settings\?tab=scoring"/);
});

test("each tab owns its own reads and the page body awaits none of them", () => {
  const page = read(`${SETTINGS}/page.tsx`);
  const overview = read(`${SETTINGS}/_sections/overview.tsx`);
  const automation = read(`${SETTINGS}/_sections/automation.tsx`);
  const scoring = read(`${SETTINGS}/_sections/scoring.tsx`);
  const flows = read(`${SETTINGS}/_sections/flows.tsx`);
  const events = read(`${SETTINGS}/_sections/events.tsx`);
  const alerts = read(`${SETTINGS}/_sections/alerts.tsx`);

  assert.match(overview, /getAntifraudPollerHealth\(\)/);
  assert.match(overview, /collectSystemIssues\(/);
  assert.match(automation, /getAntifraudScoringConfig\(\)/);
  // The Fiat auto-credit switch is NOT a tab: it credits real player deposits
  // and keeps its own /antifraud/config destination.
  assert.doesNotMatch(automation, /getFiatDepositAutomaticCreditConfig\(\)/);
  assert.match(scoring, /listAnalysisRules\(\)/);
  assert.match(flows, /<FlowBuilder/);
  assert.match(events, /<EventCatalog/);
  assert.match(alerts, /readDiscordConfig\(\)/);
  assert.match(alerts, /No channel assigned/);

  // Shell-first + active-tab-only: no read in the page body, and `key={tab}`
  // re-suspends on a switch so the skeleton matches the incoming tab.
  assert.doesNotMatch(page, /getAntifraud\w+\(\)/);
  assert.match(
    page,
    /<Suspense key=\{tab\} fallback=\{<TabSkeleton tab=\{tab\} \/>\}>/,
  );
  assert.match(page, /requireAntifraudManagerPage\(\)/);
  assert.doesNotMatch(page, /"use client"/);
  assert.doesNotMatch(page, /adminDrizzle|DATABASE_URL|ADMIN_DATABASE_URL/);
});

test("the built-in map covers player, payment, review, KYC, and operational flows", () => {
  const catalog = read(`${SETTINGS}/_lib/automation-catalog.ts`);

  for (const flow of [
    "Signup assessment",
    "Live behavior and point flows",
    "Free and sponsored battle abuse",
    "Email containment",
    "IP and fingerprint policy",
    "Risky signup locations",
    "Fiat payment risk and operations",
    "Automatic Fiat eligibility",
    "Automatic withdrawal hold",
    "KYC and Sumsub lifecycle",
    "Review operations and reminders",
    "Error routing",
  ]) {
    assert.match(catalog, new RegExp(flow));
  }

  for (const event of [
    "antifraud.signup_low_risk",
    "antifraud.signup_high",
    "antifraud.signup_critical",
    "antifraud.rule_matched",
    "antifraud.email_blacklist",
    "antifraud.fiat_risk",
    "antifraud.fiat_operations",
    "antifraud.withdrawal_hold",
    "antifraud.sumsub_started",
    "antifraud.sumsub_ready",
    "antifraud.review_reminder",
    "antifraud.error.third_party_api",
    "antifraud.error.discord_command",
    "antifraud.error.general",
    "antifraud.error.webapp",
  ]) {
    assert.match(catalog, new RegExp(event.replaceAll(".", "\\.")));
  }

  // Every control link points at a tab that exists, not at a retired route.
  const page = read(`${SETTINGS}/page.tsx`);
  for (const [, tab] of catalog.matchAll(
    /href: "\/antifraud\/settings\?tab=([a-z]+)"/g,
  )) {
    assert.match(page, new RegExp(`\\{ value: "${tab}", label: `), tab);
  }
});

test("a degraded poller only escalates on the faults the monitor itself gates on", () => {
  const issues = read(`${SETTINGS}/_lib/system-issues.ts`);
  const server = read("services/antifraud-monitor/src/server.ts");

  // The monitor's `status: "degraded"` is a COMPOSITE flag — stale tick, tick
  // failures, possible backlog, OR signups pending recovery. Its own /ready
  // handler stays ready through the last two ("an operator queue item, not an
  // infrastructure fault"), so a raw `status === "degraded"` → critical rule
  // reports an outage while the loop ticks cleanly. That regression shipped
  // once; this pins the corrected shape.
  assert.doesNotMatch(
    issues,
    /status === "degraded"[\s\S]{0,120}severity: "critical"/,
    "a raw degraded flag must not be reported as a critical outage",
  );
  assert.match(issues, /POLLER_STALE_MS/);
  assert.match(issues, /poller\.status === "starting" \|\| \(tickStale && poller\.leader\)/);

  // The dashboard threshold must track the service's readiness threshold.
  assert.match(server, /5 \* 60_000/);
  assert.match(issues, /const POLLER_STALE_MS = 5 \* 60_000;/);

  // The genuinely actionable queue conditions keep their own warning rows.
  assert.match(issues, /id: "signup-failures-pending"/);
  assert.match(issues, /id: "signup-backlog"/);
});

test("system issues rank criticals first and always carry a fix link", () => {
  const issues = read(`${SETTINGS}/_lib/system-issues.ts`);

  // The board exists to be actionable: an issue with no destination is just a
  // complaint, and warnings must never outrank criticals.
  assert.match(
    issues,
    /SEVERITY_ORDER\[a\.severity\] - SEVERITY_ORDER\[b\.severity\]/,
  );
  assert.match(issues, /actionLabel: string/);
  const issueBlocks = issues.match(/issues\.push\(\{[\s\S]*?\}\);/g) ?? [];
  assert.ok(issueBlocks.length >= 10, "expected the full defect vocabulary");
  for (const block of issueBlocks) {
    assert.match(block, /href: "\/antifraud\//);
    assert.match(block, /severity: "(critical|warning)"/);
  }
});
