import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ADMIN_PASSWORD_BCRYPT_COST,
  ADMIN_PASSWORD_MAX_BYTES,
  ADMIN_PASSWORD_MIN_LENGTH,
  adminPasswordSchema,
} from "../../src/lib/admin-password-policy";

test("admin passwords use the shared minimum and bcrypt cost", () => {
  assert.equal(ADMIN_PASSWORD_MIN_LENGTH, 10);
  assert.equal(ADMIN_PASSWORD_BCRYPT_COST, 12);
  assert.equal(adminPasswordSchema.safeParse("short").success, false);
  assert.equal(adminPasswordSchema.safeParse("long-enough").success, true);
});

test("admin passwords reject bcrypt-truncated UTF-8 input", () => {
  assert.equal(ADMIN_PASSWORD_MAX_BYTES, 72);
  assert.equal(adminPasswordSchema.safeParse("a".repeat(72)).success, true);
  assert.equal(adminPasswordSchema.safeParse("a".repeat(73)).success, false);
  assert.equal(adminPasswordSchema.safeParse("🔐".repeat(18)).success, true);
  assert.equal(adminPasswordSchema.safeParse("🔐".repeat(19)).success, false);
});

test("staff password resets are step-up gated, audited, and revoke sessions", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const source = readFileSync(
    path.join(root, "src/app/(admin)/admin-users/[id]/actions.ts"),
    "utf8",
  );
  const start = source.indexOf("export async function resetAdminPassword");
  const end = source.indexOf(
    "export async function forceExpireAllSessions",
    start,
  );
  const resetAction = source.slice(start, end);

  assert.match(resetAction, /__can_reset_admin_password/);
  assert.match(resetAction, /require2FA\(session\.userId/);
  assert.match(resetAction, /ADMIN_PASSWORD_BCRYPT_COST/);
  assert.match(resetAction, /SET password_hash = \$\{passwordHash\}/);
  assert.match(resetAction, /sessions_valid_after = \$\{now\}/);
  assert.match(resetAction, /UPDATE admin_sessions[\s\S]*logged_out_at = \$\{now\}/);
  assert.match(resetAction, /eventType: "admin_password_reset"/);
  assert.doesNotMatch(
    resetAction.slice(resetAction.indexOf("metadata:")),
    /newPassword|confirmPassword|passwordHash|stepUpCredential/,
  );
});
