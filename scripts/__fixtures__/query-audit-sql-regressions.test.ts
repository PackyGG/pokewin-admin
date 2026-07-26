import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function read(relative: string): string {
  return readFileSync(path.join(root, relative), "utf8");
}

test("deposit bonus tracker interpolates a raw SQL scope string", () => {
  const source = read(
    "src/lib/queries/rewards/deposit-bonus-tracker.ts",
  );

  assert.match(
    source,
    /import \{ realCustomerIdsSubquery \} from "@\/lib\/queries\/_blacklist";/,
  );
  assert.equal(
    (source.match(/realCustomerIdsSubquery\(blacklistIds\)/g) ?? []).length,
    2,
  );
  assert.doesNotMatch(source, /staffAndBlacklistSubquery/);
});

test("uuid primary-key lookups bind uuid arrays", () => {
  const dashboard = read(
    "src/lib/queries/dashboard-reward-costs-today.ts",
  );
  const rewards = read("src/lib/queries/rewards.ts");

  assert.match(
    dashboard,
    /FROM packs[\s\S]*?WHERE id = ANY\(\$1::uuid\[\]\)/,
  );
  assert.match(
    dashboard,
    /FROM cards[\s\S]*?WHERE id = ANY\(\$1::uuid\[\]\)/,
  );
  assert.match(
    rewards,
    /FROM packs[\s\S]*?WHERE id = ANY\(\$1::uuid\[\]\)/,
  );
});

test("founder text user ids are never cast to uuid", () => {
  const source = read(
    "src/lib/queries/insights-rewards/motha/overview.ts",
  );

  assert.equal((source.match(/\$\{mothaId\}/g) ?? []).length, 4);
  assert.doesNotMatch(source, /\$\{mothaId\}::uuid/);
});
