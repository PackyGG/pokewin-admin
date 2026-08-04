import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const readSource = (relativePath: string) =>
  readFileSync(path.join(root, relativePath), "utf8");

test("login page offers a passkey ceremony before email and password", () => {
  const form = readSource("src/app/(auth)/login/login-form.tsx");

  assert.match(form, /startPasswordlessPasskeyLogin/);
  assert.match(form, /verifyPasswordlessPasskeyLogin/);
  assert.match(form, /Sign in with a passkey/);
  assert.match(form, /or use email and password/);
});

test("passwordless passkeys are discoverable and require user verification", () => {
  const webauthn = readSource("src/lib/webauthn.ts");

  assert.match(
    webauthn,
    /residentKey: "required"[\s\S]*userVerification: "required"/,
  );
  assert.match(
    webauthn,
    /buildDiscoverableAuthenticationOptions[\s\S]*userVerification: "required"/,
  );
  assert.match(
    webauthn,
    /checkDiscoverableAuthentication[\s\S]*requireUserVerification: true/,
  );
});

test("direct passkey login resolves the credential server-side and keeps session auditing", () => {
  const actions = readSource("src/app/(auth)/login/actions.ts");
  const session = readSource("src/lib/session.ts");

  assert.match(actions, /type: "login"/);
  assert.match(actions, /INNER JOIN admin_users u ON u\.id = p\.admin_user_id/);
  assert.match(actions, /WHERE p\.credential_id = \$\{response\.id\}/);
  assert.match(actions, /if \(!stored\.is_active\)/);
  assert.match(actions, /checkDiscoverableAuthentication/);
  assert.match(actions, /createSession\(/);
  assert.match(actions, /eventType: "admin_login"/);
  assert.match(actions, /auth_method, expires_at/);
  assert.match(actions, /deleteWebauthnChallenge\(\)/);
  assert.match(session, /type: "login"/);
  assert.match(session, /type: "register" \| "auth" \| "stepup"/);
});
