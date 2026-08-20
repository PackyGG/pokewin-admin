import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(path, "utf8");

test("creator reward end dates are persisted and enforced", () => {
  const migration = read(
    "drizzle/admin/migrations/20260806_creator_reward_program_end_date.sql",
  );
  assert.match(migration, /ADD COLUMN IF NOT EXISTS ends_at timestamptz/);
  assert.match(migration, /ends_at > accrual_start_at/);

  const actions = read(
    "src/app/(creator-hub)/creator-hub/rewards/actions.ts",
  );
  assert.match(actions, /endsAt: z\.string\(\)\.datetime\(\)\.nullable\(\)/);
  assert.match(actions, /End date must be in the future/);
  assert.match(actions, /ends_at: endsAt\?\.toISOString\(\) \?\? null/);
  assert.match(actions, /Extend its end date before activating it/);
  assert.match(
    actions,
    /const syncedWindowIds = await adminDrizzle\.transaction\(async \(tx\) => \{[\s\S]*?FOR UPDATE[\s\S]*?update\(creator_reward_programs\)[\s\S]*?update\(creator_reward_program_windows\)[\s\S]*?eq\(creator_reward_program_windows\.ended_at, priorEndsAt\)/,
    "an end-date edit must atomically move the matching scheduled accrual-window boundary",
  );
  assert.match(actions, /synced_accrual_window_ids:/);

  const compute = read("src/lib/creator-vip/compute.ts");
  assert.match(compute, /blockedReason: "This program has ended\."/);
  assert.match(compute, /isNull\(creator_reward_programs\.ends_at\)/);
  assert.match(compute, /gt\(creator_reward_programs\.ends_at/);

  const form = read(
    "src/app/(creator-hub)/creator-hub/rewards/_components/program-form-dialog.tsx",
  );
  assert.match(form, /type="datetime-local"/);
  assert.match(form, /Start is fixed to creation time/);
});
