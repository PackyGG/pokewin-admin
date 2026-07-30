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
    source("src/app/(antifraud)/antifraud/discord/page.tsx"),
    /requireAntifraudManagerPage\(\)/,
  );
  assert.match(
    source("src/middleware.ts"),
    /fraudHost\.host\}\/discord/,
  );
});

test("Discord Routing exposes active channels with add and edit event flows", () => {
  const workspace = source(
    "src/app/(antifraud)/antifraud/discord/routing-workspace.tsx",
  );

  assert.match(workspace, /initialConfig\.channels/);
  assert.match(workspace, /initialConfig\.events/);
  assert.match(workspace, /initialConfig\.routes/);
  assert.match(workspace, />Active channels</);
  assert.match(workspace, /New channel/);
  assert.match(workspace, /Create Discord channel/);
  assert.match(workspace, />Main section</);
  assert.match(workspace, /createDiscordChannelAction/);
  assert.match(workspace, /Save changes/);
  assert.match(workspace, /replaceChannelRoutesAction/);
  assert.match(workspace, /createCustomEventAction/);
});

test("every Discord route mutation is permission-gated and audited", () => {
  const actions = source(
    "src/app/(antifraud)/antifraud/discord/actions.ts",
  );

  assert.equal(
    actions.match(/requireAntifraudManager\(\)/g)?.length,
    6,
  );
  assert.equal(actions.match(/createAdminAuditEvent\(/g)?.length, 6);
  assert.match(actions, /discord_notification_channel_routes_replaced/);
  assert.match(actions, /discord_notification_channel_creation_queued/);
  assert.doesNotMatch(actions, /WEBHOOK_URL|DISCORD_TOKEN/);
});
