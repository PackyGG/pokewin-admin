import { CalendarDays, Receipt, Users } from "lucide-react";
import { desc, eq, sql } from "drizzle-orm";
import { adminDrizzle } from "@/lib/admin-db";
import { salary_employees, salary_payments } from "@/lib/db-schema/admin/schema";
import { requireMotha } from "@/lib/salary/motha-gate";
import { addressKind } from "@/lib/salary/wallet";
import { toNumber } from "@/lib/utils/decimal";
import { PageHero, PageHeroIdentity, KpiTile } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { SalariesClient } from "./salaries-client";

export const metadata = { title: "Employee Salaries" };

export default async function SalariesPage() {
  await requireMotha();
  const [employees, payments, monthlyBudgetRows] = await Promise.all([
    adminDrizzle.select().from(salary_employees)
      .orderBy(desc(salary_employees.active), salary_employees.discord_name),
    adminDrizzle.select({
      id: salary_payments.id, employee_id: salary_payments.employee_id,
      payment_link: salary_payments.payment_link, paid_at: salary_payments.paid_at,
      employee_discord_name: salary_employees.discord_name,
    }).from(salary_payments)
      .innerJoin(salary_employees, eq(salary_employees.id, salary_payments.employee_id))
      .orderBy(desc(salary_payments.paid_at)).limit(100),
    adminDrizzle
      .select({
        value: sql<string>`COALESCE(SUM(${salary_employees.salary_usdt}), 0)::text`,
        weeklyValue: sql<string>`COALESCE(SUM(${salary_employees.salary_usdt}) / 4, 0)::text`,
      })
      .from(salary_employees)
      .where(eq(salary_employees.active, true)),
  ]);

  const activeEmployees = employees.filter((e) => e.active).length;
  // Every saved salary is a monthly amount. PostgreSQL performs the complete
  // sum in NUMERIC arithmetic; only the final display value is converted.
  const monthlyBudget = toNumber(monthlyBudgetRows[0]?.value);
  const weeklyCost = toNumber(monthlyBudgetRows[0]?.weeklyValue);

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity />
      </PageHero>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <KpiTile
          label="Active Employees"
          value={String(activeEmployees)}
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
            active: e.active,
            notes: e.notes,
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
    </div>
  );
}
