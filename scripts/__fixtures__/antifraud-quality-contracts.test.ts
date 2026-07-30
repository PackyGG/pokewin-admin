import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function read(relative: string): string {
  return readFileSync(path.join(root, relative), "utf8");
}

test("Fraud live APIs use the same fail-closed workspace gate", () => {
  for (const route of [
    "src/app/api/antifraud/monitor/route.ts",
    "src/app/api/antifraud/monitor/stream/route.ts",
  ]) {
    const source = read(route);
    assert.match(source, /requireAntifraudAccess\(\)/);
    assert.match(source, /sec-fetch-site/);
    assert.match(source, /origin/);
    assert.match(source, /rateLimit\(/);
  }
});

test("live stream recovery keeps cursor replay and retries inside the SSE response", () => {
  const source = read("src/app/api/antifraud/monitor/stream/route.ts");
  assert.match(source, /last-event-id/);
  assert.match(source, /\/v1\/live\/replay/);
  assert.match(source, /for \(let page = 0; page < 10; page \+= 1\)/);
  assert.match(source, /scheduleReconnect/);
  assert.match(source, /CAPACITY_RETRY_MIN_MS/);
  assert.match(source, /terminalStream\(/);
  assert.match(source, /Content-Type": "text\/event-stream/);
  assert.match(source, /ROTATE_AFTER_MS = 240_000/);
});

test("Discord delivery crosses the signed durable queue instead of direct webhooks", () => {
  const sender = read("services/antifraud-monitor/src/discord-events.ts");
  const route = read("src/app/api/antifraud/discord-events/route.ts");
  const router = read("src/lib/discord-notifications/router.ts");

  assert.match(sender, /x-antifraud-timestamp/);
  assert.match(sender, /x-antifraud-signature/);
  assert.match(sender, /dedupeKey/);
  assert.doesNotMatch(sender, /DISCORD_WEBHOOK_URL/);
  assert.match(route, /timingSafeEqual/);
  assert.match(route, /ADMIN_GUILD_ID/);
  assert.match(route, /enqueueDiscordEvent/);
  assert.match(router, /dedupe_key/);
});

test("manager mutations require admin service authority and durable local audit", () => {
  const auth = read("services/antifraud-monitor/src/auth.ts");
  for (const pathFragment of [
    "/v1/rules",
    "/v1/fiat-email-domains",
    "/v1/risky-locations",
    "/decision",
    "/rescan",
    "/v1/operations/signup-failures",
  ]) {
    assert.match(auth, new RegExp(pathFragment.replaceAll("/", "\\/")));
  }
  assert.match(auth, /safeTokenEqual\(token, config\.API_ADMIN_TOKEN\)/);

  for (const action of [
    "src/app/(antifraud)/antifraud/flows/actions.ts",
    "src/app/(antifraud)/antifraud/email-blacklist/actions.ts",
    "src/app/(antifraud)/antifraud/risky-locations/actions.ts",
    "src/app/(antifraud)/antifraud/settings/actions.ts",
    "src/app/(antifraud)/antifraud/webhooks/actions.ts",
  ]) {
    assert.match(read(action), /createAdminAuditEvent\(/, action);
  }
});

test("refund safeguards remain owner/admin-only, step-up gated, and outcome-safe", () => {
  const page = read(
    "src/app/(antifraud)/antifraud/refunds/page.tsx",
  );
  const actions = read(
    "src/app/(antifraud)/antifraud/refunds/refund-actions.ts",
  );
  const client = read("src/lib/whop-admin.ts");
  const migration = read(
    "drizzle/admin/migrations/20260729_whop_refund_operations.sql",
  );

  assert.match(page, /requireAntifraudPageAccess\(\)/);
  assert.match(page, /canManageAntifraud\(session\)/);
  assert.match(actions, /requireAntifraudManager\(/);
  assert.match(actions, /require2FA/);
  assert.match(client, /maxRetries:\s*0/);
  assert.match(actions, /client\.payments\.retrieve/);
  assert.match(actions, /client\.payments\.refund/);
  assert.match(actions, /outcomeUnknown/);
  assert.match(migration, /UNIQUE \(provider_payment_id\)/);
  assert.match(migration, /'unknown'/);
});
