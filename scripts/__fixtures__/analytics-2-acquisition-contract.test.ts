import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { getSidebarGroups } from "../../src/lib/nav-config";

const pageSource = readFileSync(
  new URL("../../src/app/(admin)/analytics-2/page.tsx", import.meta.url),
  "utf8",
);
const querySource = readFileSync(
  new URL("../../src/lib/queries/analytics-2.ts", import.meta.url),
  "utf8",
);

test("Analytics 2 sits directly below Analytics and inherits its grant", () => {
  const overview = getSidebarGroups().find(
    (group) => group.label === "Overview",
  );
  assert.ok(overview);

  const analyticsIndex = overview.items.findIndex(
    (entry) => entry.id === "nav.analytics",
  );
  assert.notEqual(analyticsIndex, -1);

  const analytics2 = overview.items[analyticsIndex + 1];
  assert.equal(analytics2?.id, "nav.analytics-2");
  assert.equal(analytics2?.href, "/analytics-2");
  assert.equal(analytics2?.pageKey, "/analytics");
  assert.equal(analytics2?.isNew, true);
  assert.match(pageSource, /requirePageAccess\("\/analytics"\)/);
});

test("acquisition series keeps FTDs separate from existing depositors", () => {
  assert.match(
    querySource,
    /first_deposit_day = day\)::text AS ftds/,
  );
  assert.match(
    querySource,
    /first_deposit_day < day\)::text\s+AS existing_depositors/,
  );
  assert.match(querySource, /getMetricsScope\(\)/);
  assert.match(querySource, /c\.is_locked = false/);
  assert.match(querySource, /revalidate: 300/);
});
