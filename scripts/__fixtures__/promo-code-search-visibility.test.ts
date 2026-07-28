import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const querySource = readFileSync(
  path.join(repoRoot, "src/lib/queries/promo-codes.ts"),
  "utf8",
);
const tabSource = readFileSync(
  path.join(repoRoot, "src/app/(admin)/rewards/promo-codes-tab.tsx"),
  "utf8",
);
const buttonSource = readFileSync(
  path.join(repoRoot, "src/app/(admin)/promo-codes/create-button.tsx"),
  "utf8",
);

test("promo-code search resolves an exact code through its indexed hash", () => {
  assert.match(querySource, /hashRewardCode\(normalizedSearch, pepper\)/);
  assert.match(querySource, /filters\.push\(`pc\.code_hash = \$\$\{binds\.length\}`\)/);
  assert.match(tabSource, /search: params\.search/);
});

test("a duplicate create reveals the existing promo code", () => {
  assert.match(buttonSource, /result\.code === "PROMO_CODE_EXISTS"/);
  assert.match(buttonSource, /search: code\.trim\(\)/);
  assert.match(buttonSource, /setOpen\(false\)/);
  assert.match(
    buttonSource,
    /router\.replace\(`\/rewards\?\$\{params\.toString\(\)\}`\)/,
  );
});
