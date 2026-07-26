import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("canonical metrics and dashboard do not fetch redundant creator windows", () => {
  for (const relative of [
    "src/lib/metrics/scope.ts",
    "src/lib/queries/dashboard.ts",
  ]) {
    const source = readFileSync(path.join(root, relative), "utf8");
    assert.doesNotMatch(
      source,
      /(?:import\s+\{[^}]*getCreatorSessionWindowsCte|await\s+getCreatorSessionWindowsCte\s*\()/,
    );
    assert.match(source, /\bEMPTY_CREATOR_SESSION_WINDOWS_CTE\b/);
  }
});
