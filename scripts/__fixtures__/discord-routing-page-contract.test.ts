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

test("Discord Routing is a selectable two-panel channel manager", () => {
  const workspace = source(
    "src/app/(antifraud)/antifraud/discord/routing-workspace.tsx",
  );

  assert.match(workspace, /initialConfig\.channels/);
  assert.match(workspace, /initialConfig\.events/);
  assert.match(workspace, /initialConfig\.routes/);
  assert.match(workspace, /aria-label="Discord channel tree"/);
  assert.match(workspace, /role="tree"/);
  assert.match(workspace, /role="treeitem"/);
  assert.match(workspace, /aria-selected=/);
  assert.match(workspace, /aria-label="Channel editor"/);
  assert.match(workspace, /activeChannelGroups/);
  assert.match(workspace, /Create Discord channel/);
  assert.match(workspace, /Add existing/);
  assert.match(workspace, />Main section</);
  assert.match(workspace, /createDiscordChannelAction/);
  assert.match(workspace, /Save changes/);
  assert.match(workspace, /replaceChannelRoutesAction/);
  assert.match(workspace, /function DeliveryIndicator/);
  assert.doesNotMatch(workspace, />Active channels</);
  assert.doesNotMatch(workspace, /function ChannelEditorDialog/);
  assert.doesNotMatch(workspace, /createCustomEventAction|CreateEventDialog|New event/);
});

test("Discord Routing categories are independently collapsible", () => {
  const workspace = source(
    "src/app/(antifraud)/antifraud/discord/routing-workspace.tsx",
  );

  assert.match(workspace, /collapsedCategoryIds/);
  assert.match(workspace, /<CollapsibleTrigger/);
  assert.match(workspace, /<CollapsibleContent/);
  assert.match(workspace, /Collapse.*Expand.*group\.name/);
});

test("channel actions stay compact and destructive removal stays tucked away", () => {
  const workspace = source(
    "src/app/(antifraud)/antifraud/discord/routing-workspace.tsx",
  );

  assert.match(workspace, /<DropdownMenu/);
  assert.match(workspace, /setCreateChannelOpen\(true\)/);
  assert.match(workspace, /onClick=\{openNewChannel\}/);
  assert.match(workspace, /aria-label={`Actions for #\${channel\.name}`}/);
  assert.match(workspace, /onClick=\{\(\) => removeChannel\(channel\)\}/);
  assert.match(workspace, /pendingRemoveChannel/);
});

test("unassigned alerts and event categories stay easy to scan", () => {
  const workspace = source(
    "src/app/(antifraud)/antifraud/discord/routing-workspace.tsx",
  );

  assert.match(workspace, /unassignedEvents/);
  assert.match(workspace, /showUnassigned/);
  assert.match(workspace, />Unassigned/);
  assert.match(workspace, /groupedEvents/);
  assert.match(workspace, /event\.category/);
  assert.match(workspace, /title=\{event\.description\}/);
  assert.doesNotMatch(
    workspace,
    /className="mt-1 block text-xs text-muted-foreground"[\s\S]{0,80}\{event\.description\}/,
  );
});

test("mobile editing uses one full-screen sheet while desktop stays inline", () => {
  const workspace = source(
    "src/app/(antifraud)/antifraud/discord/routing-workspace.tsx",
  );

  assert.match(workspace, /useIsMobile/);
  assert.match(workspace, /\{isMobile && \(/);
  assert.match(workspace, /<Sheet/);
  assert.match(workspace, /className="w-full max-w-none[^\"]*md:hidden"/);
  assert.match(workspace, /className="hidden min-w-0 md:block"/);
  assert.match(workspace, /<SheetTitle>/);
});

test("every Discord route mutation is permission-gated and audited", () => {
  const actions = source(
    "src/app/(antifraud)/antifraud/discord/actions.ts",
  );

  assert.equal(
    actions.match(/requireAntifraudManager\(\)/g)?.length,
    5,
  );
  assert.equal(actions.match(/createAdminAuditEvent\(/g)?.length, 5);
  assert.doesNotMatch(actions, /createCustomEventAction|createEventSchema/);
  assert.match(actions, /discord_notification_channel_routes_replaced/);
  assert.match(actions, /discord_notification_channel_creation_queued/);
  assert.doesNotMatch(actions, /WEBHOOK_URL|DISCORD_TOKEN/);
});
