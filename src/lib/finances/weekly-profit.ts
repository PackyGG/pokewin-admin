export type WeeklyProfitBreakdown = {
  cashProfit: number;
  salaryExpense: number;
  subscriptionExpense: number;
  oneTimeExpenses: number;
  netProfit: number;
};

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

  return {
    cashProfit,
    salaryExpense,
    subscriptionExpense,
    oneTimeExpenses,
    netProfit:
      cashProfit - salaryExpense - subscriptionExpense - oneTimeExpenses,
  };
}
