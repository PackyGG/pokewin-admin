import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const ROOT = new URL("../../", import.meta.url);

async function source(path: string): Promise<string> {
  return readFile(new URL(path, ROOT), "utf8");
}

test("fingerprint indicators open the shared linked-account dialog", async () => {
  const [list, detail, dialog] = await Promise.all([
    source("src/app/(admin)/users/columns.tsx"),
    source("src/app/(admin)/users/[id]/user-view-modern.tsx"),
    source("src/app/(admin)/users/fingerprint-alt-dialog.tsx"),
  ]);

  assert.match(list, /<FingerprintAltDialog/);
  assert.match(detail, /<FingerprintAltDialog/);
  assert.match(dialog, /account\.image/);
  assert.match(dialog, /account\.username/);
  assert.match(dialog, /account\.email/);
  assert.match(dialog, /account\.totalDeposited/);
  assert.match(dialog, /account\.totalWagered/);
  assert.match(dialog, /Ban selected/);
  assert.match(dialog, /Ban all/);
  assert.match(dialog, /confirm !== "BAN"/);
});

test("fingerprint alt lookup and bans are live-validated and protected", async () => {
  const [query, actions] = await Promise.all([
    source("src/lib/queries/user-fingerprint-alts.ts"),
    source("src/app/(admin)/users/actions.ts"),
  ]);

  assert.match(query, /f\.user_id <> \$1/);
  assert.match(query, /f\.visitor_id IN \(SELECT visitor_id FROM source_devices\)/);
  assert.match(query, /calculateUsersPnlBatch/);
  assert.match(query, /getCreatorProtectedUserIds/);
  assert.match(query, /getExcludedUserIds/);
  assert.match(query, /protectedRoles/);

  assert.match(actions, /requirePageAccess\("\/users"\)/);
  assert.match(actions, /isBulkBanAuthorized\(session\)/);
  assert.match(actions, /getFingerprintAltAccounts\(parsed\.data\.sourceUserId\)/);
  assert.match(actions, /!liveById\.get\(id\)\?\.canBan/);
  assert.match(actions, /await banUser\(/);
});
