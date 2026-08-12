import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(
  "src/app/(admin)/users/[id]/page.tsx",
  "utf8",
);

test("user detail resolves its indispensable aggregate before optional bands", () => {
  const detail = page.indexOf("const detailResult = await safeQueryOrNull(");
  const pnl = page.indexOf("const pnlResultPromise");
  const activity = page.indexOf("const gamingTxPromise");
  const optionalAccess = page.indexOf("users.detail.ultraLossbackGate");
  const downstreamGate = page.indexOf("freshBalancesResult,");

  assert.ok(detail >= 0, "the detail aggregate must have an explicit gate");
  assert.ok(pnl > detail, "P&L must not start ahead of core detail");
  assert.ok(activity > detail, "activity must not start ahead of core detail");
  assert.ok(
    optionalAccess > detail,
    "optional access checks must not hold core detail behind ADMIN reads",
  );
  assert.ok(
    downstreamGate > detail,
    "secondary identity and balance work must follow core detail",
  );
  assert.match(page, /if \(!data\) \{[\s\S]*?<InlineError/);
});

test("user detail starts only data consumed by the active tab", () => {
  assert.match(page, /const wantsGamingTx = initialTab === "gaming";/);
  assert.match(
    page,
    /const wantsPnl = initialTab === "overview" \|\| initialTab === "account";/,
  );
  assert.match(
    page,
    /const wagerProgressPromise =[\s\S]*?initialTab === "overview" \|\| initialTab === "account"[\s\S]*?: null;/,
  );
  assert.match(
    page,
    /const wantsOwnerVisibility = initialTab === "overview";/,
  );
});

test("optional access failures fail closed without blanking user detail", () => {
  assert.match(
    page,
    /safeQuery\([\s\S]*?canUseUltraLossbackFresh\(viewerSession\)[\s\S]*?false,[\s\S]*?"users\.detail\.ultraLossbackGate"/,
  );
  assert.match(
    page,
    /safeQuery\([\s\S]*?getUserPermissions\(sessionUserId\)[\s\S]*?\[\],[\s\S]*?"users\.detail\.permissions"/,
  );
});
