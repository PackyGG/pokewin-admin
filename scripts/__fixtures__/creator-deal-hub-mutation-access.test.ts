import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  "src/app/(admin)/creators/backend-actions.ts",
  "utf8",
);

function actionBlock(name: string, nextName: string): string {
  const start = source.indexOf(`export async function ${name}(`);
  const end = source.indexOf(`export async function ${nextName}(`, start + 1);
  assert.ok(start >= 0, `${name} action not found`);
  assert.ok(end > start, `${nextName} action not found after ${name}`);
  return source.slice(start, end);
}

test("Creator Hub deal mutations accept hub access and retain capability gates", () => {
  const create = actionBlock("createCreatorDeal", "updateCreatorDeal");
  const update = actionBlock("updateCreatorDeal", "terminateCreatorDeal");
  const terminate = actionBlock("terminateCreatorDeal", "forceEndCreatorSession");

  for (const block of [create, update, terminate]) {
    assert.match(block, /requireCreatorsPageOrHubAccess\(\)/);
    assert.doesNotMatch(block, /requirePageAccess\("\/creators"\)/);
  }
  assert.match(create, /__can_create_creator_deal/);
  assert.match(update, /__can_update_creator_deal/);
  assert.match(terminate, /__can_delete_creator_deal/);
});

test("active edits omit unchanged locked windows and schedule termination covers later periods", () => {
  const dialog = readFileSync(
    "src/app/(creator-hub)/creator-hub/creators/[id]/_components/edit-deal-dialog.tsx",
    "utf8",
  );
  assert.match(dialog, /Object\.entries\(candidate\)\.filter/);
  assert.match(dialog, /Date\.parse\(String\(value\)\) !== Date\.parse\(String\(previous\)\)/);
  assert.match(dialog, /No changes to save/);

  const schedule = actionBlock(
    "terminateCreatorDealSchedule",
    "forceEndCreatorSession",
  );
  assert.match(schedule, /getCreatorApprovalDealMarker\(selected\)/);
  assert.match(schedule, /marker\.periodIndex >= selectedMarker\.periodIndex/);
  assert.match(schedule, /creator_deal_schedule_termination_partial/);
  assert.match(schedule, /creator_deal_schedule_terminated/);
});
