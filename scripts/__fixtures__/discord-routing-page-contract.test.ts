import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

test("Discord Routing belongs only to the manager-gated Fraud workspace", () => {
  assert.doesNotMatch(source("src/lib/nav-config.ts"), /id:\s*"nav\.webhooks"/);
  assert.doesNotMatch(source("src/lib/admin-pages.ts"), /key:\s*"\/webhooks"/);
  assert.match(
    source("src/app/(antifraud)/antifraud/webhooks/page.tsx"),
    /requireAntifraudManagerPage\(\)/,
  );
  assert.match(
    source("src/middleware.ts"),
    /fraudHost\.host\}\/webhooks/,
  );
});

test("Discord Routing exposes channel inventory and many-to-many event routes", () => {
  const workspace = source(
    "src/app/(antifraud)/antifraud/webhooks/routing-workspace.tsx",
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
  const actions = source(
    "src/app/(antifraud)/antifraud/webhooks/actions.ts",
  );

  assert.equal(
    actions.match(/requireAntifraudManager\(\)/g)?.length,
    4,
  );
  assert.equal(actions.match(/createAdminAuditEvent\(/g)?.length, 4);
  assert.doesNotMatch(actions, /WEBHOOK_URL|DISCORD_TOKEN/);
});
