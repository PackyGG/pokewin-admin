import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();

/**
 * Every Antifraud nav target must be listed in the fraud host's
 * `segmentRoutes`. A missing entry does not 404 loudly — the middleware treats
 * the path as a main-app path and bounces it to the apex, where it 404s with a
 * rewritten URL. That is how /ip-blacklist and /fingerprint-blacklist broke.
 */
test("every antifraud sidebar route is a fraud-host segment route", () => {
  const sidebar = readFileSync(
    join(
      root,
      "src/app/(antifraud)/antifraud/_components/antifraud-sidebar.tsx",
    ),
    "utf8",
  );
  const appHosts = readFileSync(join(root, "src/lib/app-hosts.ts"), "utf8");
  const segmentRoutes =
    appHosts.match(
      /host:\s*`fraud\.\$\{ROOT_DOMAIN\}`[\s\S]*?segmentRoutes:\s*\[([\s\S]*?)\]/,
    )?.[1] ?? "";

  assert.notEqual(segmentRoutes, "", "fraud host segmentRoutes not found");

  const navSegments = new Set<string>();
  for (const match of sidebar.matchAll(/href:\s*"\/antifraud\/([^"/?#]+)/g)) {
    navSegments.add(match[1]);
  }

  assert.ok(navSegments.size > 0, "no antifraud nav hrefs found");
  for (const segment of navSegments) {
    assert.match(
      segmentRoutes,
      new RegExp(`"${segment}"`),
      `/antifraud/${segment} is linked in the sidebar but missing from the fraud host segmentRoutes`,
    );
  }
});
