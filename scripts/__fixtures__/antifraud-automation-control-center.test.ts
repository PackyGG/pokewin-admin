import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(path, "utf8");

test("Automation is a tabbed control center over the same live reads", () => {
  const page = read("src/app/(antifraud)/antifraud/automation/page.tsx");
  const overview = read(
    "src/app/(antifraud)/antifraud/automation/_sections/overview.tsx",
  );
  const detections = read(
    "src/app/(antifraud)/antifraud/automation/_sections/detections.tsx",
  );
  const delivery = read(
    "src/app/(antifraud)/antifraud/automation/_sections/delivery.tsx",
  );
  const sidebar = read(
    "src/app/(antifraud)/antifraud/_components/antifraud-sidebar.tsx",
  );
  const appHosts = read("src/lib/app-hosts.ts");

  // Every tab is URL-addressable, so a deep link and a refresh land on the
  // same view an operator was sent.
  for (const tab of ["overview", "detections", "delivery", "controls"]) {
    assert.match(page, new RegExp(`\\{ value: "${tab}", label: `));
  }
  assert.match(page, /paramKey="tab"/);

  // The live reads moved into the tab that needs them; none of them may sit in
  // the page body, or a hidden tab would pay for another tab's data.
  assert.match(overview, /getAntifraudScoringConfig\(\)/);
  assert.match(overview, /getAntifraudEventCatalog\(\)/);
  assert.match(overview, /getAntifraudPollerHealth\(\)/);
  assert.match(overview, /getAntifraudRuntimeConfig\(\)/);
  assert.match(overview, /collectSystemIssues\(/);
  assert.match(detections, /getAntifraudScoringConfig\(\)/);
  assert.match(detections, /Point flows/);
  assert.match(delivery, /readDiscordConfig\(\)/);
  assert.match(delivery, /No channel assigned/);
  assert.doesNotMatch(page, /getAntifraud\w+\(\)/);

  assert.match(
    sidebar,
    /label:\s*"Automation",\s*href:\s*"\/antifraud\/automation"/,
  );
  assert.doesNotMatch(sidebar, /label:\s*"Risk engine"/);
  assert.doesNotMatch(sidebar, /label:\s*"Config"/);
  assert.doesNotMatch(sidebar, /label:\s*"Settings"/);
  assert.match(
    appHosts,
    /host:\s*`fraud\.\$\{ROOT_DOMAIN\}`[\s\S]*?segmentRoutes:\s*\[[\s\S]*?"automation"/,
  );
});

test("every System destination has its own nav entry", () => {
  const sidebar = read(
    "src/app/(antifraud)/antifraud/_components/antifraud-sidebar.tsx",
  );

  // These pages existed but were reachable only via a card on the Automation
  // page. A regression that drops them from the nav hides them again.
  for (const [label, href] of [
    ["Automation", "/antifraud/automation"],
    ["Rules & scoring", "/antifraud/points"],
    ["Event catalog", "/antifraud/events"],
    ["Integrations", "/antifraud/settings"],
    ["Audit log", "/antifraud/audit"],
  ] as const) {
    assert.match(
      sidebar,
      new RegExp(`label: "${label}",\\s*href: "${href}"`),
      `System nav is missing ${label} → ${href}`,
    );
  }
});

test("the built-in map covers player, payment, review, KYC, and operational flows", () => {
  const catalog = read(
    "src/app/(antifraud)/antifraud/automation/automation-catalog.ts",
  );

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
    "Provider and system failures",
  ]) {
    assert.match(catalog, new RegExp(flow));
  }

  for (const event of [
    "antifraud.signup_low_risk",
    "antifraud.signup_high_risk",
    "antifraud.rule_matched",
    "antifraud.email_blacklist",
    "antifraud.fiat_risk",
    "antifraud.fiat_operations",
    "antifraud.withdrawal_hold",
    "antifraud.sumsub_started",
    "antifraud.sumsub_ready",
    "antifraud.review_reminder",
    "antifraud.error.provider_access",
    "antifraud.error.webapp",
  ]) {
    assert.match(catalog, new RegExp(event.replaceAll(".", "\\.")));
  }
});

test("the control center keeps reads shell-first, active-tab-only, and server-side", () => {
  const page = read("src/app/(antifraud)/antifraud/automation/page.tsx");
  const loading = read("src/app/(antifraud)/antifraud/automation/loading.tsx");

  // `key={tab}` re-suspends on a switch, so the skeleton matches the incoming
  // tab instead of leaving the outgoing tab's content on screen.
  assert.match(page, /<Suspense key=\{tab\} fallback=\{<TabSkeleton tab=\{tab\} \/>\}>/);
  assert.match(page, /requireAntifraudManagerPage\(\)/);
  assert.match(loading, /PageHeroIdentity/);
  assert.doesNotMatch(page, /"use client"/);
  assert.doesNotMatch(page, /adminDrizzle|DATABASE_URL|ADMIN_DATABASE_URL/);
});

test("system issues rank criticals first and always carry a fix link", () => {
  const issues = read(
    "src/app/(antifraud)/antifraud/automation/_lib/system-issues.ts",
  );

  // The board exists to be actionable: an issue with no destination is just a
  // complaint, and warnings must never outrank criticals.
  assert.match(issues, /SEVERITY_ORDER\[a\.severity\] - SEVERITY_ORDER\[b\.severity\]/);
  assert.match(issues, /actionLabel: string/);
  const issueBlocks = issues.match(/issues\.push\(\{[\s\S]*?\}\);/g) ?? [];
  assert.ok(issueBlocks.length >= 10, "expected the full defect vocabulary");
  for (const block of issueBlocks) {
    assert.match(block, /href: "\/antifraud\//);
    assert.match(block, /severity: "(critical|warning)"/);
  }
});
