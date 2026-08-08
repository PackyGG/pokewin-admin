import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("creator stream events expose recipient-aware tip and sponsored-battle logs", async () => {
  const [service, route, endpoints] = await Promise.all([
    readFile("src/lib/discord-creator-setups.ts", "utf8"),
    readFile(
      "src/app/api/v1/discord/creator-setups/stream-events/route.ts",
      "utf8",
    ),
    readFile("src/lib/api-auth/endpoints.ts", "utf8"),
  ]);

  assert.match(route, /scopes: \["discord:creator:setup"\]/);
  assert.match(route, /after: z\.string\(\)\.datetime\(\{ offset: true \}\)/);
  assert.match(endpoints, /\/api\/v1\/discord\/creator-setups\/stream-events/);

  assert.match(service, /activityEvents/);
  assert.match(service, /lt\.metadata->>'direction' = 'sent'/);
  assert.match(service, /lt\.metadata->>'recipient_user_id'/);
  assert.match(service, /'creator_tip'/);
  assert.match(service, /'creator_fill_spend_tip'/);
  assert.match(service, /'creator_multiplier_spend_tip'/);
  assert.match(service, /lt\.status::text = 'completed'/);

  assert.match(service, /JOIN battles b ON b\.id = bp\.battle_id/);
  assert.match(service, /b\.user_id AS creator_user_id/);
  assert.match(service, /bp\.user_id AS recipient_user_id/);
  assert.match(service, /bp\.user_id <> b\.user_id/);
  assert.match(service, /b\.sponsorship_percentage > 0/);
  assert.match(
    service,
    /b\.bet_amount::numeric \* b\.sponsorship_percentage::numeric \/ 100/,
  );

  // The cursor is deliberately applied after the windows: older actions must
  // still contribute to the recipient-specific count and cumulative total.
  assert.match(service, /COUNT\(\*\) OVER[\s\S]*recipient_event_count/);
  assert.match(service, /SUM\(amount_usd\) OVER[\s\S]*recipient_total_usd/);
  assert.match(
    service,
    /FROM all_tip_actions action[\s\S]*WHERE ranked\.occurred_at >= \$\{cutoff\}::timestamptz/,
  );
  assert.match(
    service,
    /FROM all_sponsored_recipients action[\s\S]*WHERE ranked\.occurred_at >= \$\{cutoff\}::timestamptz/,
  );
  assert.match(
    service,
    /COALESCE\(recipient\.display_username, recipient\.username, recipient\.name, recipient\.id\)/,
  );
  assert.doesNotMatch(
    service.slice(
      service.indexOf("export async function getCreatorSetupStreamEvents"),
      service.indexOf("export async function getCreatorSetupUserStats"),
    ),
    /recipient\.email/,
  );
});
