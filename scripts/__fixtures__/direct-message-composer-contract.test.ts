import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ADMIN_MESSAGE_BODY_MAX,
  ADMIN_MESSAGE_TITLE_MAX,
  validateAdminMessagePayload,
} from "@/lib/user-notification";
import { previewNotificationText } from "@/lib/user-notification-templates";

const root = process.cwd();
const source = (path: string) => readFileSync(`${root}/${path}`, "utf8");

test("direct composer presents five intent-first choices", () => {
  const content = source(
    "src/app/(admin)/notifications/direct-notifications-content.tsx",
  );
  for (const mode of ["message", "pack", "challenge", "reward", "bulk"]) {
    assert.match(content, new RegExp(`value:\\s*"${mode}"`));
  }
});

test("single and bulk messages expose title and message instead of payload controls", () => {
  const single = source(
    "src/app/(admin)/notifications/single-notification-form.tsx",
  );
  const bulk = source(
    "src/app/(admin)/notifications/bulk-notification-form.tsx",
  );
  const history = source(
    "src/app/(admin)/notifications/direct-notification-history.tsx",
  );

  for (const form of [single, bulk]) {
    assert.match(form, /type:\s*"admin_message"|type="admin_message"/);
    assert.match(form, />Title</);
    assert.match(form, />Message</);
    assert.doesNotMatch(
      form,
      /Custom payload|Shared payload|Chunk size|Category<|>Type</,
    );
  }
  assert.match(history, /historyDetail\(e\)/);
  assert.doesNotMatch(history, /JSON\.stringify\(e\.samplePayload\)/);
});

test("admin message copy is validated and previewed exactly", () => {
  assert.equal(
    validateAdminMessagePayload({
      title: "Account update",
      body: "You're all set.",
    }),
    null,
  );
  assert.match(
    validateAdminMessagePayload({ title: "", body: "Body" }) ?? "",
    /Title is required/,
  );
  assert.match(
    validateAdminMessagePayload({
      title: "T".repeat(ADMIN_MESSAGE_TITLE_MAX + 1),
      body: "B",
    }) ?? "",
    /Title must be/,
  );
  assert.match(
    validateAdminMessagePayload({
      title: "T",
      body: "B".repeat(ADMIN_MESSAGE_BODY_MAX + 1),
    }) ?? "",
    /Message must be/,
  );

  assert.deepEqual(
    previewNotificationText("admin_message", {
      title: "Account update",
      body: "You're all set.",
    }),
    {
      title: "Account update",
      body: "You're all set.",
      known: true,
      usedKeys: ["title", "body"],
    },
  );
});
