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

test("account networks are user-linked drill-downs, not a standalone workspace", () => {
  const sidebar = readFileSync(
    join(
      root,
      "src/app/(antifraud)/antifraud/_components/antifraud-sidebar.tsx",
    ),
    "utf8",
  );
  const page = readFileSync(
    join(root, "src/app/(antifraud)/antifraud/networks/page.tsx"),
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

  assert.doesNotMatch(sidebar, /SidebarGroupLabel>Network/);
  assert.doesNotMatch(sidebar, /href:\s*"\/antifraud\/networks"/);
  assert.match(page, /if \(!userId\) notFound\(\)/);
  assert.match(page, /getAccountNetwork\(userId\)/);
  assert.doesNotMatch(page, /searchNetworkAccounts|name="q"|Search accounts/);
  assert.doesNotMatch(dashboardApi, /searchNetworkAccounts/);
  assert.doesNotMatch(monitorRoutes, /\/v1\/networks\/search/);
  assert.match(
    userDetail,
    /href=\{`\/antifraud\/networks\?user=\$\{encodeURIComponent\(user\.id\)\}`\}/,
  );
});
