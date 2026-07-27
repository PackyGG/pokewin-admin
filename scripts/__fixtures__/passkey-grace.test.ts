import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  PASSKEY_GRACE_CREDENTIAL,
  PASSKEY_GRACE_TTL_MS,
} from "../../src/lib/passkey-grace-shared";
import { MS_PER_MINUTE } from "../../src/lib/utils/time";

const root = fileURLToPath(new URL("../../", import.meta.url));
const readSource = (relativePath: string) =>
  readFileSync(path.join(root, relativePath), "utf8");

test("passkey grace is exactly ten minutes and uses an internal marker", () => {
  assert.equal(PASSKEY_GRACE_TTL_MS, 10 * MS_PER_MINUTE);
  assert.equal(PASSKEY_GRACE_CREDENTIAL, "__admin_passkey_grace__");
});

test("passkey grace is signed, HttpOnly, user-bound, and cleared on logout", () => {
  const session = readSource("src/lib/session.ts");
  const logout = readSource("src/lib/actions/auth.ts");

  assert.match(session, /PASSKEY_GRACE_COOKIE = "admin_passkey_grace"/);
  assert.match(session, /encryptGeneric\([\s\S]*"10m"/);
  assert.match(session, /cookieStore\.set\(PASSKEY_GRACE_COOKIE[\s\S]*httpOnly: true/);
  assert.match(session, /payload\.adminUserId !== adminUserId/);
  assert.match(logout, /deletePasskeyGrace\(\)/);
});

test("grace is minted and consumed only after current admin or owner checks", () => {
  const actions = readSource("src/lib/passkey-step-up-actions.ts");
  const gate = readSource("src/lib/require-2fa.ts");

  assert.match(
    actions,
    /sessionIsAdmin\(session\) \|\| sessionIsOwner\(session\)[\s\S]*createPasskeyGrace/,
  );
  assert.match(gate, /value === PASSKEY_GRACE_CREDENTIAL/);
  assert.match(gate, /is_active = true/);
  assert.match(gate, /canUsePasskeyGrace/);
  assert.match(gate, /getPasskeyGrace\(adminUserId\)/);
  assert.match(gate, /verifyTOTPWithStep/);
  assert.match(gate, /totp_last_step/);
});

test("shared step-up UI suppresses prompts during grace and shows expiry", () => {
  const field = readSource("src/components/step-up-field.tsx");

  assert.match(field, /getMyPasskeyStepUpState/);
  assert.match(field, /onChangeRef\.current\(PASSKEY_GRACE_CREDENTIAL\)/);
  assert.match(field, /remaining/);
  assert.match(field, /Use a code for this action/);
});
