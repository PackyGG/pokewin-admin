import Link from "next/link";
import { Coins, Trophy, TrendingUp, Users } from "lucide-react";
import {
  KpiTile,
  SectionHeading,
} from "@/components/modern-panels";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { FadeIn } from "@/components/fade-in";
import { formatCompactUsd, formatCurrency, formatNumber } from "@/lib/utils/format";
import { getStreamerInsightRows } from "@/lib/queries/insights-streamers/overview";
import { periodLabel, type StreamerPeriod } from "./types";

/**
 * Money Makers — top 25 creators by NET house P&L contribution in the
 * window. The Overview already shows everyone; this tab is the
 * "executive view" — only the contributors, ranked by what they're
 * actually worth to us after costs.
 *
 * Filtering: only creators with cohortDeposits > 0 are eligible (no
 * deposits = no real economic contribution regardless of commission /
 * cohort size).
 */
export async function MoneyMakersTab({ period }: { period: StreamerPeriod }) {
  const all = await getStreamerInsightRows(period);
  const eligible = all.filter((r) => r.cohortDepositsUsd > 0);
  const top = eligible.slice(0, 25);

  // Headline aggregates restricted to the eligible set so the "Top 25
  // contributors" caption matches the visible rows.
  const topPnlSum = top.reduce((acc, r) => acc + r.housePnl, 0);
  const topDepositsSum = top.reduce(
    (acc, r) => acc + r.cohortDepositsUsd,
    0,
  );
  const topReferred = top.reduce((acc, r) => acc + r.referredCount, 0);

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
          <KpiTile
            label="Top 25 House P&L"
            value={formatCompactUsd(topPnlSum)}
            sub="Net to us, post-commission"
            icon={TrendingUp}
            accent={topPnlSum >= 0 ? "emerald" : "rose"}
          />
          <KpiTile
            label="Top 25 Deposits"
            value={formatCompactUsd(topDepositsSum)}
            sub="Cohort cash in"
            icon={Coins}
            accent="emerald"
          />
          <KpiTile
            label="Top 25 Referred"
            value={formatNumber(topReferred)}
            sub="Users behind the numbers"
            icon={Users}
            accent="blue"
          />
          <KpiTile
            label="Eligible Creators"
            value={formatNumber(eligible.length)}
            sub={`of ${all.length} total`}
            icon={Trophy}
            accent="purple"
          />
        </div>
      </FadeIn>

      <FadeIn delay={75}>
        <SectionHeading
          icon={Trophy}
          title={`Top Money Makers — ${periodLabel(period)}`}
        />
        <div className="surface-sheen surface-raise rounded-xl border bg-card mt-3">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12 text-center">#</TableHead>
                <TableHead>Streamer</TableHead>
                <TableHead>Code</TableHead>
                <TableHead className="text-right">Referred</TableHead>
                <TableHead className="text-right">Cohort Wager</TableHead>
                <TableHead className="text-right">Deposits</TableHead>
                <TableHead className="text-right">Commission</TableHead>
                <TableHead className="text-right">Settled Payout</TableHead>
                <TableHead className="text-right">Net to House</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {top.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={9}
                    className="py-10 text-center text-sm text-muted-foreground"
                  >
                    No creators with deposit activity in this window.
                  </TableCell>
                </TableRow>
              ) : (
                top.map((r, idx) => {
                  const pnlPos = r.housePnl >= 0;
                  return (
                    <TableRow key={r.userId}>
                      <TableCell className="text-center text-muted-foreground tabular-nums">
                        {idx + 1}
                      </TableCell>
                      <TableCell>
                        <Link
                          href={`/creators/${r.userId}`}
                          className="font-medium hover:underline"
                        >
                          {r.username ?? r.userId.slice(0, 8)}
                        </Link>
                      </TableCell>
                      <TableCell>
                        {r.primaryCode ? (
                          <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                            {r.primaryCode}
                          </code>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatNumber(r.referredCount)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                        {formatCurrency(r.cohortWagerUsd)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                        {formatCurrency(r.cohortDepositsUsd)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-rose-600 dark:text-rose-400">
                        {r.commissionAccruedUsd > 0
                          ? `−${formatCurrency(r.commissionAccruedUsd)}`
                          : formatCurrency(0)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-rose-600 dark:text-rose-400">
                        {r.payoutSettledUsd > 0
                          ? `−${formatCurrency(r.payoutSettledUsd)}`
                          : formatCurrency(0)}
                      </TableCell>
                      <TableCell className="text-right font-semibold tabular-nums">
                        <span
                          className={
                            pnlPos
                              ? "text-emerald-600 dark:text-emerald-400"
                              : "text-rose-600 dark:text-rose-400"
                          }
                        >
                          {pnlPos ? "+" : "−"}
                          {formatCurrency(Math.abs(r.housePnl))}
                        </span>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </FadeIn>
    </div>
  );
}
