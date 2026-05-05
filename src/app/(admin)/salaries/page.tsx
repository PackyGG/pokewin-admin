import { Coins, Users, Receipt, CalendarDays } from "lucide-react";
import { adminDb } from "@/lib/admin-db";
import { requireMotha } from "@/lib/salary/motha-gate";
import { ensureSalarySchema } from "@/lib/salary/ensure-schema";
import { PageHero, KpiTile } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { SalariesClient } from "./salaries-client";

export const metadata = { title: "Employee Salaries" };

export default async function SalariesPage() {
  await requireMotha();
  // Defensive — the original migration created salary_wallet which
  // the latest schema drops. ensureSalarySchema runs the DROP +
  // CREATE-IF-NOT-EXISTS sequence so a stale env self-converges.
  await ensureSalarySchema().catch(() => {
    /* swallow — the queries below will surface a clearer error */
  });

  const now = new Date();
  const startOfMonth = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0),
  );
  const startOfYear = new Date(Date.UTC(now.getUTCFullYear(), 0, 1, 0, 0, 0));

  const [employees, recentPayouts, paidThisMonth, paidYtd] = await Promise.all([
    adminDb.salary_employees.findMany({
      orderBy: [{ active: "desc" }, { discord_name: "asc" }],
    }),
    adminDb.salary_payouts.findMany({
      orderBy: { created_at: "desc" },
      take: 50,
      include: {
        employee: { select: { discord_name: true, eth_address: true } },
      },
    }),
    // Sum what founders have already logged as paid this calendar
    // month (UTC-anchored — same as startOfMonth above).
    adminDb.salary_payouts.aggregate({
      where: { created_at: { gte: startOfMonth } },
      _sum: { amount_usdt: true },
    }),
    adminDb.salary_payouts.aggregate({
      where: { created_at: { gte: startOfYear } },
      _sum: { amount_usdt: true },
    }),
  ]);

  const activeEmployees = employees.filter((e) => e.active).length;
  // Monthly budget = sum of (salary × periods-per-month) across all
  // active employees, normalized to a calendar month. Per-period
  // salary stays as the input; cadence converts it to monthly:
  //   weekly   → ×52/12 (≈4.33)
  //   biweekly → ×26/12 (≈2.17)
  //   monthly  → ×1
  // Fallback: anything else (or stale rows from before the cadence
  // column existed) is treated as monthly.
  const periodsPerMonth = (cadence: string): number => {
    if (cadence === "weekly") return 52 / 12;
    if (cadence === "biweekly") return 26 / 12;
    return 1;
  };
  const monthlyBudget = employees
    .filter((e) => e.active)
    .reduce(
      (sum, e) => sum + Number(e.salary_usdt) * periodsPerMonth(e.cadence),
      0,
    );
  const paidThisMonthUsd = Number(paidThisMonth._sum.amount_usdt ?? 0);
  const paidYtdUsd = Number(paidYtd._sum.amount_usdt ?? 0);

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-amber-500/10">
            <Coins className="size-5 text-amber-500" />
          </div>
          <div>
            <h1 className="text-2xl font-bold leading-tight">
              Employee Salaries
            </h1>
            <p className="text-sm text-muted-foreground">
              Saved recipient registry. Click an employee&apos;s
              address to scan it as a QR code, send USDT manually
              from your wallet, then log the payment here.
            </p>
          </div>
        </div>
      </PageHero>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
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
          label="Paid This Month"
          value={`$${paidThisMonthUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}`}
          sub={
            monthlyBudget > 0
              ? `${Math.min(100, (paidThisMonthUsd / monthlyBudget) * 100).toFixed(0)}% of budget`
              : undefined
          }
          icon={CalendarDays}
          accent="emerald"
        />
        <KpiTile
          label="Paid YTD"
          value={`$${paidYtdUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}`}
          icon={Coins}
          accent="purple"
        />
      </div>

      <FadeIn>
        <SalariesClient
          employees={employees.map((e) => ({
            id: e.id,
            discordName: e.discord_name,
            ethAddress: e.eth_address,
            cadence: (e.cadence === "weekly" ||
            e.cadence === "biweekly" ||
            e.cadence === "monthly"
              ? e.cadence
              : "monthly") as "weekly" | "biweekly" | "monthly",
            salaryUsdt: Number(e.salary_usdt),
            active: e.active,
            lastPaidAt: e.last_paid_at?.toISOString() ?? null,
            notes: e.notes,
          }))}
          payouts={recentPayouts.map((p) => ({
            id: p.id,
            employeeId: p.employee_id,
            employeeDiscordName: p.employee.discord_name,
            amountUsdt: Number(p.amount_usdt),
            toAddress: p.to_address,
            txHash: p.tx_hash,
            notes: p.error_message,
            paidAt: (p.confirmed_at ?? p.broadcast_at ?? p.created_at).toISOString(),
            createdAt: p.created_at.toISOString(),
          }))}
        />
      </FadeIn>
    </div>
  );
}
