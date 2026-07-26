import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const fixturesDirectory = fileURLToPath(
  new URL("./__fixtures__/", import.meta.url),
);
const testFiles = readdirSync(fixturesDirectory, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
  .map((entry) => join(fixturesDirectory, entry.name))
  .sort();

if (testFiles.length === 0) {
  throw new Error(`No guardrail tests found in ${fixturesDirectory}`);
}

const result = spawnSync(
  process.execPath,
  ["--import", "tsx", "--test", ...testFiles],
  { stdio: "inherit" },
);

if (result.error) {
  throw result.error;
}

process.exitCode = result.status ?? 1;
