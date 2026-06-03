import {
  TrendingUp,
  TrendingDown,
  Tags,
  BarChart3,
  ArrowDownToLine,
} from "lucide-react";
import { SectionHeading, KpiTile } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { EmptyState } from "@/components/empty-state";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import {
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import {
  getBalanceAdjustmentDirectionReason,
  type AdjustmentReasonRow,
} from "@/lib/queries/insights-balance-adjustments/direction-reason";
import { AdjustmentSizeHistogram } from "./size-histogram";

/**
 * Direction & Reason tab on /insights/balance-adjustments.
 *
 * Credit vs debit split + reason breakdown (recovered from the ledger
 * description prefix) + adjustment-size distribution.
 *
 * House-POV: credits (house gives) → rose; debits (house takes) → emerald.
 */
export async function DirectionTab({
  period,
}: {
  period: InsightsRewardsPeriod;
}) {
  const res = await safeQuery(
    () => getBalanceAdjustmentDirectionReason(period),
    null,
    "insights-balance-adjustments.direction",
    REWARD_QUERY_TIMEOUT_MS,
  );

  if (res.error || !res.data) {
    return (
      <TileErrorFallback
        label="Balance Adjustments — Direction & Reason"
        hint="The direction/reason query failed. Check server logs."
        size="panel"
      />
    );
  }
  const data = res.data;
  const label = insightsRewardsPeriodLabel(period);
  const total = data.creditCount + data.debitCount;

  if (total === 0) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <EmptyState
          icon={Tags}
          title={`No adjustments in ${label.toLowerCase()}`}
          description="Nothing to break down for this window."
          compact
        />
      </div>
    );
  }

  const grossVol = data.creditVolume + data.debitVolume;
  const creditShare = grossVol > 0 ? data.creditVolume / grossVol : 0;

  return (
    <div className="space-y-6">
      {/* Direction split */}
      <FadeIn>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <KpiTile
            label="Credit volume"
            value={formatCurrency(data.creditVolume)}
            sub={`${formatNumber(data.creditCount)} rows · ${(creditShare * 100).toFixed(0)}% of $`}
            icon={TrendingUp}
            accent="rose"
          />
          <KpiTile
            label="Debit volume"
            value={formatCurrency(data.debitVolume)}
            sub={`${formatNumber(data.debitCount)} rows · ${((1 - creditShare) * 100).toFixed(0)}% of $`}
            icon={TrendingDown}
            accent="emerald"
          />
          <KpiTile
            label="Net to users"
            value={`${data.creditVolume - data.debitVolume >= 0 ? "+" : "−"}${formatCurrency(Math.abs(data.creditVolume - data.debitVolume))}`}
            sub="credits − debits"
            icon={ArrowDownToLine}
            accent={data.creditVolume - data.debitVolume >= 0 ? "rose" : "emerald"}
          />
          <KpiTile
            label="Reasons tracked"
            value={formatNumber(data.reasons.length)}
            sub="distinct reason labels"
            icon={Tags}
            accent="blue"
          />
        </div>
      </FadeIn>

      {/* Reason breakdown */}
      <FadeIn>
        <div className="space-y-3">
          <SectionHeading icon={Tags} title={`Reasons — ${label}`} />
          <div className="surface-sheen relative overflow-hidden rounded-2xl border bg-card p-4 sm:p-5">
            {data.reasons.length > 0 ? (
              <ReasonTable rows={data.reasons} />
            ) : (
              <EmptyState
                icon={Tags}
                title="No reasons recorded"
                description="No reason text on the adjustments in this window."
                compact
              />
            )}
          </div>
        </div>
      </FadeIn>

      {/* Size distribution */}
      <FadeIn>
        <div className="surface-sheen surface-raise relative overflow-hidden rounded-2xl border bg-gradient-to-br from-card via-card to-card/70 p-4 sm:p-5">
          <div
            aria-hidden
            className="pointer-events-none absolute -right-12 -top-12 size-32 rounded-full bg-purple-500/[0.08] blur-2xl"
          />
          <div className="relative">
            <SectionHeading
              icon={BarChart3}
              title={`Adjustment size distribution — ${label}`}
            />
            <div className="mt-3">
              <AdjustmentSizeHistogram
                buckets={data.sizeBuckets.map((b) => ({
                  label: b.label,
                  count: b.count,
                }))}
              />
            </div>
          </div>
        </div>
      </FadeIn>
    </div>
  );
}

// ─── Reason table ───────────────────────────────────────────────────

function ReasonTable({ rows }: { rows: AdjustmentReasonRow[] }) {
  return (
    <>
      {/* Mobile cards */}
      <div className="space-y-1.5 md:hidden">
        {rows.map((r) => (
          <div
            key={r.reason}
            className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <p className="truncate text-sm font-medium">{r.reason}</p>
                {r.isManualWithdrawal && (
                  <Badge variant="outline" className="shrink-0 text-[10px]">
                    manual wd
                  </Badge>
                )}
              </div>
              <p className="text-[11px] tabular-nums text-muted-foreground">
                {formatNumber(r.count)}× · {formatNumber(r.uniqueUsers)} users
              </p>
            </div>
            <div className="shrink-0 text-right">
              <p
                className={cn(
                  "text-sm font-medium tabular-nums",
                  r.net >= 0
                    ? "text-rose-600 dark:text-rose-400"
                    : "text-emerald-600 dark:text-emerald-400",
                )}
              >
                {r.net >= 0 ? "+" : "−"}
                {formatCurrency(Math.abs(r.net))}
              </p>
            </div>
          </div>
        ))}
      </div>
      {/* Desktop */}
      <div className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Reason</TableHead>
              <TableHead className="text-right">Credit $</TableHead>
              <TableHead className="text-right">Debit $</TableHead>
              <TableHead className="text-right">Net</TableHead>
              <TableHead className="text-right">Count</TableHead>
              <TableHead className="text-right">Users</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.reason}>
                <TableCell className="font-medium">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate">{r.reason}</span>
                    {r.isManualWithdrawal && (
                      <Badge variant="outline" className="shrink-0 text-[10px]">
                        manual wd
                      </Badge>
                    )}
                  </span>
                </TableCell>
                <TableCell className="text-right tabular-nums text-rose-600 dark:text-rose-400">
                  {r.creditVolume > 0 ? formatCurrency(r.creditVolume) : "—"}
                </TableCell>
                <TableCell className="text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                  {r.debitVolume > 0 ? formatCurrency(r.debitVolume) : "—"}
                </TableCell>
                <TableCell
                  className={cn(
                    "text-right tabular-nums font-medium",
                    r.net >= 0
                      ? "text-rose-600 dark:text-rose-400"
                      : "text-emerald-600 dark:text-emerald-400",
                  )}
                >
                  {r.net >= 0 ? "+" : "−"}
                  {formatCurrency(Math.abs(r.net))}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatNumber(r.count)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {formatNumber(r.uniqueUsers)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
