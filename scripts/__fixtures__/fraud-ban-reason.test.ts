import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  BAN_REASON_PRESETS,
  FRAUD_BAN_REASON,
} from "../../src/lib/ban-reasons";

test("Fraud is a canonical ban reason preset", () => {
  assert.equal(FRAUD_BAN_REASON, "Fraud");
  assert.ok(BAN_REASON_PRESETS.includes(FRAUD_BAN_REASON));
});

test("manual ban surfaces offer Fraud without making it automatic", async () => {
  const [singleBan, bulkBan, reviewAction] = await Promise.all(
    [
      "../../src/app/(admin)/users/[id]/user-tabs-moderation.tsx",
      "../../src/app/(admin)/users/bulk-ban-button.tsx",
      "../../src/app/(antifraud)/antifraud/reviews/actions.ts",
    ].map((path) => readFile(new URL(path, import.meta.url), "utf8")),
  );

  assert.match(singleBan, /BAN_REASON_PRESETS/);
  assert.match(singleBan, /const isCustom = reasonOption === "custom"/);
  assert.match(singleBan, /banUser\(userId, effectiveReason\)/);
  assert.match(bulkBan, /BAN_REASON_PRESETS/);
  assert.match(bulkBan, /isCustomReason &&/);
  assert.match(bulkBan, /reason: effectiveReason/);
  assert.doesNotMatch(reviewAction, /FRAUD_BAN_REASON/);
  assert.match(
    reviewAction,
    /const reason = `Antifraud review \$\{reviewId\}: \$\{review\.reason\}`/,
  );
});
