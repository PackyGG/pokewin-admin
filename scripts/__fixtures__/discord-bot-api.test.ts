import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path: string) => readFile(path, "utf8");

test("creator stats are section-bound and aggregate every owned code", async () => {
  const [route, service, scopes, endpoints] = await Promise.all([
    read("src/app/api/v1/discord/creator-setups/stats/route.ts"),
    read("src/lib/discord-creator-setups.ts"),
    read("src/lib/api-auth/scopes.ts"),
    read("src/lib/api-auth/endpoints.ts"),
  ]);

  assert.match(route, /scopes: \["discord:creator:setup"\]/);
  assert.match(
    route,
    /guildId: DiscordIdSchema[\s\S]*categoryId: DiscordIdSchema[\s\S]*channelId: DiscordIdSchema[\s\S]*actorDiscordUserId: DiscordIdSchema/,
  );
  assert.match(route, /rejectWrongGuild/);
  assert.match(service, /export async function getCreatorSetupStats/);
  assert.match(service, /creator_user_id/);
  assert.match(service, /INTERVAL '30 days'/);
  assert.match(service, /GROUP BY GROUPING SETS/);
  assert.match(service, /affiliate_user_id = \$\{setup\.creator_user_id\}/);
  assert.match(service, /UPPER\(acu\.code\) = ANY/);
  assert.match(service, /acu\.status::text = 'completed'/);
  assert.match(service, /acu\.referred_user_id <> acu\.affiliate_user_id/);
  assert.match(service, /COUNT\(DISTINCT acu\.referred_user_id\)::text AS signups/);
  assert.match(service, /usage_type::text = 'deposit'/);
  assert.match(service, /firstTimeDepositors/);
  assert.match(service, /earningsUsd/);
  assert.doesNotMatch(scopes, /"discord:creator:read"/);
  assert.doesNotMatch(
    endpoints,
    /path: "\/api\/v1\/discord\/creator",/,
  );
  assert.match(endpoints, /\/api\/v1\/discord\/creator-setups\/stats/);
});

test("creator offer expiry is persisted and shared by list, info, and claim", async () => {
  const [expiry, compute, queries, rewards, migration] = await Promise.all([
    read("src/lib/creator-vip/offer-expiry.ts"),
    read("src/lib/creator-vip/compute.ts"),
    read("src/lib/creator-vip/queries.ts"),
    read("src/app/api/v1/discord/rewards/route.ts"),
    read(
      "drizzle/admin/migrations/20260726_creator_reward_offer_windows.sql",
    ),
  ]);

  assert.match(expiry, /5 \* 24 \* 60 \* 60 \* 1000/);
  assert.match(compute, /enforceOfferExpiry/);
  assert.match(compute, /expiredWagerBasisUsd/);
  assert.match(queries, /creator_reward_offer_windows/);
  assert.match(queries, /claimed_at/);
  assert.match(migration, /creator_reward_offer_windows/);
  assert.match(migration, /WHERE claimed_at IS NULL/);
  assert.match(rewards, /\bcodeExpired\b/);
  assert.match(rewards, /\bcode:\s*linkedAccount\.code/);
});
