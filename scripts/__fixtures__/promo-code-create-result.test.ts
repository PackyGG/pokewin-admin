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
  path.join(repoRoot, "src/app/(admin)/promo-codes/actions.ts"),
  "utf8",
);
const buttonSource = readFileSync(
  path.join(repoRoot, "src/app/(admin)/promo-codes/create-button.tsx"),
  "utf8",
);

test("duplicate promo codes return a readable Server Action result", () => {
  assert.match(
    actionsSource,
    /return fail\(\s*"A promo code with this value already exists",\s*"PROMO_CODE_EXISTS"/,
  );
  assert.doesNotMatch(
    actionsSource,
    /throw new Error\("A promo code with this value already exists"\)/,
  );
  assert.match(
    buttonSource,
    /if \(!result\.success\) \{\s*toast\.error\(result\.error\);\s*return;/,
  );
});
