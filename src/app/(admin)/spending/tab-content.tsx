"use client";

import { useState } from "react";
import { ExpensesTable } from "./expenses-table";
import { RecurringTable } from "./recurring-table";
import type { ExpenseListItem, RecurringExpenseListItem } from "@/lib/queries/spending";

export function SpendingTabs({
  defaultTab,
  expensesData,
  recurringData,
}: {
  defaultTab: "expenses" | "recurring";
  expensesData: ExpenseListItem[];
  recurringData: RecurringExpenseListItem[];
}) {
  const [tab, setTab] = useState(defaultTab);

  return (
    <div>
      <div className="inline-flex h-9 items-center rounded-lg bg-muted p-1 text-muted-foreground">
        <button
          onClick={() => setTab("expenses")}
          className={`inline-flex items-center justify-center rounded-md px-3 py-1 text-sm font-medium transition-colors ${
            tab === "expenses"
              ? "bg-background text-foreground shadow-sm"
              : "hover:text-foreground"
          }`}
        >
          Expenses
        </button>
        <button
          onClick={() => setTab("recurring")}
          className={`inline-flex items-center justify-center rounded-md px-3 py-1 text-sm font-medium transition-colors ${
            tab === "recurring"
              ? "bg-background text-foreground shadow-sm"
              : "hover:text-foreground"
          }`}
        >
          Recurring
        </button>
      </div>

      <div className="pt-4">
        {tab === "expenses" && <ExpensesTable data={expensesData} />}
        {tab === "recurring" && (
          <>
            <p className="text-sm text-muted-foreground pb-4">
              Monthly subscriptions and recurring costs. Add rows below, edit inline.
            </p>
            <RecurringTable data={recurringData} />
          </>
        )}
      </div>
    </div>
  );
}
