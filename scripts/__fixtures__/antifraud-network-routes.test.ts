import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();

test("Creator Fraud stays in Marketing without a Fraud network route", () => {
  const appHosts = readFileSync(join(root, "src/lib/app-hosts.ts"), "utf8");
  const antifraudHost =
    appHosts.match(
      /host:\s*`fraud\.\$\{ROOT_DOMAIN\}`[\s\S]*?segmentRoutes:\s*\[([\s\S]*?)\]/,
    )?.[1] ?? "";
  const marketingHost =
    appHosts.match(
      /basePath:\s*"\/creator-hub",[\s\S]*?segmentRoutes:\s*\[([\s\S]*?)\]/,
    )?.[1] ?? "";

  assert.doesNotMatch(antifraudHost, /"networks"/);
  assert.doesNotMatch(antifraudHost, /"creator-fraud"/);
  assert.match(antifraudHost, /"flows"/);
  assert.match(antifraudHost, /"events"/);
  assert.match(marketingHost, /"creator-fraud"/);
});

test("unrequested profile and network pages stay removed", () => {
  const sidebar = readFileSync(
    join(
      root,
      "src/app/(antifraud)/antifraud/_components/antifraud-sidebar.tsx",
    ),
    "utf8",
  );
  const dashboardApi = readFileSync(
    join(root, "src/lib/antifraud/network-api.ts"),
    "utf8",
  );
  const monitorRoutes = readFileSync(
    join(root, "services/antifraud-monitor/src/network-routes.ts"),
    "utf8",
  );
  const userDetail = readFileSync(
    join(root, "src/app/(admin)/users/[id]/user-view-modern.tsx"),
    "utf8",
  );

  assert.doesNotMatch(sidebar, /\/antifraud\/(?:profiles|networks)/);
  assert.equal(
    existsSync(join(root, "src/app/(antifraud)/antifraud/profiles/page.tsx")),
    false,
  );
  assert.equal(
    existsSync(join(root, "src/app/(antifraud)/antifraud/networks/page.tsx")),
    false,
  );
  assert.doesNotMatch(dashboardApi, /searchNetworkAccounts/);
  assert.doesNotMatch(monitorRoutes, /\/v1\/networks\/search/);
  assert.doesNotMatch(userDetail, /\/antifraud\/networks/);
});
