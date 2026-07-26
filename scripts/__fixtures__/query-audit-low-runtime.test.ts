import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function read(relative: string): string {
  return readFileSync(path.join(root, relative), "utf8");
}

test("pack drilldown orders by numeric aggregates, not text aliases", () => {
  const source = read("src/lib/queries/insights-games/pack-drilldown.ts");

  assert.match(
    source,
    /ORDER BY COUNT\(\*\) DESC, COALESCE\(SUM\(p\.value\), 0\) DESC/,
  );
  assert.doesNotMatch(source, /ORDER BY pulls::bigint/);
});

test("upgrader-only top users avoids empty enum comparisons", () => {
  const source = read("src/lib/queries/insights-games/top-users.ts");

  assert.match(source, /const wagerTypePredicate = wagerTypes\.length > 0/);
  assert.match(source, /const invSourcePredicate = invSourceTypes\.length > 0/);
  assert.doesNotMatch(source, /: "''"/);
  assert.doesNotMatch(source, /lt\.type IN \(\$\{wagerTypeIn\}\)/);
});

test("battle pack ids are passed as a bound uuid array", () => {
  const source = read("src/lib/queries/insights-games/battle-drilldown.ts");

  assert.match(source, /WHERE id = ANY\(\$1::uuid\[\]\)/);
  assert.match(source, /ORDER BY price DESC`,\s*packIds,/);
  assert.doesNotMatch(source, /packIds\.map/);
});

test("rain search uses the shared strict UUID validator", () => {
  const source = read("src/lib/queries/rain.ts");

  assert.match(source, /import \{ isUuid \} from "@\/lib\/utils\/ids";/);
  assert.match(source, /search && isUuid\(search\) \? search : null/);
});

test("reward rows normalize nullable pack arrays without losing uuid binding", () => {
  const source = read("src/lib/queries/rewards.ts");

  assert.equal(
    (
      source.match(
        /COALESCE\(pack_ids, ARRAY\[\]::uuid\[\]\) AS pack_ids/g,
      ) ?? []
    ).length,
    2,
  );
  assert.match(source, /WHERE id = ANY\(\$1::uuid\[\]\)/);
});

test("reward recipients and sets use stable numeric and null ordering", () => {
  const rewards = read("src/lib/queries/rewards-analytics.ts");
  const sets = read("src/lib/queries/sets.ts");

  assert.match(
    rewards,
    /ORDER BY SUM\(CASE WHEN \$\{rewardRowPredicate\("lt"\)\} THEN ABS\(lt\.amount::numeric\) ELSE 0 END\) DESC/,
  );
  assert.doesNotMatch(rewards, /ORDER BY total DESC/);
  assert.match(sets, /s\.release_date ASC NULLS LAST/);
  assert.match(sets, /s\.release_date DESC NULLS LAST/);
});
