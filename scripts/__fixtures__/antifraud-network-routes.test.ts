import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();

test("the Antifraud host owns account-network and creator-fraud routes", () => {
  const appHosts = readFileSync(join(root, "src/lib/app-hosts.ts"), "utf8");
  const antifraudHost =
    appHosts.match(
      /host:\s*`fraud\.\$\{ROOT_DOMAIN\}`[\s\S]*?segmentRoutes:\s*\[([\s\S]*?)\]/,
    )?.[1] ?? "";

  assert.match(antifraudHost, /"networks"/);
  assert.match(antifraudHost, /"creator-fraud"/);
});
