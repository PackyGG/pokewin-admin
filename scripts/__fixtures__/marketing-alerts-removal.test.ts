import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();

function source(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

test("Marketing has no live docked-alert implementation or action endpoint", () => {
  const removedPaths = [
    "src/app/(creator-hub)/creator-hub/_components/docked-alerts.tsx",
    "src/app/(creator-hub)/creator-hub/_components/docked-alerts-actions.ts",
    "src/app/(creator-hub)/creator-hub/alerts/actions.ts",
    "src/app/(creator-hub)/creator-hub/alerts/_components/alerts-list.tsx",
    "src/app/(creator-hub)/creator-hub/alerts/_queries/creator-alerts.ts",
    "src/components/right-rail-context.tsx",
    "src/components/rail-width-sync.tsx",
    "src/lib/right-rail-cookie.ts",
    "src/lib/right-rail-server.ts",
  ];

  for (const path of removedPaths) {
    assert.equal(existsSync(join(root, path)), false, `${path} must stay removed`);
  }

  const layout = source("src/app/(creator-hub)/creator-hub/layout.tsx");
  assert.doesNotMatch(
    layout,
    /DockedAlerts|RightRailProvider|RailWidthSync|readRailOpenOrder/,
  );

  const globals = source("src/app/globals.css");
  assert.doesNotMatch(globals, /--rail-occupied|\[data-admin-scroll\]/);

  const responsiveRunner = source("e2e/responsive/runner.ts");
  assert.doesNotMatch(
    responsiveRunner,
    /docked-alerts:open|right-rail:open-order|seedCollapsedRail/,
  );
});

test("the removal is bounded to Marketing and preserves shared notifications", () => {
  const hosts = source("src/lib/app-hosts.ts");
  assert.match(hosts, /host:\s*`marketing\.\$\{ROOT_DOMAIN\}`/);
  assert.match(hosts, /host:\s*`packs\.\$\{ROOT_DOMAIN\}`/);
  assert.match(hosts, /host:\s*`fraud\.\$\{ROOT_DOMAIN\}`/);

  const header = source("src/components/admin-header.tsx");
  assert.match(header, /import\s+\{\s*NotificationBell\s*\}/);
  assert.match(header, /<NotificationBell\s*\/>/);

  for (const layout of [
    "src/app/(admin)/layout.tsx",
    "src/app/(creator-hub)/creator-hub/layout.tsx",
    "src/app/(pack-studio)/pack-studio/layout.tsx",
    "src/app/(antifraud)/antifraud/layout.tsx",
  ]) {
    assert.match(source(layout), /<AdminHeader\b/, `${layout} lost AdminHeader`);
  }

  assert.equal(
    existsSync(join(root, "src/components/notification-bell.tsx")),
    true,
  );
  assert.equal(
    existsSync(join(root, "src/components/notification-bell-actions.ts")),
    true,
  );
  assert.equal(
    existsSync(
      join(root, "src/app/(admin)/system/staff-notifications/page.tsx"),
    ),
    true,
  );
  assert.equal(
    existsSync(
      join(root, "src/app/(antifraud)/antifraud/notifications/page.tsx"),
    ),
    true,
  );
});
