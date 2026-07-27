import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();

function source(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

test("the Antifraud sidebar exposes KYC as its own Home workspace", () => {
  const sidebar = source(
    "src/app/(antifraud)/antifraud/_components/antifraud-sidebar.tsx",
  );
  const page = source("src/app/(antifraud)/antifraud/kyc/page.tsx");
  const loading = source("src/app/(antifraud)/antifraud/kyc/loading.tsx");
  const appHosts = source("src/lib/app-hosts.ts");

  assert.match(sidebar, /const KYC_NAV[\s\S]*?label:\s*"Home",\s*href:\s*"\/antifraud\/kyc"/);
  assert.match(sidebar, /<SidebarGroupLabel>KYC<\/SidebarGroupLabel>[\s\S]*?items=\{KYC_NAV\}/);
  assert.doesNotMatch(page, /max-w-7xl/);
  assert.doesNotMatch(loading, /max-w-7xl/);
  assert.match(page, /<h1[^>]*>KYC review<\/h1>/);
  assert.match(
    appHosts,
    /host:\s*`fraud\.\$\{ROOT_DOMAIN\}`[\s\S]*?segmentRoutes:\s*\[[\s\S]*?"kyc"/,
  );
});

test("the KYC page is workspace-gated and never renders raw provider payloads", () => {
  const page = source("src/app/(antifraud)/antifraud/kyc/page.tsx");
  const query = source("src/lib/antifraud/kyc.ts");

  assert.match(page, /requireAntifraudPageAccess\(\)/);
  assert.match(page, /canManageAntifraud\(session\)/);
  assert.doesNotMatch(query, /payload:\s*sumsub_webhook_events\.payload/);
});

test("KYC mutations are manager-only and preserve the verification-cycle guard", () => {
  const actions = source(
    "src/app/(antifraud)/antifraud/kyc/actions.ts",
  );

  assert.match(actions, /requireAntifraudManager\(/);
  assert.match(actions, /requireUserKyc\(/);
  assert.match(actions, /reviewUserKyc\(/);
  assert.match(actions, /expectedCycle:\s*parsed\.data\.expectedCycle/);
  assert.match(actions, /createAdminAuditEvent\(/);
});

test("the dashboard reports both internal state and Sumsub evidence", () => {
  const page = source("src/app/(antifraud)/antifraud/kyc/page.tsx");
  const query = source("src/lib/antifraud/kyc.ts");

  assert.match(query, /user_kyc/);
  assert.match(query, /sumsub_webhook_events/);
  assert.match(query, /usedLevels/);
  assert.match(query, /backendUrlConfigured/);
  assert.match(query, /automaticUnlock:\s*false/);
  assert.doesNotMatch(page, /How KYC works here/);
  assert.match(page, /Accounts currently requiring KYC/);
  assert.match(page, /historical verification\s+records/);
  assert.match(page, /Ready for admin decision/);
  assert.doesNotMatch(page, /System details and webhook activity/);
  assert.doesNotMatch(page, /Configuration and policy/);
  assert.doesNotMatch(page, /Sumsub webhook evidence/);
  assert.doesNotMatch(page, /<SystemDetails/);
});

test("the KYC landing view shows only accounts that currently require KYC", () => {
  const page = source("src/app/(antifraud)/antifraud/kyc/page.tsx");

  assert.match(
    page,
    /isKycFilter\(params\.status\)\s*\?\s*params\.status\s*:\s*"required"/,
  );
  assert.match(page, /all:\s*"KYC record history"/);
  assert.match(page, /No accounts currently require KYC/);
  assert.match(page, /completed historical cycles/);
});

test("untouched default KYC rows stay out of the review queue and totals", () => {
  const query = source("src/lib/antifraud/kyc.ts");

  assert.match(query, /function meaningfulKycRecordCondition\(\): SQL/);
  assert.match(
    query,
    /const conditions: SQL\[\] = \[meaningfulKycRecordCondition\(\)\]/,
  );
  assert.match(
    query,
    /FROM user_kyc\s+WHERE \$\{meaningfulKycRecordCondition\(\)\}/,
  );
  assert.match(query, /verification_cycle\} > 0/);
  assert.match(query, /status\} <> 'none'/);
});
