import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const root = process.cwd();

function source(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

test("direct notification availability follows the resolved backend target", () => {
  const availability = source(
    "src/lib/backend-api/user-notifications-availability.ts",
  );
  const actions = source("src/app/(admin)/notifications/direct-actions.ts");
  assert.doesNotMatch(availability, /DIRECT_NOTIFICATIONS_DEV_ONLY/);
  assert.match(
    availability,
    /return \{ backendEnv, ready: true, reason: null \}/,
  );
  assert.doesNotMatch(actions, /dev environment only|requireDevEnv/);
});

test("reward campaigns require the backend and writable database to match", () => {
  const action = source("src/app/(admin)/notifications/reward-actions.ts");
  assert.match(action, /availability\.backendEnv !== dbEnv/);
  assert.doesNotMatch(action, /readDbEnvFromCookie\(\)\) !== "dev"/);
});

test("direct composers identify and confirm their resolved environment", () => {
  const content = source(
    "src/app/(admin)/notifications/direct-notifications-content.tsx",
  );
  const single = source(
    "src/app/(admin)/notifications/single-notification-form.tsx",
  );
  const bulk = source(
    "src/app/(admin)/notifications/bulk-notification-form.tsx",
  );
  const reward = source(
    "src/app/(admin)/notifications/reward-campaign-form.tsx",
  );

  assert.match(
    content,
    /backendEnv=\{availability\.backendEnv\}|targetEnv=\{backendEnv\}/,
  );
  assert.match(single, /targetEnv === "prod"/);
  assert.match(bulk, /targetEnv\.toUpperCase\(\)/);
  assert.match(reward, /targetEnv\.toUpperCase\(\)/);
  assert.doesNotMatch(
    single,
    /useState\("promo_code_granted"\)|PACKY-A1B2-C3D4/,
  );
});

test("Keno operations use customer scope and expose recent settled games", () => {
  const query = source("src/lib/queries/keno.ts");
  const overview = source("src/app/(admin)/keno/_components/overview-tab.tsx");

  assert.match(query, /excludeStaffCreatorsAndBlacklistedSqlFromIds/);
  assert.match(query, /recent_rows AS/);
  assert.match(query, /recentGames:/);
  assert.match(overview, /Recent settled games/);
  assert.match(overview, /Customer scope only/);
});

test("Fiat overview surfaces provider reconciliation and pipeline freshness", () => {
  const overview = source("src/app/(admin)/fiat/_components/fiat-tabs.tsx");

  for (const field of [
    "customerPaidUsd",
    "providerNetUsd",
    "providerFeesUsd",
    "failedWebhooks",
    "latestWebhookAt",
  ]) {
    assert.match(overview, new RegExp(`data\\.${field}`));
  }
});

test("released feature reads recover from transient mirror connection failures", () => {
  const sources = [
    source("src/lib/queries/fiat.ts"),
    source("src/lib/queries/keno.ts"),
    source("src/lib/queries/dashboard-keno.ts"),
    source("src/app/(admin)/notifications/direct-actions.ts"),
  ];

  for (const file of sources) {
    assert.match(file, /withTransientPostgresReadRetry/);
  }

  assert.match(sources[0], /fiat\.overview/);
  assert.match(sources[0], /fiat\.access/);
  assert.match(sources[0], /fiat\.webhooks\.summary/);
  assert.match(sources[1], /keno\.operations/);
  assert.match(sources[2], /dashboard\.keno/);
  assert.match(sources[3], /notifications\.recipient-search/);
});
