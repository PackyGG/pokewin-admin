import assert from "node:assert/strict";
import test from "node:test";

import { EOS_TEST_USERNAMES } from "../../src/lib/eos-test-access-shared";
import { getPaletteNavEntries, getSidebarGroups } from "../../src/lib/nav-config";

test("EOS navigation and route access share the exact private allowlist", () => {
  assert.deepEqual(EOS_TEST_USERNAMES, ["motha", "hifoen"]);

  const system = getSidebarGroups().find((group) => group.label === "System");
  const eos = system?.items.find((entry) => entry.href === "/eos");

  assert.ok(eos);
  assert.deepEqual(eos.usernameAllowlist, EOS_TEST_USERNAMES);
  assert.equal(eos.strictUsernameAllowlist, true);
  assert.equal(eos.inPalette, false);
  assert.equal(
    getPaletteNavEntries().some((entry) => entry.href === "/eos"),
    false,
  );
});
