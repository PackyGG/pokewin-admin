import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();

function source(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

test("the Antifraud sidebar exposes the dedicated KYC workspace", () => {
  const sidebar = source(
    "src/app/(antifraud)/antifraud/_components/antifraud-sidebar.tsx",
  );
  assert.match(sidebar, /label:\s*"KYC",\s*href:\s*"\/antifraud\/kyc"/);
});

test("the KYC page is workspace-gated and never renders raw provider payloads", () => {
  const page = source("src/app/(antifraud)/antifraud/kyc/page.tsx");
  const query = source("src/lib/antifraud/kyc.ts");

  assert.match(page, /requireAntifraudPageAccess\(\)/);
  assert.match(page, /canManageAntifraud\(session\)/);
  assert.match(page, /Raw webhook payloads can contain identity documents/);
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
  const query = source("src/lib/antifraud/kyc.ts");

  assert.match(query, /user_kyc/);
  assert.match(query, /sumsub_webhook_events/);
  assert.match(query, /usedLevels/);
  assert.match(query, /backendUrlConfigured/);
  assert.match(query, /automaticUnlock:\s*false/);
});
