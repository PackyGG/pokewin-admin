import { notFound } from "next/navigation";
import Link from "next/link";
import {
  Code,
  Users,
  UserCheck,
  DollarSign,
  Receipt,
  Coins,
  TrendingUp,
  MousePointerClick,
  Activity,
} from "lucide-react";
import { getCodeAnalytics } from "@/lib/queries/creators";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCurrency, formatDateTime, formatNumber } from "@/lib/utils/format";
import { CodeAnalyticsCharts } from "@/app/(admin)/creators/codes/[code]/charts";
import { CountryBreakdown } from "@/app/(admin)/creators/[userId]/country-breakdown";
import { AcquisitionChart } from "@/app/(admin)/creators/[userId]/acquisition-chart";
import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
  KpiTile,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { EmptyState } from "@/components/empty-state";

import { requireCreatorHubPageAccess } from "../../_lib/require-creator-hub-access";

export const metadata = { title: "Code Detail · Creator Hub" };

const HUB_CODES_LIST = "/creator-hub/codes-ads/codes";
const HUB_CREATORS_BASE = "/creator-hub/creators";

export default async function CreatorHubCodeDetailPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  await requireCreatorHubPageAccess();
  const { code } = await params;
  const data = await getCodeAnalytics(code);

  if (!data) notFound();

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Code}
          accent="pink"
          backHref={HUB_CODES_LIST}
          title={data.code}
          titleClassName="font-mono"
          badges={
            <Badge
              variant="outline"
              className={
                data.isActive
                  ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30"
                  : "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30"
              }
            >
              {data.isActive ? "Active" : "Inactive"}
            </Badge>
          }
          subtitle={
            <>
              Owner:{" "}
              <Link
                href={`${HUB_CREATORS_BASE}/${data.ownerUserId}`}
                className="hover:underline font-medium text-foreground"
              >
                {data.ownerUsername ?? data.ownerUserId.slice(0, 8)}
              </Link>
            </>
          }
        />
      </PageHero>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-7">
        <KpiTile
          label="Signups"
          value={formatNumber(data.totalReferrals)}
          icon={Users}
          accent="blue"
        />
        <KpiTile
          label="Active"
          value={formatNumber(data.activeReferrals)}
          icon={UserCheck}
          accent="emerald"
        />
        <KpiTile
          label="Deposits"
          value={formatCurrency(data.codeDepositTotal)}
          sub={`FTD ${formatCurrency(data.totalDeposits)}`}
          icon={DollarSign}
          accent="emerald"
        />
        <KpiTile
          label="Depositors"
          value={formatNumber(data.codeUniqueDepositors)}
          sub={`${formatNumber(data.codeDepositEventCount)} deposits`}
          icon={Receipt}
          accent="emerald"
        />
        <KpiTile
          label="Wagers"
          value={formatCurrency(data.totalWagers)}
          icon={Coins}
          accent="emerald"
        />
        <KpiTile
          label="Commission"
          value={formatCurrency(data.totalCommission)}
          icon={TrendingUp}
          accent="rose"
        />
        <KpiTile
          label="Clicks"
          value={formatNumber(data.totalClicks)}
          icon={MousePointerClick}
          accent="cyan"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <AcquisitionChart
            hourly={data.acquisition.hourly}
            daily={data.acquisition.daily}
          />
        </div>
        <CountryBreakdown rows={data.countryBreakdown} />
      </div>

      {data.daily.length > 0 && (
        <FadeIn>
          <CodeAnalyticsCharts data={data.daily} />
        </FadeIn>
      )}

      <div className="space-y-3">
        <SectionHeading icon={Activity} title="Referrals" />
        <FadeIn className="rounded-2xl border bg-card/60">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Deposits</TableHead>
                <TableHead className="text-right">Wagers</TableHead>
                <TableHead className="text-right">Commission</TableHead>
                <TableHead>Joined</TableHead>
                <TableHead>Last activity</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.recentReferrals.map((r) => {
                const hasVolumeHere =
                  r.codeDepositTotalUsd > 0 || r.totalWagersUsd > 0;
                const status = hasVolumeHere
                  ? r.hasSignup
                    ? {
                        label: "Active",
                        className:
                          "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30",
                      }
                    : {
                        label: "Code user",
                        className:
                          "bg-teal-500/15 text-teal-600 dark:text-teal-400 border-teal-500/30",
                      }
                  : r.activeElsewhere
                    ? {
                        label: "Active elsewhere",
                        className:
                          "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400 border-cyan-500/30",
                      }
                    : {
                        label: "Signup only",
                        className:
                          "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30",
                      };
                return (
                  <TableRow key={r.referredUserId}>
                    <TableCell>
                      <Link
                        href={`/users/${r.referredUserId}`}
                        className="hover:underline font-medium"
                      >
                        {r.referredUsername ??
                          r.referredEmail ??
                          r.referredUserId.slice(0, 8)}
                      </Link>
                      {r.referredEmail && r.referredUsername && (
                        <p className="text-xs text-muted-foreground truncate">
                          {r.referredEmail}
                        </p>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={status.className}>
                        {status.label}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      <div className="leading-tight">
                        <div>FTD {formatCurrency(r.ftdDepositUsd)}</div>
                        {r.codeDepositTotalUsd > 0 && (
                          <div className="text-[11px] text-muted-foreground">
                            {formatCurrency(r.codeDepositTotalUsd)} on this code
                            {r.codeDepositCount > 0 &&
                              ` · ${r.codeDepositCount} deposit${r.codeDepositCount === 1 ? "" : "s"}`}
                          </div>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCurrency(r.totalWagersUsd)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-rose-600 dark:text-rose-400">
                      {formatCurrency(r.totalCommissionUsd)}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatDateTime(r.firstActivityAt)}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatDateTime(r.lastActivityAt)}
                    </TableCell>
                  </TableRow>
                );
              })}
              {data.recentReferrals.length === 0 && (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={7} className="p-0">
                    <EmptyState
                      icon={Activity}
                      title="No referrals yet"
                      description="When a user signs up, deposits, or wagers on this code, they'll appear here."
                      compact
                    />
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </FadeIn>
      </div>
    </div>
  );
}
