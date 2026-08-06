import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("successful review actions close the review dialog", () => {
  const dialog = readFileSync(
    "src/app/(antifraud)/antifraud/reviews/_components/review-case-dialog.tsx",
    "utf8",
  );
  const quickActions = readFileSync(
    "src/app/(antifraud)/antifraud/reviews/_components/quick-review-actions.tsx",
    "utf8",
  );

  assert.match(
    dialog,
    /const completeAction = useCallback\(\(\) => \{[\s\S]*setOpen\(false\);[\s\S]*leaveQueueCase\(\);/,
  );
  assert.match(quickActions, /onActionCompleted\?\.\(\)/);
  assert.match(
    quickActions,
    /if \(!onActionCompleted\) router\.refresh\(\)/,
  );
});
