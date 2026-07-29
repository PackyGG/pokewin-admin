import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();

test("Creator Fraud is owned by Marketing while Antifraud keeps network routes", () => {
  const appHosts = readFileSync(join(root, "src/lib/app-hosts.ts"), "utf8");
  const antifraudHost =
    appHosts.match(
      /host:\s*`fraud\.\$\{ROOT_DOMAIN\}`[\s\S]*?segmentRoutes:\s*\[([\s\S]*?)\]/,
    )?.[1] ?? "";
  const marketingHost =
    appHosts.match(
      /basePath:\s*"\/creator-hub",[\s\S]*?segmentRoutes:\s*\[([\s\S]*?)\]/,
    )?.[1] ?? "";

  assert.match(antifraudHost, /"networks"/);
  assert.doesNotMatch(antifraudHost, /"creator-fraud"/);
  assert.match(antifraudHost, /"flows"/);
  assert.match(antifraudHost, /"events"/);
  assert.match(marketingHost, /"creator-fraud"/);
});
