import { notFound } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
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
import { CountryBreakdown } from "../../[userId]/country-breakdown";
import { AcquisitionChart } from "../../[userId]/acquisition-chart";
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

      {/* Signups + Active broken out as separate tiles so both numbers
          read at a glance instead of one being relegated to a tiny
          subtitle. Signups counts users who signed up via this code;
          Active counts every user generating deposit/wager value on
          this code right now (signup attribution path doesn't matter
          for the active count — see Referrals table for the breakdown
          of how each active user got here). */}
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
        {/* Deposits = cash into house → emerald. Wagers = money into
            house treasury → emerald. Commission = paid out to creator
            → rose. All per CLAUDE.md house-POV rule.
            Headline value is the REAL deposit volume tied to this
            code (every deposit_bonus event in ledger), with FTD on
            the subtitle so admins still see the first-deposit slice
            (which is what powers FTD-based reporting elsewhere). */}
        <KpiTile
          label="Deposits"
          value={formatCurrency(data.codeDepositTotal)}
          sub={`FTD ${formatCurrency(data.totalDeposits)}`}
          icon={DollarSign}
          accent="emerald"
        />
        {/* Depositor activity tile sits next to the volume tile so the
            two read together. Headline = unique users who made any
            deposit on this code; subtitle = total deposit events
            (always >= unique because a single user can deposit many
            times, all attributed to this code). */}
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

      {/* Acquisition panel (24h/7d toggle, recharts grouped bars +
          collapsible bucket-by-bucket table) side-by-side with country
          ranking. Same AcquisitionChart component used on the creator
          detail page so every admin surface tells the same story. */}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <AcquisitionChart
            hourly={data.acquisition.hourly}
            daily={data.acquisition.daily}
          />
        </div>
        <CountryBreakdown rows={data.countryBreakdown} />
      </div>

      {/* Financial daily chart (deposits/wagers/commission) — stays as-is
          since the acquisition chart covers clicks/signups; this one is the
          money view and retains the existing referrals+clicks bars. */}
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
                const hasVolumeHere = r.codeDepositTotalUsd > 0 || r.totalWagersUsd > 0;
                // Four lifecycle states. The first two (Active + Code
                // user) both count as active referrals on the KPI tile
                // because both are generating deposit/wager value on
                // this code right now — only the signup attribution
                // path differs.
                //  - Active: signed up via this code AND generating
                //    volume on it (fully attributed referral).
                //  - Code user: signed up via a different path but
                //    later switched to this code and is generating
                //    volume on it. Counts toward active referrals.
                //  - Active elsewhere: signed up via this code but
                //    moved on to a different code — no volume here.
                //  - Signup only: signed up via this code, never
                //    deposited or wagered anywhere.
                const status = hasVolumeHere
                  ? r.hasSignup
                    ? { label: "Active", className: "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30" }
                    : { label: "Code user", className: "bg-teal-500/15 text-teal-600 dark:text-teal-400 border-teal-500/30" }
                  : r.activeElsewhere
                    ? { label: "Active elsewhere", className: "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400 border-cyan-500/30" }
                    : { label: "Signup only", className: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30" };
                return (
                  <TableRow key={r.referredUserId}>
                    <TableCell>
                      <Link
                        href={`/users/${r.referredUserId}`}
                        className="hover:underline font-medium"
                      >
                        {r.referredUsername ?? r.referredEmail ?? r.referredUserId.slice(0, 8)}
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
                    {/* Top = FTD (first-time deposit, what
                        affiliate_code_usages captures because backend
                        only writes the first deposit per user). Bottom
                        = total deposit volume on THIS code across all
                        of the user's deposits, derived from
                        ledger_transactions.deposit_bonus events whose
                        metadata.affiliate_code matches. The two are
                        almost always different because the bonus runs
                        every time but the usages row is gated to the
                        first one. */}
                    <TableCell className="text-right tabular-nums">
                      <div className="leading-tight">
                        <div>FTD {formatCurrency(r.ftdDepositUsd)}</div>
                        {r.codeDepositTotalUsd > 0 && (
                          <div className="text-[11px] text-muted-foreground">
                            {formatCurrency(r.codeDepositTotalUsd)} on this code
                            {r.codeDepositCount > 0 && ` · ${r.codeDepositCount} deposit${r.codeDepositCount === 1 ? "" : "s"}`}
                          </div>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCurrency(r.totalWagersUsd)}
                    </TableCell>
                    {/* Commission we paid the creator on this referral →
                        house loss → rose per CLAUDE.md. */}
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
                <TableRow>
                  <TableCell
                    colSpan={7}
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
