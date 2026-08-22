export type WeeklyProfitBreakdown = {
  cashProfit: number;
  salaryExpense: number;
  subscriptionExpense: number;
  oneTimeExpenses: number;
  netProfit: number;
};

export type NetProfitBreakdown = WeeklyProfitBreakdown & {
  operatingCosts: number;
};

/** Selected-period net result after every tracked operating cost. */
export function calculateNetProfit({
  cashProfit,
  salaryExpense,
  subscriptionExpense,
  oneTimeExpenses,
}: Omit<
  NetProfitBreakdown,
  "operatingCosts" | "netProfit"
>): NetProfitBreakdown {
  const operatingCosts = salaryExpense + subscriptionExpense + oneTimeExpenses;
  return {
    cashProfit,
    salaryExpense,
    subscriptionExpense,
    oneTimeExpenses,
    operatingCosts,
    netProfit: cashProfit - operatingCosts,
  };
}

export function calculateWeeklyProfit({
  cashProfit,
  salaryExpense,
  monthlySubscriptions,
  oneTimeExpenses,
}: {
  cashProfit: number;
  salaryExpense: number;
  monthlySubscriptions: number;
  oneTimeExpenses: number;
}): WeeklyProfitBreakdown {
  const subscriptionExpense = monthlySubscriptions / 4;
  const result = calculateNetProfit({
    cashProfit,
    salaryExpense,
    subscriptionExpense,
    oneTimeExpenses,
  });
  return {
    cashProfit: result.cashProfit,
    salaryExpense: result.salaryExpense,
    subscriptionExpense: result.subscriptionExpense,
    oneTimeExpenses: result.oneTimeExpenses,
    netProfit: result.netProfit,
  };
}
