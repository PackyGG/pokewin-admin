import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

test("battle outcome testing is limited to the exact internal dev allowlist", () => {
  const access = read("src/lib/testing-battle-outcome-access.ts");
  assert.match(access, /"hifoen"/);
  assert.match(access, /"motha"/);
  assert.match(access, /"zog"/);
  assert.doesNotMatch(access, /isOwner|sessionIsAdmin|role/);

  const action = read(
    "src/app/(admin)/users/[id]/testing-battle-outcome-actions.ts",
  );
  assert.match(action, /activeEnv !== "dev"/);
  assert.match(action, /backendConfig\?\.env !== "dev"/);
  assert.match(action, /canManageTestingBattleOutcomes\(session\.username\)/);

  const page = read("src/app/(admin)/users/[id]/page.tsx");
  assert.match(page, /activeDbEnv === "dev"/);
  assert.match(page, /backendConfig\?\.env === "dev"/);
  assert.match(page, /canManageTestingBattleOutcomes\(session\.username\)/);
});
