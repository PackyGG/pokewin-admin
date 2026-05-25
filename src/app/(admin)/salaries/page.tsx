import { Coins, Users, Receipt, Wallet } from "lucide-react";
import { adminDb } from "@/lib/admin-db";
import { requireMotha } from "@/lib/salary/motha-gate";
import { ensureSalarySchema } from "@/lib/salary/ensure-schema";
import { addressKind } from "@/lib/salary/wallet";
import { PageHero, PageHeroIdentity, KpiTile } from "@/components/modern-panels";
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

  const employees = await adminDb.salary_employees.findMany({
    orderBy: [{ active: "desc" }, { discord_name: "asc" }],
  });

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
  // Address-type breakdown for the overview tile — derived purely from
  // each saved address's format (ERC-20 0x… vs Solana base58).
  const erc20Count = employees.filter(
    (e) => addressKind(e.eth_address) === "erc20",
  ).length;
  const solCount = employees.filter(
    (e) => addressKind(e.eth_address) === "sol",
  ).length;
  const unknownCount = employees.length - erc20Count - solCount;

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Coins}
          accent="amber"
          title="Employee Salaries"
          subtitle={
            <>
              Saved recipient registry. Click an employee&apos;s address to
              scan it as a QR code and pay them manually from your wallet.
              Each address is tagged ERC-20 or Solana.
            </>
          }
        />
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
          label="Address Types"
          value={`${erc20Count} ERC-20`}
          sub={
            `${solCount} SOL` +
            (unknownCount > 0 ? ` · ${unknownCount} other` : "")
          }
          icon={Wallet}
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
            cadence: (e.cadence === "weekly" ||
            e.cadence === "biweekly" ||
            e.cadence === "monthly"
              ? e.cadence
              : "monthly") as "weekly" | "biweekly" | "monthly",
            salaryUsdt: Number(e.salary_usdt),
            active: e.active,
            notes: e.notes,
          }))}
        />
      </FadeIn>
    </div>
  );
}
