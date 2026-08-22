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
import { buildFinanceProfitTimeline } from "@/lib/finances/profit-timeline";
import {
  calculateNetProfit,
  calculateWeeklyProfit,
} from "@/lib/finances/weekly-profit";
import { getSidebarGroups } from "@/lib/nav-config";

const read = (path: string) => readFileSync(path, "utf8");

test("Finances sits below Players and exposes its management pages", () => {
  const groups = getSidebarGroups();
  const playersIndex = groups.findIndex((group) => group.label === "Players");
  const financesIndex = groups.findIndex((group) => group.label === "Finances");
  const finances = groups[financesIndex];

  assert.equal(financesIndex, playersIndex + 1);
  assert.deepEqual(
    finances?.items.map((item) => [item.label, item.href]),
    [
      ["Overview", "/finances"],
      ["Expenses", "/finances/expenses"],
      ["Subscriptions", "/finances/subscriptions"],
      ["Salaries", "/salaries"],
    ],
  );
});

test("finance profit periods start at one week and default safely to it", () => {
  assert.deepEqual(
    FINANCE_PERIODS.map((period) => period.value),
    ["7d", "14d", "30d"],
  );
  assert.equal(parseFinancePeriod(undefined), "7d");
  assert.equal(parseFinancePeriod("unexpected"), "7d");
  assert.equal(parseFinancePeriod("24h"), "7d");
  assert.equal(parseFinancePeriod("3d"), "7d");
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
  assert.equal(financeWeekDateRange(wednesday), "Aug 3, 2026 – Aug 9, 2026");
  assert.equal(
    financePeriodSince("14d", wednesday).toISOString(),
    "2026-07-22T16:45:00.000Z",
  );
});

test("weekly P&L deducts salaries, one quarter of subscriptions, and logged expenses", () => {
  assert.deepEqual(
    calculateWeeklyProfit({
      cashProfit: 10_000,
      salaryExpense: 1_500,
      monthlySubscriptions: 800,
      oneTimeExpenses: 300,
    }),
    {
      cashProfit: 10_000,
      salaryExpense: 1_500,
      subscriptionExpense: 200,
      oneTimeExpenses: 300,
      netProfit: 8_000,
    },
  );
});

test("selected-period net P&L deducts every tracked operating cost", () => {
  assert.deepEqual(
    calculateNetProfit({
      cashProfit: 10_000,
      salaryExpense: 1_500,
      subscriptionExpense: 200,
      oneTimeExpenses: 300,
    }),
    {
      cashProfit: 10_000,
      salaryExpense: 1_500,
      subscriptionExpense: 200,
      oneTimeExpenses: 300,
      operatingCosts: 2_000,
      netProfit: 8_000,
    },
  );
});

test("profit timeline prorates partial UTC days and reconciles to net profit", () => {
  const timeline = buildFinanceProfitTimeline({
    since: new Date("2026-08-03T12:00:00.000Z"),
    through: new Date("2026-08-05T12:00:00.000Z"),
    dailyPnl: [
      { date: "2026-08-03", pnl: 100 },
      { date: "2026-08-04", pnl: 200 },
      { date: "2026-08-05", pnl: 300 },
    ],
    monthlySalary: 3_000,
    monthlySubscriptions: 300,
    oneTimeByDate: [{ date: "2026-08-04", amount: 50 }],
  });

  assert.deepEqual(
    timeline.map((point) => ({
      date: point.date,
      operatingCosts: point.operatingCosts,
      netProfit: point.netProfit,
      cumulativeProfit: point.cumulativeProfit,
    })),
    [
      {
        date: "2026-08-03",
        operatingCosts: 55,
        netProfit: 45,
        cumulativeProfit: 45,
      },
      {
        date: "2026-08-04",
        operatingCosts: 160,
        netProfit: 40,
        cumulativeProfit: 85,
      },
      {
        date: "2026-08-05",
        operatingCosts: 55,
        netProfit: 245,
        cumulativeProfit: 330,
      },
    ],
  );
});

test("finance overview is owner-gated and reuses canonical profit math", () => {
  const page = read("src/app/(admin)/finances/page.tsx");
  const query = read("src/lib/queries/finances-overview.ts");

  assert.match(page, /await requireMotha\(\)/);
  assert.match(query, /calculateWindowedPnlOneShot/);
  assert.match(query, /eq\(salary_employees\.active, true\)/);
  assert.match(page, /getSalaryExpenseSummary\(period, now\)/);
  assert.match(page, /salaryExpense: salary\.periodExpense/);
  assert.match(query, /monthly \* \(hours \/ \(30 \* 24\)\)/);
  assert.match(page, /Net result/);
  assert.match(page, /Cash P&amp;L − operating costs = net result/);
  assert.match(page, /Net profit/);
  assert.match(page, /Recurring costs are/);
  assert.match(query, /financePeriodSince\(period, now\)/);
  assert.match(page, /getOperatingExpenseSummary\(period, now\)/);
  assert.match(page, /getFinanceDailyPnl\(period, now\)/);
  assert.match(page, /getFinanceGamingSummary\(period, now\)/);
  assert.match(
    page,
    /monthlySubscriptions: operatingExpenses\.monthlySubscriptions/,
  );
  assert.match(page, /oneTimeExpenses: operatingExpenses\.oneTimeExpenses/);
  assert.match(page, /Profit timeline/);
  assert.match(page, /Revenue-to-profit bridge/);
  assert.match(page, /Wager is activity volume and GGR is gaming margin/);
  assert.match(query, /\.from\(recurring_expenses\)/);
  assert.match(query, /recurring_expenses\.is_active/);
  assert.match(query, /lte\(expenses\.date, throughDate\)/);
  assert.match(query, /\.from\(expenses\)/);
  assert.doesNotMatch(page, /Actual expenses/);
  assert.doesNotMatch(query, /getRewardCost|getCreatorCostsSince/);
});
