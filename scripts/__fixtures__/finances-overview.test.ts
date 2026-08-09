import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  FINANCE_PERIODS,
  financePeriodSince,
  financeWeekBounds,
  financeWeekDateRange,
  parseFinancePeriod,
} from "@/lib/finances/periods";
import { getSidebarGroups } from "@/lib/nav-config";

const read = (path: string) => readFileSync(path, "utf8");

test("Finances sits below Players and contains Overview before Salaries", () => {
  const groups = getSidebarGroups();
  const playersIndex = groups.findIndex((group) => group.label === "Players");
  const financesIndex = groups.findIndex((group) => group.label === "Finances");
  const finances = groups[financesIndex];

  assert.equal(financesIndex, playersIndex + 1);
  assert.deepEqual(
    finances?.items.map((item) => [item.label, item.href]),
    [
      ["Overview", "/finances"],
      ["Salaries", "/salaries"],
    ],
  );
});

test("finance profit periods are closed and default safely to 24h", () => {
  assert.deepEqual(
    FINANCE_PERIODS.map((period) => period.value),
    ["24h", "3d", "7d", "14d", "30d"],
  );
  assert.equal(parseFinancePeriod(undefined), "24h");
  assert.equal(parseFinancePeriod("unexpected"), "24h");
  assert.equal(parseFinancePeriod("14d"), "14d");
  assert.equal(
    FINANCE_PERIODS.find((period) => period.value === "7d")?.label,
    "Week",
  );
});

test("the 7d finance period is the current Monday-Sunday UTC week", () => {
  const wednesday = new Date("2026-08-05T16:45:00.000Z");
  const sunday = new Date("2026-08-09T23:59:59.000Z");

  assert.equal(
    financePeriodSince("7d", wednesday).toISOString(),
    "2026-08-03T00:00:00.000Z",
  );
  assert.deepEqual(
    Object.values(financeWeekBounds(sunday)).map((date) => date.toISOString()),
    ["2026-08-03T00:00:00.000Z", "2026-08-10T00:00:00.000Z"],
  );
  assert.equal(
    financeWeekDateRange(wednesday),
    "Aug 3, 2026 – Aug 9, 2026",
  );
  assert.equal(
    financePeriodSince("14d", wednesday).toISOString(),
    "2026-07-22T16:45:00.000Z",
  );
});

test("finance overview is owner-gated and reuses canonical profit math", () => {
  const page = read("src/app/(admin)/finances/page.tsx");
  const query = read("src/lib/queries/finances-overview.ts");

  assert.match(page, /await requireMotha\(\)/);
  assert.match(query, /calculateWindowedPnlOneShot/);
  assert.match(query, /eq\(salary_employees\.active, true\)/);
  assert.match(page, /getSalaryExpenseSummary\(period\)/);
  assert.match(page, /value=\{salaries\.periodExpense\}/);
  assert.match(query, /monthly \* \(hours \/ \(30 \* 24\)\)/);
  assert.match(page, /Weekly P&amp;L/);
  assert.match(page, /Current Monday–Sunday accounting week/);
  assert.match(query, /financePeriodSince\(period, now\)/);
  assert.match(page, /getActualExpenseSummary\(period, now\)/);
  assert.match(page, /expenses\.rewardsAndAffiliatePrizes/);
  assert.match(page, /expenses\.creatorPrograms/);
  assert.match(query, /getRewardCost\(\{ since \}\)/);
  assert.match(query, /getCreatorCostsSince\(since\)/);
});
