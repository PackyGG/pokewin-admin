import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const source = readFileSync(
  join(process.cwd(), "src/app/(admin)/test/creator/actions.ts"),
  "utf8",
);

test("creator test actions require the resolved backend to stay on dev", () => {
  assert.match(source, /resolveBackendApiConfig/);
  assert.match(source, /resolvedEnv !== "dev"/);
  assert.match(source, /dev backend is not configured/);

  const guardEnd = source.indexOf("const setActiveCodeSchema");
  const firstBackendCall = source.indexOf("testingApi.");
  assert.ok(guardEnd > 0);
  assert.ok(firstBackendCall > guardEnd);
});
