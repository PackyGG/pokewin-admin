import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  BALANCE_ADJUSTMENT_CATEGORY_KEYS,
  COUNTED_ADJUSTMENT_CATEGORY_KEYS,
  REMOVAL_ONLY_ADJUSTMENT_CATEGORY_KEYS,
  SELECTABLE_ADJUSTMENT_CATEGORY_KEYS,
} from "../../src/lib/balance-adjustment-categories";
import {
  canUseUltraLossback,
  hasUltraLossbackUsernameAccess,
} from "../../src/lib/ultra-lossback-access";

const read = (relative: string) => readFileSync(relative, "utf8");

test("Ultra Lossback uses an exact two-admin identity boundary", () => {
  assert.equal(hasUltraLossbackUsernameAccess("motha"), true);
  assert.equal(hasUltraLossbackUsernameAccess("hifoen"), true);
  assert.equal(hasUltraLossbackUsernameAccess("HIFOEN"), false);
  assert.equal(hasUltraLossbackUsernameAccess(" hifoen "), false);
  assert.equal(hasUltraLossbackUsernameAccess("other-owner"), false);
  assert.equal(
    canUseUltraLossback({ role: "admin", username: "hifoen" }),
    true,
  );
  assert.equal(
    canUseUltraLossback({ role: "support", roles: ["support"], username: "hifoen" }),
    false,
  );
  assert.equal(
    canUseUltraLossback({ role: "support", roles: ["support", "admin"], username: "motha" }),
    true,
  );
});

test("Ultra Lossback is canonical, debit-only, uncounted, and not normally selectable", () => {
  assert.ok(BALANCE_ADJUSTMENT_CATEGORY_KEYS.includes("ultra_lossback"));
  assert.ok(REMOVAL_ONLY_ADJUSTMENT_CATEGORY_KEYS.includes("ultra_lossback"));
  assert.ok(!COUNTED_ADJUSTMENT_CATEGORY_KEYS.includes("ultra_lossback" as never));
  assert.ok(!SELECTABLE_ADJUSTMENT_CATEGORY_KEYS.includes("ultra_lossback" as never));
});

test("server action gates the no-2FA path and suppresses private webhooks", () => {
  const source = read("src/app/(admin)/users/[id]/actions.ts");
  assert.match(source, /isUltraLossback && !\(await canUseUltraLossbackFresh\(session\)\)/);
  assert.match(source, /case "ultra_lossback"[\s\S]{0,240}if \(amount >= 0\)/);
  assert.match(source, /if \(!isUltraLossback\) \{[\s\S]{0,160}require2FA/);
  assert.match(source, /if \(!isUltraLossback\) \{[\s\S]{0,500}creator_webhooks/);
  assert.match(source, /checkBalanceAdjustmentLimit\(session\.userId, parsed\.amount\)/);
  assert.match(source, /createAdminAuditEventDurable\([\s\S]{0,300}category: parsed\.category/);
});

test("private ledger and audit readers filter Ultra Lossback server-side", () => {
  const userTx = read("src/lib/queries/users-transactions.ts");
  const cache = read("src/lib/queries/users-detail-cache.ts");
  const tx = read("src/lib/queries/transactions.ts");
  const audit = read("src/lib/audit-visibility.ts");
  const metrics = read("src/lib/metrics/queries.ts");

  assert.match(userTx, /metadata->>'adjustment_category' IS DISTINCT FROM 'ultra_lossback'/);
  assert.match(userTx, /canViewUltraLossback/);
  assert.match(cache, /viewerCanSeeUltraLossback \? "ultra" : "non-ultra"/);
  assert.match(tx, /metadata\?\.adjustment_category === "ultra_lossback"/);
  assert.match(tx, /await canUseUltraLossbackFresh\(await verifySession\(\)\)/);
  assert.match(tx, /metadata->>'adjustment_category' IS DISTINCT FROM 'ultra_lossback'/);
  assert.match(audit, /metadataExpression}->>'category' IS DISTINCT FROM 'ultra_lossback'/);
  assert.equal(
    metrics.match(/metadata->>'adjustment_category' IS DISTINCT FROM 'ultra_lossback'/g)?.length,
    2,
    "both scalar and grouped residual sums must omit the private category",
  );
});

test("the popup exposes the private tab only through the server-derived prop", () => {
  const dialog = read("src/app/(admin)/users/[id]/user-tabs-dialogs.tsx");
  const page = read("src/app/(admin)/users/[id]/page.tsx");
  assert.match(dialog, /canUseUltraLossback && \([\s\S]{0,120}TabsTrigger value="ultra"/);
  assert.match(dialog, /!isUltraLossback && \([\s\S]{0,100}StepUpField/);
  assert.match(
    page,
    /safeQuery\([\s\S]*?canUseUltraLossbackFresh\(viewerSession\)[\s\S]*?false,[\s\S]*?"users\.detail\.ultraLossbackGate"/,
  );
  assert.match(page, /viewerCanSeeUltraLossback=\{viewerCanSeeUltraLossback\}/);
});

test("the fresh access gate re-checks active identity and effective role", () => {
  const source = read("src/lib/ultra-lossback-access.server.ts");
  assert.match(source, /eq\(admin_users\.id, session\.userId\)/);
  assert.match(source, /role: admin_users\.role/);
  assert.match(source, /roles: admin_users\.roles/);
  assert.match(source, /row\?\.isActive === true && canUseUltraLossback/);
});
