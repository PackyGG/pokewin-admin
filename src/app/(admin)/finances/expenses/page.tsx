import { Receipt } from "lucide-react";

import { SectionHeading } from "@/components/modern-panels";
import { getExpensePageData } from "@/lib/queries/finance-costs";
import { requireMotha } from "@/lib/salary/motha-gate";

import { ExpensesClient } from "./expenses-client";

export const metadata = { title: "Expenses · Finances" };

export default async function ExpensesPage() {
  await requireMotha();
  const data = await getExpensePageData();

  return (
    <div className="space-y-6">
      <SectionHeading icon={Receipt} title="One-time expenses" />
      <p className="-mt-4 text-sm text-muted-foreground">
        Track completed operational payments. These entries are included in the
        Finances overview.
      </p>
      <ExpensesClient data={data} />
    </div>
  );
}
