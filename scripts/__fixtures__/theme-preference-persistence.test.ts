import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { saveThemePreference } from "../../src/lib/theme-preference-client";

test("theme preference uses a deployment-stable authenticated endpoint", async () => {
  let request: { input: RequestInfo | URL; init?: RequestInit } | undefined;
  await saveThemePreference("grailed-light", async (input, init) => {
    request = { input, init };
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });

  assert.equal(request?.input, "/api/profile/preferences/theme");
  assert.equal(request?.init?.method, "PATCH");
  assert.equal(request?.init?.credentials, "same-origin");
  assert.deepEqual(JSON.parse(String(request?.init?.body)), {
    theme: "grailed-light",
  });
});

test("theme UI does not revert a valid local choice when account sync fails", () => {
  for (const path of [
    "src/components/theme-toggle.tsx",
    "src/components/admin-header.tsx",
  ]) {
    const source = readFileSync(path, "utf8");
    assert.match(source, /setTheme\(next\);[\s\S]*saveThemePreference\(next\)/);
    assert.doesNotMatch(source, /catch[\s\S]{0,160}setTheme\(/);
    assert.doesNotMatch(source, /updatePreferences\(\{ theme: next \}\)/);
  }
});

test("theme endpoint validates origin, session, and theme before writing", () => {
  const source = readFileSync(
    "src/app/api/profile/preferences/theme/route.ts",
    "utf8",
  );
  assert.match(source, /origin !== null && origin !== requestUrl\.origin/);
  assert.match(source, /await verifySession\(\)/);
  assert.match(source, /ThemePreferenceSchema\.safeParse\(input\)/);
  assert.match(source, /await setAdminPreferences\(session\.userId, \{ theme \}\)/);
  assert.match(source, /eventType: "admin_preferences_updated"/);
});
