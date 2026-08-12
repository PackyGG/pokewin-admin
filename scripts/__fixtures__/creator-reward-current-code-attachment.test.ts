import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = readFileSync(
  path.join(root, "src/lib/creator-vip/compute.ts"),
  "utf8",
);

test("a player currently on a program code is attached before first activity", () => {
  const start = source.indexOf("const attached =");
  const end = source.indexOf("if (attached.rows[0]?.hit", start);
  assert.ok(start >= 0 && end > start, "attachment short-circuit must exist");

  const gate = source.slice(start, end);
  assert.match(gate, /FROM affiliate_code_usages/);
  assert.match(gate, /OR EXISTS\s*\(\s*SELECT 1 FROM "user" u/);
  assert.match(
    gate,
    /UPPER\(u\.affiliate_code\) = ANY/,
    "current code must keep a zero-activity player out of the empty-result shortcut",
  );
});
