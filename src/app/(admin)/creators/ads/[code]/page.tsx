import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowDownToLine,
  ArrowLeft,
  Coins,
  Flag,
  Globe,
  Megaphone,
  MousePointerClick,
  Percent,
  UserPlus,
  Users,
} from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import { KpiTile, PageHero, SectionHeading } from "@/components/modern-panels";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  formatCurrency,
  formatDateTime,
  formatNumber,
  formatRelative,
} from "@/lib/utils/format";
import {
  SETTINGS_KEYS,
  getAdminSetting,
} from "@/lib/admin-settings";
import { getAdCodeDetail } from "@/lib/queries/ads";
import { ClicksByDayChart } from "./charts";
import { CopyShareLink } from "./copy-link";

export const metadata = { title: "Ad Code Detail" };

export default async function AdCodeDetailPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  await requirePageAccess("/creators/ads");
  const { code } = await params;
  const decoded = decodeURIComponent(code);

  const houseUserId = await getAdminSetting(SETTINGS_KEYS.HOUSE_AFFILIATE_USER_ID);
  if (!houseUserId) notFound();

  const detail = await getAdCodeDetail(houseUserId, decoded);
  if (!detail) notFound();

  const { summary, clicksByDay, clicksByCountry, signupsList } = detail;

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <Link
              href="/creators/ads"
              className="inline-flex size-9 items-center justify-center rounded-md hover:bg-accent hover:text-accent-foreground"
              aria-label="Back to Ads"
            >
              <ArrowLeft className="size-4" />
            </Link>
            <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10 shrink-0">
              <Megaphone className="size-5 text-primary" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-2xl font-bold font-mono leading-tight truncate">
                  {summary.code}
                </h1>
                <Badge
                  variant="outline"
                  className="bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30"
                >
                  Ad code
                </Badge>
              </div>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Created {formatRelative(summary.createdAt)} ·{" "}
                {formatDateTime(summary.createdAt)}
              </p>
            </div>
          </div>
          <div className="w-full md:w-[360px] shrink-0">
            <CopyShareLink code={summary.code} />
          </div>
        </div>
      </PageHero>

      {/* KPI strip */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <KpiTile
          label="Clicks"
          value={formatNumber(summary.clicks)}
          icon={MousePointerClick}
          accent="blue"
        />
        {/* Signups = unique users with usage_type='signup' on this code
            (canonical from affiliate_code_usages). Sub line shows how
            many of them later deposited or wagered, so a code with lots
            of signups but no activity is visible at a glance. */}
        <KpiTile
          label="Signups"
          value={formatNumber(summary.signups)}
          sub={`${formatNumber(summary.activeReferrals)} active`}
          icon={UserPlus}
          accent="cyan"
        />
        {/* Depositors = unique users who made any deposit booked to
            this ad code (from ledger.deposit_bonus events). Subtitle
            shows total deposit event count, since one user often makes
            many deposits — both numbers matter for ad performance. */}
        <KpiTile
          label="Depositors"
          value={formatNumber(summary.depositors)}
          sub={`${formatNumber(summary.depositEventCount)} deposits`}
          icon={Users}
          accent="emerald"
        />
        <KpiTile
          label="Conversion"
          value={
            summary.clicks > 0
              ? `${(summary.conversionRate * 100).toFixed(2)}%`
              : "—"
          }
          sub="signups / clicks"
          icon={Percent}
          accent="amber"
        />
        {/* Deposits = real volume from ledger (every deposit booked
            to this code). FTD subtitle shows the first-deposit slice
            from affiliate_code_usages, since that's still the headline
            number elsewhere. */}
        <KpiTile
          label="Deposits"
          value={formatCurrency(summary.depositVolumeUsd)}
          sub={`FTD ${formatCurrency(summary.ftdVolumeUsd)}`}
          icon={ArrowDownToLine}
          accent="purple"
        />
        <KpiTile
          label="Wagers"
          value={formatCurrency(summary.wagerVolumeUsd)}
          icon={Coins}
          accent="pink"
        />
      </div>

      {/* Clicks over time */}
      <ClicksByDayChart data={clicksByDay} />

      {/* Geography + Signups — side by side on wide screens */}
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-3">
          <SectionHeading icon={Globe} title="Top countries" />
          <div className="rounded-2xl border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Country</TableHead>
                  <TableHead className="text-right">Clicks</TableHead>
                  <TableHead className="text-right">% of total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {clicksByCountry.map((c) => {
                  const pct =
                    summary.clicks > 0 ? (c.clicks / summary.clicks) * 100 : 0;
                  return (
                    <TableRow key={c.country}>
                      <TableCell>
                        <span className="inline-flex items-center gap-2">
                          <Flag className="size-3.5 text-muted-foreground" />
                          {c.country || "Unknown"}
                        </span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatNumber(c.clicks)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {pct.toFixed(1)}%
                      </TableCell>
                    </TableRow>
                  );
                })}
                {clicksByCountry.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={3}
                      className="h-24 text-center text-sm text-muted-foreground"
                    >
                      No clicks yet.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </div>

        <div className="space-y-3">
          <SectionHeading
            icon={UserPlus}
            title={`Signups (${formatNumber(signupsList.length)})`}
          />
          <div className="rounded-2xl border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead className="text-right">Deposited</TableHead>
                  <TableHead>FTD</TableHead>
                  <TableHead>Joined</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {signupsList.map((s) => (
                  <TableRow key={s.userId}>
                    <TableCell>
                      <Link
                        href={`/users/${s.userId}`}
                        className="font-medium hover:underline"
                      >
                        {s.username ?? s.email ?? s.userId.slice(0, 8)}
                      </Link>
                      {s.email && s.username && (
                        <p className="text-xs text-muted-foreground truncate">
                          {s.email}
                        </p>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCurrency(s.totalDepositedUsd)}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={
                          s.isFtd
                            ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30"
                            : "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30"
                        }
                      >
                        {s.isFtd ? "Yes" : "No"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatRelative(s.createdAt)}
                    </TableCell>
                  </TableRow>
                ))}
                {signupsList.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={4}
                      className="h-24 text-center text-sm text-muted-foreground"
                    >
                      No signups yet.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          {signupsList.length >= 100 && (
            <p className="text-xs text-muted-foreground">
              Showing the 100 most recent signups.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
