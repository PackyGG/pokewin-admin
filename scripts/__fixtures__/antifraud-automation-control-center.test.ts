import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(path, "utf8");

test("Automation and Rules is the single Antifraud control map", () => {
  const page = read(
    "src/app/(antifraud)/antifraud/automation/page.tsx",
  );
  const sidebar = read(
    "src/app/(antifraud)/antifraud/_components/antifraud-sidebar.tsx",
  );
  const appHosts = read("src/lib/app-hosts.ts");

  assert.match(page, /Automation & Rules/);
  assert.match(page, /getAntifraudScoringConfig\(\)/);
  assert.match(page, /getAntifraudEventCatalog\(\)/);
  assert.match(page, /getDiscordNotificationConfig\(\)/);
  assert.match(page, /Editable point flows/);
  assert.match(page, /Built-in detection and actions/);
  assert.match(page, /Discord action coverage/);
  assert.match(page, /No channel assigned/);
  assert.match(
    sidebar,
    /label:\s*"Automation & rules",\s*href:\s*"\/antifraud\/automation"/,
  );
  assert.doesNotMatch(sidebar, /label:\s*"Risk engine"/);
  assert.doesNotMatch(sidebar, /label:\s*"Config"/);
  assert.doesNotMatch(sidebar, /label:\s*"Settings"/);
  assert.match(
    appHosts,
    /host:\s*`fraud\.\$\{ROOT_DOMAIN\}`[\s\S]*?segmentRoutes:\s*\[[\s\S]*?"automation"/,
  );
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

test("the control center keeps reads shell-first and actions in existing owners", () => {
  const page = read(
    "src/app/(antifraud)/antifraud/automation/page.tsx",
  );
  const loading = read(
    "src/app/(antifraud)/antifraud/automation/loading.tsx",
  );

  assert.match(page, /<Suspense fallback=\{<AutomationSkeleton \/>\}>/);
  assert.match(page, /requireAntifraudManagerPage\(\)/);
  assert.match(loading, /PageHeroIdentity/);
  assert.doesNotMatch(page, /"use client"/);
  assert.doesNotMatch(page, /adminDrizzle|DATABASE_URL|ADMIN_DATABASE_URL/);
});
