import assert from "node:assert/strict";
import test from "node:test";

import { ADMIN_PAGES } from "../../src/lib/admin-pages";
import {
  NAV_ENTRIES,
  getSidebarGroups,
} from "../../src/lib/nav-config";

test("Keno appears once under Content immediately after Upgrader", () => {
  const kenoEntries = NAV_ENTRIES.filter((entry) => entry.id === "nav.keno");
  assert.equal(kenoEntries.length, 1);

  const keno = kenoEntries[0];
  assert.equal(keno.group, "Content");
  assert.equal(keno.href, "/keno");
  assert.equal(keno.pageKey, "/keno");
  assert.equal(keno.inSidebar, true);

  const content = getSidebarGroups().find((group) => group.label === "Content");
  assert.ok(content);

  const upgraderIndex = content.items.findIndex(
    (entry) => entry.id === "nav.upgrader",
  );
  assert.notEqual(upgraderIndex, -1);
  assert.equal(content.items[upgraderIndex + 1]?.id, "nav.keno");

  const overview = getSidebarGroups().find(
    (group) => group.label === "Overview",
  );
  assert.ok(overview);
  assert.equal(
    overview.items.some((entry) => entry.id === "nav.keno"),
    false,
  );

  const permission = ADMIN_PAGES.filter((page) => page.key === "/keno");
  assert.deepEqual(permission, [
    { group: "Content", label: "Keno", key: "/keno" },
  ]);
});
