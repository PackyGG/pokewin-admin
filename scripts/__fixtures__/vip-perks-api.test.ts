import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path: string) => readFile(path, "utf8");

test("VIP perks API is scoped, bounded, real-money weighted, and fail-closed", async () => {
  const [service, policy, sync, status, scopes, endpoints, migration, compute] =
    await Promise.all([
      read("src/lib/vip-perks.ts"),
      read("src/lib/vip-perks-policy.ts"),
      read("src/app/api/v1/discord/vips/perks/sync/route.ts"),
      read("src/app/api/v1/discord/vips/perks/status/route.ts"),
      read("src/lib/api-auth/scopes.ts"),
      read("src/lib/api-auth/endpoints.ts"),
      read("drizzle/admin/migrations/20260820_vip_perks_entitlements.sql"),
      read("src/lib/creator-vip/compute.ts"),
    ]);

  assert.match(service, /getProdReadDrizzleDb/);
  assert.match(service, /COALESCE\(g\.weighted_bet_amount, g\.bet_amount\)/);
  assert.match(service, /g\.race_eligible = true/);
  assert.match(service, /g\.currency = 'real'/);
  assert.match(service, /pgArrayParam\(params\.userIds \?\? \[\]\)/);
  assert.match(service, /MAX_BATCH_SIZE = 100/);
  assert.match(service, /isVipPerksActive/);
  assert.match(service, /Fail-closed entitlement check failed/);
  assert.match(policy, /VIP_PERKS_WINDOW_DAYS = 30/);
  assert.match(policy, /recurring_due/);
  assert.match(sync, /scopes: \["discord:vips:perks"\]/);
  assert.match(sync, /maxDuration = 120/);
  assert.match(status, /scopes: \["discord:vips:perks"\]/);
  assert.match(scopes, /"discord:vips:perks"/);
  assert.match(endpoints, /\/api\/v1\/discord\/vips\/perks\/sync/);
  assert.match(endpoints, /\/api\/v1\/discord\/vips\/perks\/status/);
  assert.match(migration, /initial_window_started_at/);
  assert.match(migration, /discord:vips:link/);
  assert.match(compute, /const isVipNow = isVipPerksActive/);
  assert.match(compute, /VIP perks are not active for this account/);
});
