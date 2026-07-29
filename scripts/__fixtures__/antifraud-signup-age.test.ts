import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(
  "src/app/(antifraud)/antifraud/signups/page.tsx",
  "utf8",
);

test("signup rows show account age without disturbing the row grid", () => {
  assert.match(page, /Signed up \{formatRelative/);
  assert.match(page, /formatRelative\(signup\.source_created_at\)/);
  assert.match(page, /inline-flex max-w-full/);
  assert.doesNotMatch(page, /max-w-\[calc\(100%-52px\)\]/);
  assert.match(page, /formatDateTime\(signup\.source_created_at\)/);
  assert.doesNotMatch(page, /function formatSignupAge/);
  assert.doesNotMatch(page, /Europe\/Berlin/);
});
