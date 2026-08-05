import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();

function source(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

test("fraud navigation owns a manager-only System Discord route", () => {
  const sidebar = source(
    "src/app/(antifraud)/antifraud/_components/antifraud-sidebar.tsx",
  );
  const appHosts = source("src/lib/app-hosts.ts");
  const antifraudHost =
    appHosts.match(
      /host:\s*`fraud\.\$\{ROOT_DOMAIN\}`[\s\S]*?segmentRoutes:\s*\[([\s\S]*?)\]/,
    )?.[1] ?? "";

  assert.match(sidebar, /label="System"/);
  assert.doesNotMatch(sidebar, /label="Notifications"|NOTIFICATION_NAV/);
  assert.match(sidebar, /label:\s*"Discord routing"/);
  assert.match(sidebar, /href:\s*"\/antifraud\/discord"/);
  assert.match(sidebar, /\{canManage && \([\s\S]*items=\{SYSTEM_NAV\}/);
  assert.match(antifraudHost, /"discord"/);
});

test("webhooks page is manager-gated and renders the bot routing workspace", () => {
  const page = source("src/app/(antifraud)/antifraud/discord/page.tsx");

  assert.match(page, /await requireAntifraudManagerPage\(\)/);
  assert.match(page, /getDiscordNotificationConfig\(\)/);
  assert.match(page, /DiscordRoutingWorkspace/);
});
