import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { getSidebarGroups } from "../../src/lib/nav-config";

function source(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

test("Discord Routing is a grantable System page", () => {
  const system = getSidebarGroups().find((group) => group.label === "System");
  const entry = system?.items.find((item) => item.id === "nav.webhooks");

  assert.equal(entry?.href, "/webhooks");
  assert.equal(entry?.pageKey, "/webhooks");
  assert.match(source("src/lib/admin-pages.ts"), /key:\s*"\/webhooks"/);
  assert.match(
    source("src/app/(admin)/webhooks/page.tsx"),
    /requirePageAccess\("\/webhooks"\)/,
  );
});

test("Discord Routing exposes channel inventory and many-to-many event routes", () => {
  const workspace = source(
    "src/app/(admin)/webhooks/routing-workspace.tsx",
  );

  assert.match(workspace, /initialConfig\.channels/);
  assert.match(workspace, /initialConfig\.events/);
  assert.match(workspace, /initialConfig\.routes/);
  assert.match(workspace, /upsertRouteAction/);
  assert.match(workspace, /setRouteEnabledAction/);
  assert.match(workspace, /deleteRouteAction/);
  assert.match(workspace, /createCustomEventAction/);
});

test("every Discord route mutation is permission-gated and audited", () => {
  const actions = source("src/app/(admin)/webhooks/actions.ts");

  assert.equal(
    actions.match(/requirePageAccess\("\/webhooks"\)/g)?.length,
    4,
  );
  assert.equal(actions.match(/createAdminAuditEvent\(/g)?.length, 4);
  assert.doesNotMatch(actions, /WEBHOOK_URL|DISCORD_TOKEN/);
});
