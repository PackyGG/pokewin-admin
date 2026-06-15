import Link from "next/link";
import { Network, MousePointerClick, UserPlus, Wallet, Dices } from "lucide-react";
import { KpiTile, SectionHeading } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { EmptyState } from "@/components/empty-state";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { safeQuery } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { getAffiliateCodePerformance } from "@/lib/queries/insights-rewards/affiliate/code-performance";
import { compareAffiliateCodePerf } from "@/lib/clickhouse/compare/insights-affiliate-code-perf";
import {
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";

/**
 * Per-affiliate-code funnel: click → signup → first deposit → wager.
 *
 * Click rows come from `affiliate_clicks` (pre-signup landing-page
 * hits). The middle and bottom stages come from `affiliate_code_usages`
 * — signup proxy = distinct referred users with any usage row, deposit
 * proxy = distinct users with deposit_amount_usd > 0, wager proxy =
 * distinct users with wager_amount_usd > 0.
 *
 * Click → signup conversion is aggregate-level (clicks table doesn't
 * carry user ids), not per-user attribution. Still the right altitude
 * for "is this code's traffic actually converting".
 */
export async function AffiliateCodePerfTab({
  period,
}: {
  period: InsightsRewardsPeriod;
}) {
  const { data, error } = await safeQuery(
    () => getAffiliateCodePerformance(period),
    null,
    "insights-rewards-affiliate.code-perf",
  );
  if (error || !data) {
    return (
      <TileErrorFallback
        label="Affiliate — Code funnel"
        hint="The code-performance query failed. Server logs hold the digest."
        size="panel"
      />
    );
  }
  const label = insightsRewardsPeriodLabel(period);

  void compareAffiliateCodePerf(period, data);

  if (data.length === 0) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <EmptyState
          icon={Network}
          title={`No code activity in ${label.toLowerCase()}`}
          description="No affiliate codes had usage rows in this window. Try a longer period."
          compact
        />
      </div>
    );
  }

  const totalClicks = data.reduce((a, r) => a + r.clicks, 0);
  const totalSignups = data.reduce((a, r) => a + r.signups, 0);
  const totalDepositors = data.reduce((a, r) => a + r.depositors, 0);
  const totalWagerers = data.reduce((a, r) => a + r.wagerers, 0);

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <KpiTile
            label="Clicks"
            value={formatNumber(totalClicks)}
            sub="Top 25 codes"
            icon={MousePointerClick}
            accent="blue"
          />
          <KpiTile
            label="Signups (proxy)"
            value={formatNumber(totalSignups)}
            sub="Distinct referred"
            icon={UserPlus}
            accent="blue"
          />
          <KpiTile
            label="Depositors"
            value={formatNumber(totalDepositors)}
            sub="≥1 deposit usage"
            icon={Wallet}
            accent="emerald"
          />
          <KpiTile
            label="Wagerers"
            value={formatNumber(totalWagerers)}
            sub="≥1 wager usage"
            icon={Dices}
            accent="emerald"
          />
        </div>
      </FadeIn>

      <FadeIn>
        <div className="space-y-3">
          <SectionHeading
            icon={Network}
            title={`Code funnel · top ${data.length} codes by wager · ${label}`}
          />
          <p className="text-xs text-muted-foreground">
            Click → Signup conversion is aggregate (clicks table doesn&apos;t
            carry user ids). Signup proxy = distinct referred users with
            any usage row in window. Stages are window-local.
          </p>
          <div className="rounded-2xl border bg-card p-1.5 sm:p-2">
            <div className="space-y-1.5 md:hidden">
              {data.map((r) => (
                <div
                  key={r.code}
                  className="space-y-1.5 rounded-lg border bg-card px-3 py-2.5"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono">
                      {r.code}
                    </code>
                    <Link
                      href={`/users/${r.affiliateUserId}`}
                      className="text-[11px] text-muted-foreground hover:underline"
                    >
                      {r.affiliateUsername ?? r.affiliateUserId.slice(0, 8)}
                    </Link>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 text-[11px] tabular-nums">
                    <FunnelPill label="Click" value={formatNumber(r.clicks)} />
                    <FunnelArrow pct={r.clickToSignupPct} />
                    <FunnelPill label="Sign" value={formatNumber(r.signups)} />
                    <FunnelArrow pct={r.signupToDepositPct} />
                    <FunnelPill label="Dep" value={formatNumber(r.depositors)} />
                    <FunnelArrow pct={r.depositToWagerPct} />
                    <FunnelPill label="Wager" value={formatNumber(r.wagerers)} />
                  </div>
                  <div className="grid grid-cols-2 gap-1.5 text-[11px] tabular-nums">
                    <div className="text-muted-foreground">
                      Cohort wager:{" "}
                      <span className="text-emerald-600 dark:text-emerald-400">
                        {formatCurrency(r.totalDownstreamWager)}
                      </span>
                    </div>
                    <div className="text-muted-foreground">
                      Commission:{" "}
                      <span className="text-rose-600 dark:text-rose-400">
                        {formatCurrency(r.commissionAccrued)}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div className="hidden md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Code</TableHead>
                    <TableHead>Affiliate</TableHead>
                    <TableHead className="text-right">Clicks</TableHead>
                    <TableHead className="text-right">Signups</TableHead>
                    <TableHead className="text-right">Depositors</TableHead>
                    <TableHead className="text-right">Wagerers</TableHead>
                    <TableHead className="text-right">Click→Sign %</TableHead>
                    <TableHead className="text-right">Sign→Dep %</TableHead>
                    <TableHead className="text-right">Dep→Wager %</TableHead>
                    <TableHead className="text-right">Cohort wager</TableHead>
                    <TableHead className="text-right">Commission</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.map((r) => (
                    <TableRow key={r.code}>
                      <TableCell>
                        <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono">
                          {r.code}
                        </code>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        <Link
                          href={`/users/${r.affiliateUserId}`}
                          className="hover:underline"
                        >
                          {r.affiliateUsername ?? r.affiliateUserId.slice(0, 8)}
                        </Link>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatNumber(r.clicks)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatNumber(r.signups)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatNumber(r.depositors)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatNumber(r.wagerers)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {r.clickToSignupPct === null
                          ? "—"
                          : `${r.clickToSignupPct.toFixed(1)}%`}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {r.signupToDepositPct === null
                          ? "—"
                          : `${r.signupToDepositPct.toFixed(1)}%`}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {r.depositToWagerPct === null
                          ? "—"
                          : `${r.depositToWagerPct.toFixed(1)}%`}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                        {formatCurrency(r.totalDownstreamWager)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-rose-600 dark:text-rose-400">
                        {formatCurrency(r.commissionAccrued)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        </div>
      </FadeIn>
    </div>
  );
}

function FunnelPill({ label, value }: { label: string; value: string }) {
  return (
    <span className="rounded-md border bg-muted/30 px-1.5 py-0.5 text-[10px]">
      <span className="text-muted-foreground">{label}:</span>{" "}
      <span className="font-medium">{value}</span>
    </span>
  );
}

function FunnelArrow({ pct }: { pct: number | null }) {
  return (
    <span className="text-[10px] text-muted-foreground">
      →
      {pct !== null && (
        <span className="ml-0.5 tabular-nums">{pct.toFixed(0)}%</span>
      )}
    </span>
  );
}
