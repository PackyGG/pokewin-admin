import { Suspense } from "react";
import { CalendarDays, Receipt, Users } from "lucide-react";
import { desc, eq, sql } from "drizzle-orm";
import { adminDrizzle } from "@/lib/admin-db";
import { salary_employees, salary_payments } from "@/lib/db-schema/admin/schema";
import { requireMotha } from "@/lib/salary/motha-gate";
import { addressKind } from "@/lib/salary/wallet";
import { toNumber } from "@/lib/utils/decimal";
import { PageHero, PageHeroIdentity, KpiTile } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import {
  KpiStripSkeleton,
  SectionHeadingSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";
import { safeQuery } from "@/lib/errors/safe-query";
import { SalariesClient } from "./salaries-client";

export const metadata = { title: "Employee Salaries" };

/** Hard ceiling on the employee register + budget scan. The real table is a
 *  handful of rows; this only stops an unbounded read reaching the page. */
const MAX_EMPLOYEE_ROWS = 500;

export default async function SalariesPage() {
  await requireMotha();

  // Shell-first: the hero paints immediately and the three admin-DB reads
  // stream behind one boundary whose fallback matches this route's
  // loading.tsx (hero → 3 KPI tiles → register heading + table).
  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity />
      </PageHero>

      <Suspense
        fallback={
          <>
            <KpiStripSkeleton count={3} />
            <div className="space-y-3">
              <SectionHeadingSkeleton action titleWidth={120} />
              <TableSkeleton rows={6} columns={6} />
            </div>
          </>
        }
      >
        <SalariesBody />
      </Suspense>
    </div>
  );
}

async function SalariesBody() {
  // Each leg is safeQuery-wrapped with an empty/zero fallback so one failing
  // admin-DB read degrades its own section instead of white-screening the
  // route. The employee register and the budget scan are also explicitly
  // bounded (they were unbounded before).
  const [employeesResult, paymentsResult, budgetResult] = await Promise.all([
    safeQuery(
      () =>
        adminDrizzle.select().from(salary_employees)
          .orderBy(salary_employees.discord_name)
          .limit(MAX_EMPLOYEE_ROWS),
      [] as (typeof salary_employees.$inferSelect)[],
      "salaries.employees",
    ),
    safeQuery(
      () =>
        adminDrizzle.select({
          id: salary_payments.id, employee_id: salary_payments.employee_id,
          payment_link: salary_payments.payment_link, paid_at: salary_payments.paid_at,
          employee_discord_name: salary_employees.discord_name,
        }).from(salary_payments)
          .innerJoin(salary_employees, eq(salary_employees.id, salary_payments.employee_id))
          .orderBy(desc(salary_payments.paid_at)).limit(100),
      [] as {
        id: (typeof salary_payments.$inferSelect)["id"];
        employee_id: (typeof salary_payments.$inferSelect)["employee_id"];
        payment_link: (typeof salary_payments.$inferSelect)["payment_link"];
        paid_at: (typeof salary_payments.$inferSelect)["paid_at"];
        employee_discord_name: (typeof salary_employees.$inferSelect)["discord_name"];
      }[],
      "salaries.payments",
    ),
    safeQuery(
      () =>
        adminDrizzle
          .select({
            value: sql<string>`COALESCE(SUM(${salary_employees.salary_usdt}), 0)::text`,
            weeklyValue: sql<string>`COALESCE(SUM(${salary_employees.salary_usdt}) / 4, 0)::text`,
          })
          .from(salary_employees),
      [{ value: "0", weeklyValue: "0" }] as {
        value: string;
        weeklyValue: string;
      }[],
      "salaries.monthlyBudget",
    ),
  ]);

  const employees = employeesResult.data;
  const payments = paymentsResult.data;
  const monthlyBudgetRows = budgetResult.data;

  const employeeCount = employees.length;
  // Every saved salary is a monthly amount. PostgreSQL performs the complete
  // sum in NUMERIC arithmetic; only the final display value is converted.
  const monthlyBudget = toNumber(monthlyBudgetRows[0]?.value);
  const weeklyCost = toNumber(monthlyBudgetRows[0]?.weeklyValue);

  return (
    <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <KpiTile
          label="Employees"
          value={String(employeeCount)}
          icon={Users}
          accent="cyan"
        />
        <KpiTile
          label="Monthly Budget"
          value={`$${monthlyBudget.toLocaleString(undefined, { maximumFractionDigits: 2 })}`}
          icon={Receipt}
          accent="amber"
        />
        <KpiTile
          label="Weekly Cost"
          value={`$${weeklyCost.toLocaleString(undefined, { maximumFractionDigits: 2 })}`}
          sub="Monthly budget ÷ 4"
          icon={CalendarDays}
          accent="purple"
        />
      </div>

      <FadeIn>
        <SalariesClient
          employees={employees.map((e) => ({
            id: e.id,
            discordName: e.discord_name,
            ethAddress: e.eth_address,
            addressKind: addressKind(e.eth_address),
            salaryUsdt: Number(e.salary_usdt),
          }))}
          payments={payments.map((p) => ({
            id: p.id,
            employeeId: p.employee_id,
            employeeDiscordName: p.employee_discord_name,
            paymentLink: p.payment_link,
            paidAt: new Date(p.paid_at).toISOString(),
          }))}
        />
      </FadeIn>
    </>
  );
}
