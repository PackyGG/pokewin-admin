import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const actions = readFileSync(
  path.join(root, "src/app/(admin)/users/[id]/actions.ts"),
  "utf8",
);
const panel = readFileSync(
  path.join(root, "src/app/(admin)/users/[id]/joined-battles-panel.tsx"),
  "utf8",
);
const joinedBattlesAction = actions.slice(
  actions.indexOf("export async function getUserJoinedSponsoredBattles"),
  actions.indexOf("export type InventorySaleBatch"),
);

test("sponsored battle joins expose the creator through the MAIN read mirror", () => {
  assert.match(joinedBattlesAction, /const db = await getReadDrizzleDb\(\);/);
  assert.doesNotMatch(joinedBattlesAction, /getPrimaryDrizzleDb/);
  assert.match(
    joinedBattlesAction,
    /b\.user_id AS creator_user_id[\s\S]*LEFT JOIN "user" creator ON creator\.id = b\.user_id/,
  );
  assert.match(joinedBattlesAction, /creatorUserId: r\.creator_user_id/);
  assert.match(joinedBattlesAction, /creatorUsername: r\.creator_username/);
});

test("sponsored battle rows link to the creator profile", () => {
  assert.match(panel, /Created by/);
  assert.match(panel, /href=\{`\/users\/\$\{b\.creatorUserId\}`\}/);
  assert.match(panel, /b\.creatorUsername \?\? b\.creatorUserId/);
});
