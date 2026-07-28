import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const actionsSource = readFileSync(
  path.join(
    repoRoot,
    "src/app/(admin)/system/geo-blocking/actions.ts",
  ),
  "utf8",
);

test("country restriction arrays use Drizzle's schema-aware encoder", () => {
  assert.match(
    actionsSource,
    /\[field\]: normalizedValues/,
    "array updates must pass through the text[] column encoder",
  );
  assert.doesNotMatch(
    actionsSource,
    /\[field\]: sql\.param\(normalizedValues\)/,
    "raw SQL parameters bypass the text[] column encoder",
  );
});
