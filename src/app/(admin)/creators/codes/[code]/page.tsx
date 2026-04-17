import { notFound } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  Code,
  Users,
  DollarSign,
  Coins,
  TrendingUp,
  MousePointerClick,
  Activity,
} from "lucide-react";
import { getCodeAnalytics } from "@/lib/queries/creators";
import { requirePageAccess } from "@/lib/dal";
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
import { CodeAnalyticsCharts } from "./charts";
import {
  PageHero,
  SectionHeading,
  KpiTile,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";

export const metadata = { title: "Creator Code Detail" };

export default async function CodeAnalyticsPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  await requirePageAccess("/creators/codes");
  const { code } = await params;
  const data = await getCodeAnalytics(code);

  if (!data) notFound();

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex items-center gap-3">
          <Link
            href="/creators/codes"
            className="inline-flex size-9 items-center justify-center rounded-md hover:bg-accent hover:text-accent-foreground"
          >
            <ArrowLeft className="size-4" />
          </Link>
          <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10">
            <Code className="size-5 text-primary" />
          </div>
          <div>
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-2xl font-bold leading-tight font-mono">
                {data.code}
              </h1>
              <Badge
                variant="outline"
                className={
                  data.isActive
                    ? "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30"
                    : "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30"
                }
              >
                {data.isActive ? "Active" : "Inactive"}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              Owner:{" "}
              <Link
                href={`/creators/${data.ownerUserId}`}
                className="hover:underline font-medium text-foreground"
              >
                {data.ownerUsername ?? data.ownerUserId.slice(0, 8)}
              </Link>
            </p>
          </div>
        </div>
      </PageHero>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
        <KpiTile
          label="Referrals"
          value={formatNumber(data.totalReferrals)}
          icon={Users}
          accent="blue"
        />
        <KpiTile
          label="Deposits"
          value={formatCurrency(data.totalDeposits)}
          icon={DollarSign}
          accent="emerald"
        />
        <KpiTile
          label="Wagers"
          value={formatCurrency(data.totalWagers)}
          icon={Coins}
          accent="amber"
        />
        <KpiTile
          label="Commission"
          value={formatCurrency(data.totalCommission)}
          icon={TrendingUp}
          accent="purple"
        />
        <KpiTile
          label="Clicks"
          value={formatNumber(data.totalClicks)}
          icon={MousePointerClick}
          accent="cyan"
        />
      </div>

      {data.daily.length > 0 && (
        <FadeIn>
          <CodeAnalyticsCharts data={data.daily} />
        </FadeIn>
      )}

      <div className="space-y-3">
        <SectionHeading icon={Activity} title="Recent Referrals" />
        <FadeIn className="rounded-2xl border bg-card/60">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Deposit</TableHead>
                <TableHead>Wager</TableHead>
                <TableHead>Commission</TableHead>
                <TableHead>Date</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.recentReferrals.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>
                    <Link
                      href={`/users/${r.referredUserId}`}
                      className="hover:underline"
                    >
                      {r.referredUsername ?? r.referredUserId.slice(0, 8)}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{r.usageType}</Badge>
                  </TableCell>
                  <TableCell>{formatCurrency(r.depositAmountUsd)}</TableCell>
                  <TableCell>{formatCurrency(r.wagerAmountUsd)}</TableCell>
                  <TableCell className="text-green-500">
                    {formatCurrency(r.referrerCutUsd)}
                  </TableCell>
                  <TableCell>{formatDateTime(r.createdAt)}</TableCell>
                </TableRow>
              ))}
              {data.recentReferrals.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="h-24 text-center text-muted-foreground"
                  >
                    No referrals yet.
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
