import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { getSidebarGroups } from "../../src/lib/nav-config";

const pageSource = readFileSync(
  new URL("../../src/app/(admin)/analytics/page.tsx", import.meta.url),
  "utf8",
);
const querySource = readFileSync(
  new URL("../../src/lib/queries/analytics-acquisition.ts", import.meta.url),
  "utf8",
);
const configSource = readFileSync(
  new URL("../../next.config.ts", import.meta.url),
  "utf8",
);

test("acquisition lives on /analytics and analytics-2 is retired", () => {
  const overview = getSidebarGroups().find(
    (group) => group.label === "Overview",
  );
  assert.ok(overview);

  const analytics = overview.items.find(
    (entry) => entry.id === "nav.analytics",
  );
  assert.equal(analytics?.href, "/analytics");
  assert.equal(analytics?.pageKey, "/analytics");

  // The 2026-08 redesign folded /analytics-2 into /analytics — the nav entry
  // must stay gone everywhere, and the old route must 308 to /analytics.
  const analytics2 = getSidebarGroups()
    .flatMap((group) => group.items)
    .find((entry) => entry.id === "nav.analytics-2");
  assert.equal(analytics2, undefined);

  assert.match(pageSource, /requirePageAccess\("\/analytics"\)/);
  assert.match(
    configSource,
    /source: "\/analytics-2",\s*destination: "\/analytics",\s*permanent: true/,
  );
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
