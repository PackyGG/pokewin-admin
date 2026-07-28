import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(
  "src/app/(antifraud)/antifraud/signups/page.tsx",
  "utf8",
);

test("signup rows prominently show compact account age and the exact timestamp", () => {
  assert.match(page, /Signed up/);
  assert.match(page, /formatSignupAge\(signup\.source_created_at\)/);
  assert.match(page, /border-cyan-500\/30 bg-cyan-500\/10/);
  assert.match(page, /`\$\{minutes\} min ago`/);
  assert.match(page, /formatDate\(signup\.source_created_at\)/);
});
