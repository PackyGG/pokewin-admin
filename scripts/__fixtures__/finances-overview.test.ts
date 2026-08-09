import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  FINANCE_PERIODS,
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
});
