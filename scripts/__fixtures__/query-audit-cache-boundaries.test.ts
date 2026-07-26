import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function read(relative: string): string {
  return readFileSync(path.join(root, relative), "utf8");
}

test("card cache computations use an explicit env and bypass cache on dev", () => {
  const source = read("src/lib/queries/cards.ts");

  for (const helper of [
    "fetchCardsListCount",
    "fetchCardInventoryCount",
    "fetchRarities",
    "fetchCardsStats",
  ]) {
    const start = source.indexOf(`async function ${helper}`);
    assert.notEqual(start, -1, `missing ${helper}`);
    const body = source.slice(start, source.indexOf("\n}", start) + 2);
    assert.match(body, /env: DbEnv/);
    assert.match(body, /drizzleForEnv\(env\)/);
    assert.doesNotMatch(body, /getDrizzleDb\(\)/);
  }

  assert.match(
    source,
    /env === "prod"\s*\? getCardsListCount[\s\S]*?: fetchCardsListCount/,
  );
  assert.match(
    source,
    /env === "prod"\s*\? getCardInventoryCount[\s\S]*?: fetchCardInventoryCount/,
  );
  assert.equal(
    (source.match(/if \(env !== "prod"\) return fetch/g) ?? []).length,
    2,
  );
});

test("signup overview resolves env before cache and caches only prod", () => {
  const source = read(
    "src/lib/queries/insights-rewards/signup/overview.ts",
  );

  assert.match(
    source,
    /computeOverview\([\s\S]*?env: DbEnv,[\s\S]*?drizzleForEnv\(env\)/,
  );
  assert.equal(
    (source.match(/computeOverview\(period, blacklistIds, "prod"\)/g) ?? [])
      .length,
    2,
  );
  assert.match(
    source,
    /const env = await readDbEnv\(\);\s*if \(env !== "prod"\) return computeOverview\(period, sorted, env\);/,
  );
});

test("pack KPI stats use request env and bypass shared cache on dev", () => {
  const source = read("src/lib/queries/packs.ts");
  const start = source.indexOf("async function fetchPacksListStats");
  const body = source.slice(
    start,
    source.indexOf("\nexport async function getPacksListStats", start),
  );

  assert.match(body, /env: DbEnv/);
  assert.match(body, /drizzleForEnv\(env\)/);
  assert.doesNotMatch(body, /getDrizzleDb\(\)/);
  assert.match(
    source,
    /const env = await readDbEnv\(\);\s*if \(env !== "prod"\) return fetchPacksListStats\(set, env\);/,
  );
  assert.match(source, /fetchPacksListStats\(set, "prod"\)/);
});
