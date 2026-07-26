import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path: string) => readFile(path, "utf8");

test("creator endpoint resolves its code server-side and exposes the bot contract", async () => {
  const [route, scopes, endpoints] = await Promise.all([
    read("src/app/api/v1/discord/creator/route.ts"),
    read("src/lib/api-auth/scopes.ts"),
    read("src/lib/api-auth/endpoints.ts"),
  ]);

  assert.match(route, /scopes: \["discord:creator:read"\]/);
  assert.match(
    route,
    /const BodySchema = z\.object\(\{\s*discordUserId:[\s\S]*?\n\}\);/,
  );
  for (const field of [
    "programs",
    "players",
    "active7d",
    "wagerUsd",
    "payoutsUsd",
  ]) {
    assert.match(route, new RegExp(`\\b${field}\\b`));
  }
  assert.match(scopes, /"discord:creator:read"/);
  assert.match(endpoints, /\/api\/v1\/discord\/creator/);
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
