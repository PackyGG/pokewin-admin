import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const webhook = readFileSync("src/lib/creator-vip/bot-webhook.ts", "utf8");
const actions = readFileSync(
  "src/app/(creator-hub)/creator-hub/rewards/actions.ts",
  "utf8",
);

test("claim decision duplicates are not reported as delivered", () => {
  assert.match(webhook, /force\?: boolean;/);
  assert.match(
    webhook,
    /if \(body\?\.ignored === "duplicate"\) \{[\s\S]*?ok: false,[\s\S]*?duplicate: true,/,
  );
  assert.doesNotMatch(
    webhook,
    /ok: true,[\s\S]{0,120}duplicate: body\?\.ignored === "duplicate"/,
  );
});

test("staff resend forces a real attempt and uses that attempt's result", () => {
  const resend = actions.slice(
    actions.indexOf("export async function resendClaimDecisionNotice"),
    actions.indexOf("export async function testBotWebhookConnection"),
  );

  assert.match(resend, /force: true,/);
  assert.match(resend, /const delivered = result\?\.ok === true;/);
  assert.match(resend, /return delivered/);
  assert.doesNotMatch(resend, /return after_\?\.bot_notified_at/);
});

