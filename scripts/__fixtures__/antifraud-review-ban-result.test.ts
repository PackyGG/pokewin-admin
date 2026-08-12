import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("Account Review ban failures return a typed result instead of an RSC error", () => {
  const actions = readFileSync(
    "src/app/(antifraud)/antifraud/reviews/actions.ts",
    "utf8",
  );
  const client = readFileSync(
    "src/app/(antifraud)/antifraud/reviews/_components/quick-review-actions.tsx",
    "utf8",
  );

  assert.match(
    actions,
    /runQuickReviewAccountAction[\s\S]*Promise<ServerActionResult<QuickReviewAccountActionResult>>/,
  );
  assert.match(actions, /return fail\(quickActionPublicError\(error\)\)/);
  assert.match(
    actions,
    /createAdminAuditEventDurable\(\{[\s\S]*eventType: "account_banned"/,
  );
  assert.match(
    client,
    /if \(!result\.success\) \{[\s\S]*toast\.error\(result\.error\)/,
  );
  assert.match(client, /const outcome = result\.data/);
});
