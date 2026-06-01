import Link from "next/link";
import {
  TrendingUp,
  TrendingDown,
  Users,
  Repeat,
  AlertTriangle,
} from "lucide-react";
import { SectionHeading } from "@/components/modern-panels";
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
import {
  formatCurrency,
  formatNumber,
  formatRelative,
} from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import { safeQuery } from "@/lib/errors/safe-query";
import {
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import {
  getBalanceAdjustmentByUser,
  type UserAdjustmentRow,
} from "@/lib/queries/insights-balance-adjustments/by-user";

/**
 * By-User tab on /insights/balance-adjustments.
 *
 *   - Top users RECEIVING credits (house gave them money) → rose.
 *   - Top users DEBITED (house took back, incl. manual withdrawals) →
 *     emerald.
 *   - High-frequency users — many adjustment events in the window (anomaly
 *     surveillance).
 *
 * Each user links to /users/[id].
 */
export async function UsersTab({
  period,
}: {
  period: InsightsRewardsPeriod;
}) {
  const res = await safeQuery(
    () => getBalanceAdjustmentByUser(period),
    null,
    "insights-balance-adjustments.by-user",
  );

  if (res.error || !res.data) {
    return (
      <TileErrorFallback
        label="Balance Adjustments — By User"
        hint="The by-user query failed. Check server logs."
        size="panel"
      />
    );
  }
  const data = res.data;
  const label = insightsRewardsPeriodLabel(period);

  if (data.topCredited.length === 0 && data.topDebited.length === 0) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <EmptyState
          icon={Users}
          title={`No adjusted users in ${label.toLowerCase()}`}
          description="No users received or were debited by an admin adjustment in this window."
          compact
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-4 xl:grid-cols-2">
        {/* Top credited */}
        <FadeIn>
          <div className="space-y-3">
            <SectionHeading icon={TrendingUp} title="Top credited (house pays)" />
            <div className="surface-sheen relative overflow-hidden rounded-2xl border border-rose-500/20 bg-rose-500/[0.04] p-4 sm:p-5">
              {data.topCredited.length > 0 ? (
                <UserTable rows={data.topCredited} metric="credit" />
              ) : (
                <EmptyState
                  icon={TrendingUp}
                  title="No credits in window"
                  description="No user received an admin credit."
                  compact
                />
              )}
            </div>
          </div>
        </FadeIn>

        {/* Top debited */}
        <FadeIn>
          <div className="space-y-3">
            <SectionHeading icon={TrendingDown} title="Top debited (house takes)" />
            <div className="surface-sheen relative overflow-hidden rounded-2xl border border-emerald-500/20 bg-emerald-500/[0.04] p-4 sm:p-5">
              {data.topDebited.length > 0 ? (
                <UserTable rows={data.topDebited} metric="debit" />
              ) : (
                <EmptyState
                  icon={TrendingDown}
                  title="No debits in window"
                  description="No user was debited by an admin in this window."
                  compact
                />
              )}
            </div>
          </div>
        </FadeIn>
      </div>

      {/* High-frequency */}
      <FadeIn>
        <div className="space-y-3">
          <SectionHeading
            icon={Repeat}
            title="High-frequency users (5+ adjustments)"
          />
          <div className="surface-sheen relative overflow-hidden rounded-2xl border border-amber-500/20 bg-amber-500/[0.04] p-4 sm:p-5">
            {data.highFrequency.length > 0 ? (
              <FrequencyTable rows={data.highFrequency} />
            ) : (
              <EmptyState
                icon={Repeat}
                title="No abnormal frequency"
                description="No user received 5+ admin adjustments in this window."
                compact
              />
            )}
          </div>
        </div>
      </FadeIn>
    </div>
  );
}

// ─── Top credited / debited table ──────────────────────────────────

function UserTable({
  rows,
  metric,
}: {
  rows: UserAdjustmentRow[];
  metric: "credit" | "debit";
}) {
  const isCredit = metric === "credit";
  const amountClass = isCredit
    ? "text-rose-600 dark:text-rose-400"
    : "text-emerald-600 dark:text-emerald-400";
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[50px]">#</TableHead>
          <TableHead>User</TableHead>
          <TableHead className="text-right">
            {isCredit ? "Credited" : "Debited"}
          </TableHead>
          <TableHead className="text-right">Count</TableHead>
          <TableHead className="text-right">Net</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r, i) => (
          <TableRow key={r.userId}>
            <TableCell className="tabular-nums text-muted-foreground">
              #{i + 1}
            </TableCell>
            <TableCell className="font-medium">
              <Link href={`/users/${r.userId}`} className="hover:underline">
                {r.username ?? r.userId.slice(0, 8)}
              </Link>
            </TableCell>
            <TableCell className={cn("text-right tabular-nums font-medium", amountClass)}>
              {formatCurrency(isCredit ? r.creditVolume : r.debitVolume)}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {formatNumber(r.count)}
            </TableCell>
            <TableCell
              className={cn(
                "text-right tabular-nums",
                r.net >= 0
                  ? "text-rose-600 dark:text-rose-400"
                  : "text-emerald-600 dark:text-emerald-400",
              )}
            >
              {r.net >= 0 ? "+" : "−"}
              {formatCurrency(Math.abs(r.net))}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// ─── High-frequency table ──────────────────────────────────────────

function FrequencyTable({ rows }: { rows: UserAdjustmentRow[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>User</TableHead>
          <TableHead className="text-right">Adjustments</TableHead>
          <TableHead className="text-right">Credited</TableHead>
          <TableHead className="text-right">Debited</TableHead>
          <TableHead className="text-right">Net</TableHead>
          <TableHead>Last</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.userId}>
            <TableCell className="font-medium">
              <Link href={`/users/${r.userId}`} className="hover:underline">
                {r.username ?? r.userId.slice(0, 8)}
              </Link>
            </TableCell>
            <TableCell className="text-right tabular-nums">
              <span className="inline-flex items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-600 dark:text-amber-400">
                <AlertTriangle className="size-3" />
                {formatNumber(r.count)}
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
            <TableCell className="tabular-nums text-muted-foreground">
              {formatRelative(r.lastAt)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
