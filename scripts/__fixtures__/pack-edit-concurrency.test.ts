import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const actions = readFileSync("src/app/(admin)/packs/actions.ts", "utf8");
const form = readFileSync("src/app/(admin)/packs/pack-edit-form.tsx", "utf8");
const query = readFileSync("src/lib/queries/packs.ts", "utf8");

test("full pack edits carry the loaded MAIN row version", () => {
  assert.match(query, /p\.updated_at::text AS updated_at/);
  assert.match(query, /updatedAt: pack\.updated_at/);
  assert.match(form, /expectedUpdatedAt: pack\.updatedAt/);
});

test("stale pack edits are rejected under a row lock", () => {
  assert.match(
    actions,
    /SELECT active, updated_at::text AS updated_at[\s\S]*?FOR UPDATE/,
  );
  assert.match(actions, /locked\.updated_at !== data\.expectedUpdatedAt/);
  assert.match(actions, /Your stale form was not saved/);
});

test("a save verifies the committed card count and total weight", () => {
  assert.match(actions, /COUNT\(\*\)::int AS card_count/);
  assert.match(actions, /COALESCE\(SUM\(weight\), 0\)::text AS total_weight/);
  assert.match(actions, /Pack verification failed\. No changes were committed\./);
  assert.match(form, /Pack updated, verified, and live/);
  assert.match(actions, /const liveCacheReloaded = await reloadPacksConfirmed\(\)/);
  assert.match(actions, /await reloadPacksConfirmed\(3\)/);
});
