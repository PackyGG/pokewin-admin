import Link from "next/link";
import { Trophy } from "lucide-react";
import { SectionHeading } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { EmptyState } from "@/components/empty-state";
import { formatCurrency, formatDate, formatNumber } from "@/lib/utils/format";
import {
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import { getSignupTopRecipients } from "@/lib/queries/insights-rewards/signup/top-recipients";
import { safeQuery } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";

/**
 * Top recipients tab — top 25 signup-bonus claimants by total claim
 * volume. Window filters the CLAIM rows (not signup date) so the
 * tab reads as "who collected the most signup bonuses in this period".
 *
 * Each row has user link, country, signup date, claim count + volume,
 * largest single claim, first / last claim dates, and lifetime deposit
 * total (for the leaderboard's profile lens — admins can see if
 * top bonus recipients are also depositors).
 */
export async function TopRecipientsTab({
  period,
}: {
  period: InsightsRewardsPeriod;
}) {
  const { data: rows, error } = await safeQuery(
    () => getSignupTopRecipients(period),
    null,
    "insights-rewards-signup.top",
  );
  if (error || !rows) {
    return (
      <TileErrorFallback
        label="Signup — Top recipients"
        hint="The top-recipients query failed. Server logs hold the digest."
        size="panel"
      />
    );
  }
  const label = insightsRewardsPeriodLabel(period);
  if (rows.length === 0) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <EmptyState
          icon={Trophy}
          title={`No claim activity in ${label.toLowerCase()}`}
          description="No signup-bonus claims in this window."
          compact
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="space-y-3">
          <SectionHeading icon={Trophy} title={`Top 25 by signup-bonus volume — ${label}`} />
          <div className="surface-sheen relative overflow-hidden rounded-2xl border bg-card p-4 sm:p-5">
            <p className="text-[11px] text-muted-foreground">
              Ranked by total claim volume in window. Lifetime deposit
              column shows whether top bonus recipients are real
              depositors or churning grinders.
            </p>

            {/* Mobile card list (<md) */}
            <div className="mt-3 space-y-1.5 md:hidden">
              {rows.map((r, i) => (
                <div
                  key={r.userId}
                  className="rounded-lg border bg-card px-3 py-2.5"
                >
                  <div className="flex items-center gap-2">
                    <span className="w-7 shrink-0 text-xs tabular-nums text-muted-foreground">
                      #{i + 1}
                    </span>
                    <Link
                      href={`/users/${r.userId}`}
                      className="truncate text-sm font-medium hover:underline"
                    >
                      {r.username ?? r.userId.slice(0, 8)}
                    </Link>
                    <span className="ml-auto shrink-0 font-mono text-[11px] uppercase text-muted-foreground">
                      {r.countryCode ?? "??"}
                    </span>
                  </div>
                  <div className="mt-1 grid grid-cols-2 gap-2 text-[11px] tabular-nums text-muted-foreground">
                    <span>
                      Claims: {formatNumber(r.claimCount)} · max{" "}
                      {formatCurrency(r.largestClaim)}
                    </span>
                    <span className="text-right">
                      Vol{" "}
                      <span className="text-rose-600 dark:text-rose-400">
                        {formatCurrency(r.claimVolume)}
                      </span>
                    </span>
                    <span>Signed up: {formatDate(r.signedUpAt)}</span>
                    <span className="text-right">
                      Deposits: {formatCurrency(r.depositTotal)}
                    </span>
                  </div>
                </div>
              ))}
            </div>

            {/* Desktop table (>=md) */}
            <div className="mt-3 hidden md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[50px]">Rank</TableHead>
                    <TableHead>User</TableHead>
                    <TableHead className="w-[64px]">Country</TableHead>
                    <TableHead>Signed up</TableHead>
                    <TableHead className="text-right">Claims</TableHead>
                    <TableHead className="text-right">Volume</TableHead>
                    <TableHead className="text-right">Largest</TableHead>
                    <TableHead className="text-right">First claim</TableHead>
                    <TableHead className="text-right">Last claim</TableHead>
                    <TableHead className="text-right">Deposits</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r, i) => (
                    <TableRow key={r.userId}>
                      <TableCell className="tabular-nums text-muted-foreground">
                        #{i + 1}
                      </TableCell>
                      <TableCell className="font-medium">
                        <Link
                          href={`/users/${r.userId}`}
                          className="hover:underline"
                        >
                          {r.username ?? r.userId.slice(0, 8)}
                        </Link>
                      </TableCell>
                      <TableCell className="font-mono text-xs uppercase text-muted-foreground">
                        {r.countryCode ?? "??"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatDate(r.signedUpAt)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatNumber(r.claimCount)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-rose-600 dark:text-rose-400">
                        {formatCurrency(r.claimVolume)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-rose-600 dark:text-rose-400">
                        {formatCurrency(r.largestClaim)}
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {formatDate(r.firstClaimAt)}
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {formatDate(r.lastClaimAt)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                        {formatCurrency(r.depositTotal)}
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
