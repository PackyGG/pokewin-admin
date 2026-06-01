import Link from "next/link";
import {
  ScrollText,
  ShieldCheck,
  Hash,
  Info,
  ArrowUpRight,
  ArrowDownRight,
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
import { formatCurrency, formatDateTime, formatNumber } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import { safeQuery } from "@/lib/errors/safe-query";
import {
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import {
  getBalanceAdjustmentAuditTrail,
  type AuditTrailRow,
} from "@/lib/queries/insights-balance-adjustments/audit-trail";

/**
 * Audit-trail (forensic) tab on /insights/balance-adjustments.
 *
 * Recent adjustments, newest first: timestamp, admin, target user, amount,
 * direction, reason. Capped at the query default (200 rows). Admin
 * attribution is stitched from the admin audit trail in code (see
 * audit-trail.ts) — exact for giveaway rows, best-effort otherwise.
 *
 * House-POV: credit (house gives) → rose; debit (house takes) → emerald.
 */
export async function AuditTab({
  period,
}: {
  period: InsightsRewardsPeriod;
}) {
  const res = await safeQuery(
    () => getBalanceAdjustmentAuditTrail(period),
    null,
    "insights-balance-adjustments.audit",
  );

  if (res.error || !res.data) {
    return (
      <TileErrorFallback
        label="Balance Adjustments — Audit trail"
        hint="The audit-trail query failed. Check server logs."
        size="panel"
      />
    );
  }
  const data = res.data;
  const label = insightsRewardsPeriodLabel(period);

  if (data.rows.length === 0) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <EmptyState
          icon={ScrollText}
          title={`No adjustments in ${label.toLowerCase()}`}
          description="No admin balance adjustments recorded for this window."
          compact
        />
      </div>
    );
  }

  const attributionRate =
    data.rows.length > 0 ? data.attributedCount / data.rows.length : 0;
  const showingCapped = data.totalInWindow > data.rows.length;

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <KpiTile
            label="Total in window"
            value={formatNumber(data.totalInWindow)}
            sub={showingCapped ? `showing latest ${formatNumber(data.rows.length)}` : "all shown"}
            icon={Hash}
            accent="blue"
          />
          <KpiTile
            label="Attributed to admin"
            value={`${(attributionRate * 100).toFixed(0)}%`}
            sub={`${formatNumber(data.attributedCount)} of ${formatNumber(data.rows.length)} shown`}
            icon={ShieldCheck}
            accent="cyan"
          />
          <KpiTile
            label="Shown"
            value={formatNumber(data.rows.length)}
            sub="newest first"
            icon={ScrollText}
            accent="purple"
          />
        </div>
      </FadeIn>

      <FadeIn>
        <div className="space-y-3">
          <SectionHeading icon={ScrollText} title={`Recent adjustments — ${label}`} />
          <div className="surface-sheen relative overflow-hidden rounded-2xl border bg-card p-4 sm:p-5">
            <AuditTrailTable rows={data.rows} />
          </div>
          <p className="flex items-start gap-1.5 px-1 text-[11px] text-muted-foreground">
            <Info className="mt-0.5 size-3 shrink-0" />
            Admin attribution is matched from the admin audit trail. Giveaway-
            tagged rows match exactly via ledger reference; other rows are
            matched by user + amount + time, so an &ldquo;unknown&rdquo; admin
            means no audit event could be matched within tolerance.
          </p>
        </div>
      </FadeIn>
    </div>
  );
}

function AuditTrailTable({ rows }: { rows: AuditTrailRow[] }) {
  return (
    <>
      {/* Mobile cards */}
      <div className="space-y-1.5 md:hidden">
        {rows.map((r) => (
          <div
            key={r.ledgerTxId}
            className="flex items-start gap-3 rounded-lg border bg-card px-3 py-2.5"
          >
            <div className="min-w-0 flex-1">
              <Link
                href={`/users/${r.user.userId}`}
                className="block truncate text-sm font-medium hover:underline"
              >
                {r.user.username ?? r.user.userId.slice(0, 8)}
              </Link>
              <p className="truncate text-[11px] text-muted-foreground">
                by {r.admin?.username ?? "unknown"} · {formatDateTime(r.createdAt)}
              </p>
              {r.reason && (
                <p className="truncate text-[11px] text-muted-foreground">
                  {r.reason}
                </p>
              )}
            </div>
            <div className="shrink-0 text-right">
              <p
                className={cn(
                  "text-sm font-medium tabular-nums",
                  r.direction === "credit"
                    ? "text-rose-600 dark:text-rose-400"
                    : "text-emerald-600 dark:text-emerald-400",
                )}
              >
                {r.direction === "credit" ? "+" : "−"}
                {formatCurrency(Math.abs(r.amount))}
              </p>
              {r.isManualWithdrawal && (
                <span className="text-[10px] text-muted-foreground">manual wd</span>
              )}
            </div>
          </div>
        ))}
      </div>
      {/* Desktop */}
      <div className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Admin</TableHead>
              <TableHead>User</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Direction</TableHead>
              <TableHead>Reason</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.ledgerTxId}>
                <TableCell className="whitespace-nowrap tabular-nums text-muted-foreground">
                  {formatDateTime(r.createdAt)}
                </TableCell>
                <TableCell className="font-medium">
                  {r.admin ? (
                    <span className="inline-flex items-center gap-1">
                      {r.admin.username ?? r.admin.adminUserId.slice(0, 8)}
                      {r.attributionExact && (
                        <span
                          className="size-1.5 rounded-full bg-cyan-500"
                          title="Exact attribution (ledger reference)"
                        />
                      )}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">unknown</span>
                  )}
                </TableCell>
                <TableCell className="font-medium">
                  <Link
                    href={`/users/${r.user.userId}`}
                    className="hover:underline"
                  >
                    {r.user.username ?? r.user.userId.slice(0, 8)}
                  </Link>
                </TableCell>
                <TableCell
                  className={cn(
                    "text-right tabular-nums font-medium",
                    r.direction === "credit"
                      ? "text-rose-600 dark:text-rose-400"
                      : "text-emerald-600 dark:text-emerald-400",
                  )}
                >
                  {r.direction === "credit" ? "+" : "−"}
                  {formatCurrency(Math.abs(r.amount))}
                </TableCell>
                <TableCell>
                  {r.direction === "credit" ? (
                    <Badge
                      variant="outline"
                      className="border-rose-500/30 text-rose-600 dark:text-rose-400"
                    >
                      <ArrowUpRight className="size-3" />
                      Credit
                    </Badge>
                  ) : (
                    <Badge
                      variant="outline"
                      className="border-emerald-500/30 text-emerald-600 dark:text-emerald-400"
                    >
                      <ArrowDownRight className="size-3" />
                      {r.isManualWithdrawal ? "Manual wd" : "Debit"}
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="max-w-[260px] truncate text-muted-foreground">
                  {r.reason ?? "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
