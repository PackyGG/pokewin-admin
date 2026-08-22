export type FinanceProfitTimelinePoint = {
  date: string;
  cashPnl: number;
  salaryCost: number;
  subscriptionCost: number;
  oneTimeCost: number;
  operatingCosts: number;
  netProfit: number;
  cumulativeProfit: number;
};

const DAY_MS = 24 * 60 * 60 * 1_000;

function utcDayStart(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

/**
 * Builds a zero-filled daily series whose operating-cost buckets reconcile
 * exactly with the selected period. Monthly commitments are accrued by the
 * fraction of each UTC day that overlaps the period; dated expenses land on
 * their recorded day.
 */
export function buildFinanceProfitTimeline({
  since,
  through,
  dailyPnl,
  monthlySalary,
  monthlySubscriptions,
  oneTimeByDate,
}: {
  since: Date;
  through: Date;
  dailyPnl: Array<{ date: string; pnl: number }>;
  monthlySalary: number;
  monthlySubscriptions: number;
  oneTimeByDate: Array<{ date: string; amount: number }>;
}): FinanceProfitTimelinePoint[] {
  if (through <= since) return [];

  const pnlByDate = new Map(dailyPnl.map((point) => [point.date, point.pnl]));
  const expensesByDate = new Map(
    oneTimeByDate.map((point) => [point.date, point.amount]),
  );
  const points: FinanceProfitTimelinePoint[] = [];
  let cumulativeProfit = 0;

  for (
    let day = utcDayStart(since);
    day <= utcDayStart(through);
    day = new Date(day.getTime() + DAY_MS)
  ) {
    const nextDay = new Date(day.getTime() + DAY_MS);
    const overlapMs = Math.max(
      0,
      Math.min(through.getTime(), nextDay.getTime()) -
        Math.max(since.getTime(), day.getTime()),
    );
    const monthFraction = overlapMs / (30 * DAY_MS);
    const date = day.toISOString().slice(0, 10);
    const cashPnl = pnlByDate.get(date) ?? 0;
    const salaryCost = monthlySalary * monthFraction;
    const subscriptionCost = monthlySubscriptions * monthFraction;
    const oneTimeCost = expensesByDate.get(date) ?? 0;
    const operatingCosts = salaryCost + subscriptionCost + oneTimeCost;
    const netProfit = cashPnl - operatingCosts;
    cumulativeProfit += netProfit;

    points.push({
      date,
      cashPnl,
      salaryCost,
      subscriptionCost,
      oneTimeCost,
      operatingCosts,
      netProfit,
      cumulativeProfit,
    });
  }

  return points;
}
