import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(path, "utf8");

test("dashboard creator costs include Creator Rewards payouts", () => {
  const query = read("src/lib/queries/dashboard-creator-costs-today.ts");
  const card = read(
    "src/app/(admin)/dashboard/reward-creator-costs-today-card.tsx",
  );
  const popover = read(
    "src/app/(admin)/dashboard/creator-costs-today-card.tsx",
  );

  assert.match(
    query,
    /metadata->>'adjustment_category' = 'creator_vip_reward'/,
  );
  assert.match(query, /status = 'completed'/);
  assert.match(query, /key: "creator_rewards"/);
  assert.match(query, /affiliate \+\s*creatorRewards/);
  assert.match(card, /"creator_rewards"/);
  assert.match(popover, /case "creator_rewards":/);
});
