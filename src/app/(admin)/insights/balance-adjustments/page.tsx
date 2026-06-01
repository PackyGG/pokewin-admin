import { Suspense } from "react";
import { Scale } from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import {
  parseInsightsRewardsPeriod,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import { BalanceAdjustmentPeriodFilter } from "./_components/period-filter";
import { BalanceAdjustmentTabSwitch } from "./_components/tab-switch";
import { BalanceAdjustmentTabSkeleton } from "./_components/tab-skeleton";
import { OverviewTab } from "./_components/overview-tab";
import { DirectionTab } from "./_components/direction-tab";
import { AdminsTab } from "./_components/admins-tab";
import { UsersTab } from "./_components/users-tab";
import { AuditTab } from "./_components/audit-tab";

export const metadata = { title: "Balance Adjustments Insights" };

type Tab = "overview" | "direction" | "admins" | "users" | "audit";

function parseTab(value: string | undefined): Tab {
  switch (value) {
    case "direction":
    case "admins":
    case "users":
    case "audit":
      return value;
    default:
      return "overview";
  }
}

/**
 * /insights/balance-adjustments — deep insight surface for admin manual
 * credits & debits to user balances.
 *
 * DATA SOURCE: main-DB `ledger_transactions` rows with
 * `type = 'admin_balance_adjustment'` (written by `adjustBalance` /
 * `recordManualWithdrawal` in src/app/(admin)/users/[id]/actions.ts).
 * Amount is signed: > 0 credit (house pays), < 0 debit (house takes /
 * manual withdrawal). The reason is embedded in the row description.
 * Admin attribution lives in the admin-DB `admin_audit_events` trail
 * (the two Postgres clusters are never SQL-joined per CLAUDE.md).
 *
 * Five tabs:
 *   1. Overview          — volume (credits vs debits), count, net, avg,
 *                           users affected, admins adjusting + daily chart
 *   2. Direction & Reason — credit/debit split, reason breakdown, size
 *                           distribution
 *   3. By Admin          — accountability: which admin moved how much
 *   4. By User           — top credited / top debited / high-frequency
 *   5. Audit trail       — forensic: recent adjustments, admin → user
 *
 * Period selector exposes 24h / 3d / 7d / 30d / 90d / lifetime.
 *
 * House-POV (per CLAUDE.md): a CREDIT to a user is a payout the house
 * gives → rose. A DEBIT (house takes back) → emerald. Net liability for
 * the house (credits exceed debits) → rose.
 *
 * Every query is `safeQuery`-wrapped so a single failure degrades only
 * its tile / section, not the whole tab.
 */
export default async function BalanceAdjustmentsInsightsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/insights/balance-adjustments");
  const params = await searchParams;
  const period = parseInsightsRewardsPeriod(params.period);
  const tab = parseTab(params.tab);

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
          <PageHeroIdentity
            icon={Scale}
            accent="purple"
            title="Balance Adjustments"
            subtitle="Admin manual credits & debits — who, how much, why, to whom."
          />
          <BalanceAdjustmentPeriodFilter />
        </div>
      </PageHero>

      <BalanceAdjustmentTabSwitch />

      <Suspense
        key={`${tab}:${period}`}
        fallback={<BalanceAdjustmentTabSkeleton />}
      >
        <TabContent tab={tab} period={period} />
      </Suspense>
    </div>
  );
}

async function TabContent({
  tab,
  period,
}: {
  tab: Tab;
  period: InsightsRewardsPeriod;
}) {
  switch (tab) {
    case "overview":
      return <OverviewTab period={period} />;
    case "direction":
      return <DirectionTab period={period} />;
    case "admins":
      return <AdminsTab period={period} />;
    case "users":
      return <UsersTab period={period} />;
    case "audit":
      return <AuditTab period={period} />;
  }
}
