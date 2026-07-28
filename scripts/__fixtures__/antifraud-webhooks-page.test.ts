import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();

function source(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

test("fraud navigation owns a manager-only Notifications webhooks route", () => {
  const sidebar = source(
    "src/app/(antifraud)/antifraud/_components/antifraud-sidebar.tsx",
  );
  const appHosts = source("src/lib/app-hosts.ts");
  const antifraudHost =
    appHosts.match(
      /host:\s*`fraud\.\$\{ROOT_DOMAIN\}`[\s\S]*?segmentRoutes:\s*\[([\s\S]*?)\]/,
    )?.[1] ?? "";

  assert.match(sidebar, /SidebarGroupLabel>Notifications/);
  assert.match(sidebar, /label:\s*"Webhooks"/);
  assert.match(sidebar, /href:\s*"\/antifraud\/webhooks"/);
  assert.match(sidebar, /\{canManage && \([\s\S]*NOTIFICATION_NAV/);
  assert.match(antifraudHost, /"webhooks"/);
});

test("webhooks page is manager-gated and consumes only the monitor registry", () => {
  const page = source(
    "src/app/(antifraud)/antifraud/webhooks/page.tsx",
  );
  const monitorApi = source("src/lib/antifraud/monitor-api.ts");

  assert.match(page, /await requireAntifraudManagerPage\(\)/);
  assert.match(page, /getAntifraudNotificationRoutes\(\)/);
  assert.match(page, /runtime\.data\?\.routes/);
  assert.doesNotMatch(page, /ANTIFRAUD_[A-Z_]+|FIAT_[A-Z_]+/);
  assert.doesNotMatch(page, /route\.(?:url|token|secret|signature|webhookId)/i);
  assert.match(monitorApi, /label:\s*z\.string\(\)/);
  assert.match(monitorApi, /purpose:\s*z\.string\(\)/);
  assert.match(monitorApi, /eventFamilies:\s*z\.array\(z\.string\(\)\)/);
  assert.match(monitorApi, /configured:\s*z\.boolean\(\)/);
});
