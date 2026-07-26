import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = readFileSync(
  path.join(root, "src/lib/queries/analytics-packs.ts"),
  "utf8",
);
const battleWager = source.slice(
  source.indexOf("WITH battle_wager AS ("),
  source.indexOf("battle_wager_agg AS ("),
);

test("battle pack revenue has explicit bet and sponsorship arms", () => {
  assert.match(battleWager, /lt\.type::text = 'battle_bet'/);
  assert.match(battleWager, /UNION ALL/);
  assert.match(battleWager, /lt\.type::text = 'battle_sponsorship'/);
  assert.match(
    battleWager,
    /JOIN battles b ON b\.id = \(lt\.metadata->>'battle_id'\)::uuid/,
  );
});

test("sponsorship attribution keeps customer, borrow, and period filters", () => {
  const sponsorship = battleWager.slice(
    battleWager.indexOf("WHERE lt.type::text = 'battle_sponsorship'"),
  );

  assert.match(sponsorship, /lt\.status = 'completed'/);
  assert.match(sponsorship, /COALESCE\(b\.borrow_percentage, 0\) = 0/);
  assert.match(sponsorship, /lt\.user_id IN \$\{realCustomers\}/);
  assert.match(sponsorship, /\$\{ltWhere\}/);
});
