import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string): string => readFileSync(path, "utf8");

const usersActions = read("src/app/(admin)/users/actions.ts");
const moderation = read(
  "src/app/(admin)/users/[id]/user-tabs-moderation.tsx",
);
const identifierBlocking = read(
  "src/lib/antifraud/user-identifier-blocking.ts",
);
const reviewsActions = read(
  "src/app/(antifraud)/antifraud/reviews/actions.ts",
);
const bannedUsersActions = read(
  "src/app/(antifraud)/antifraud/banned-users/actions.ts",
);

test("single-user bans block every known IP and fingerprint before the account write", () => {
  assert.match(identifierBlocking, /SELECT 'ip'::text[\s\S]*u\.signup_ip/);
  assert.match(identifierBlocking, /host\(f\.ip\)/);
  assert.match(identifierBlocking, /SELECT 'fingerprint'::text[\s\S]*f\.visitor_id/);
  assert.match(
    usersActions,
    /blockKnownUserIdentifiers\([\s\S]*await db\.transaction/,
  );
  assert.match(usersActions, /account was not banned/);
});

test("all staff single-account ban surfaces share the identifier invariant", () => {
  assert.match(reviewsActions, /blockKnownUserIdentifiers\(/);
  assert.match(bannedUsersActions, /blockKnownUserIdentifiers\(/);
});

test("user detail top bar exposes separate confirmed IP and fingerprint actions", () => {
  assert.match(moderation, /kind="ip"/);
  assert.match(moderation, /kind="fingerprint"/);
  assert.match(moderation, /Ban IP/);
  assert.match(moderation, /Ban fingerprint/);
  assert.match(moderation, /confirmed: true/);
  assert.match(usersActions, /requireCapability\(session, "__can_ban_users"/);
  assert.match(usersActions, /antifraud_user_identifiers_blocklisted/);
});

test("identifier blocking reactivates expired or disabled rules and never silently ignores service failure", () => {
  assert.match(identifierBlocking, /!rule\.enabled \|\| rule\.expiresAt !== null/);
  assert.match(identifierBlocking, /enabled: true/);
  assert.match(identifierBlocking, /expiresAt: null/);
  assert.match(identifierBlocking, /initial\.error/);
  assert.match(identifierBlocking, /existing\?\.effect === "known_vpn"/);
});
