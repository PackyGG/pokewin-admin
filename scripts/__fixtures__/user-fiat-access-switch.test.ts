import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string): string => readFileSync(path, "utf8");

const component = read(
  "src/app/(admin)/users/[id]/fiat-deposit-access-button.tsx",
);
const actions = read(
  "src/app/(admin)/users/[id]/fiat-deposit-access-actions.ts",
);
const apiClient = read("src/lib/backend-api/fiat-deposit-access.ts");
const page = read("src/app/(admin)/users/[id]/page.tsx");
const accountTab = read(
  "src/app/(admin)/users/[id]/user-view-modern-tabs.tsx",
);

test("Fiat access uses the shared authenticated backend API client", () => {
  assert.match(apiClient, /backendApi\.get<unknown>\(pathFor\(userId\)\)/);
  assert.match(apiClient, /backendApi\.put<unknown>\(pathFor\(userId\), \{ enabled \}\)/);
  assert.doesNotMatch(apiClient, /https:\/\/packy\.gg|ADMIN_API_KEY|xbypasssecret/);
});

test("Fiat access validates the exact backend response contract", () => {
  assert.match(apiClient, /success: z\.literal\(true\)/);
  assert.match(apiClient, /user_id: z\.string\(\)\.min\(1\)/);
  assert.match(apiClient, /enabled: z\.boolean\(\)/);
  assert.match(apiClient, /parsed\.data\.data\.user_id !== requestedUserId/);
});

test("user Fiat access requires confirmation and is not optimistic", () => {
  assert.match(component, /<AlertDialog/);
  assert.match(component, /onCheckedChange=\{setRequestedEnabled\}/);
  assert.match(component, /Confirm \$\{nextLabel\}/);
  assert.doesNotMatch(component, /setAccess\(nextEnabled\)/);
  assert.match(component, /setAccess\(result\.data\)/);
});

test("Fiat allow-list copy does not imply bypassing safety locks", () => {
  assert.match(component, /Fiat deposit allow-list/);
  assert.match(component, /Fraud, compliance, KYC, location/);
  assert.match(component, /will not clear or bypass any fraud, compliance, KYC/);
});

test("Fiat access is lazy on the Account tab and revalidates after mutation", () => {
  assert.match(
    page,
    /initialTab === "account"[\s\S]*getFiatDepositAccess\(id\)\.catch\(\(\) => null\)/,
  );
  assert.match(accountTab, /title="Feature Locks & Fiat Access"/);
  assert.match(actions, /requirePageAccess\("\/users"\)/);
  assert.match(actions, /requireAdmin\(\)/);
  assert.match(actions, /createAdminAuditEventDurable\(/);
  assert.match(actions, /revalidatePath\(`\/users\/\$\{parsed\.data\.userId\}`/);
  assert.match(component, /router\.refresh\(\)/);
});
