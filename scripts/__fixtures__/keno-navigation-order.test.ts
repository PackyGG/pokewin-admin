import assert from "node:assert/strict";
import test from "node:test";

import { readFileSync } from "node:fs";

import { ADMIN_PAGES } from "../../src/lib/admin-pages";
import {
  NAV_ENTRIES,
  getSidebarGroups,
} from "../../src/lib/nav-config";

const repoRoot = process.cwd();
const source = (path: string) => readFileSync(`${repoRoot}/${path}`, "utf8");

test("Keno lives inside Analytics Games and has no standalone navigation", () => {
  const kenoEntries = NAV_ENTRIES.filter((entry) => entry.id === "nav.keno");
  assert.equal(kenoEntries.length, 0);

  const content = getSidebarGroups().find((group) => group.label === "Content");
  assert.ok(content);
  assert.equal(
    content.items.some((entry) => entry.id === "nav.keno"),
    false,
  );

  const permission = ADMIN_PAGES.filter((page) => page.key === "/keno");
  assert.deepEqual(permission, []);

  const games = source("src/app/(admin)/analytics/tab-games.tsx");
  const analytics = source("src/app/(admin)/analytics/page.tsx");
  const legacyRoute = source("src/app/(admin)/keno/page.tsx");
  assert.match(games, /"keno",/);
  assert.match(games, /<KenoOverviewTab \/>/);
  assert.match(games, /<KenoConfigurationTab canEdit=\{canEdit\} \/>/);
  assert.match(games, /<KenoOddsTab \/>/);
  assert.match(analytics, /parseKenoTab\(params\.kenoTab\)/);
  assert.match(
    legacyRoute,
    /redirect\(`\/analytics\?tab=games&g=keno&kenoTab=\$\{tab\}`\)/,
  );
});
