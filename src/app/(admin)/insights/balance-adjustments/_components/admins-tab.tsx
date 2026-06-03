import { ShieldCheck, Coins, Hash, Info } from "lucide-react";
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
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import {
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import {
  getBalanceAdjustmentByAdmin,
  type AdminAdjustmentRow,
} from "@/lib/queries/insights-balance-adjustments/by-admin";

/**
 * By-Admin accountability tab on /insights/balance-adjustments.
 *
 * Which admin handed out / clawed back how much. Sourced from the admin-
 * DB audit trail (the only record of admin attribution — see by-admin.ts).
 *
 * House-POV: total volume moved → rose (mostly payouts). Net credit → rose;
 * net debit → emerald.
 */
export async function AdminsTab({
  period,
}: {
  period: InsightsRewardsPeriod;
}) {
  const res = await safeQuery(
    () => getBalanceAdjustmentByAdmin(period),
    [],
    "insights-balance-adjustments.by-admin",
    REWARD_QUERY_TIMEOUT_MS,
  );

  if (res.error) {
    return (
      <TileErrorFallback
        label="Balance Adjustments — By Admin"
        hint="The by-admin query failed. Check server logs."
        size="panel"
      />
    );
  }
  const admins = res.data;
  const label = insightsRewardsPeriodLabel(period);

  if (admins.length === 0) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <EmptyState
          icon={ShieldCheck}
          title={`No admin adjustments in ${label.toLowerCase()}`}
          description="No balance-adjustment audit events for this window."
          compact
        />
      </div>
    );
  }

  const totalGross = admins.reduce((s, a) => s + a.grossVolume, 0);
  const totalCount = admins.reduce((s, a) => s + a.count, 0);

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <KpiTile
            label="Admins adjusting"
            value={formatNumber(admins.length)}
            sub="distinct actors in window"
            icon={ShieldCheck}
            accent="cyan"
          />
          <KpiTile
            label="Total moved"
            value={formatCurrency(totalGross)}
            sub="gross magnitude (all admins)"
            icon={Coins}
            accent="rose"
          />
          <KpiTile
            label="Total events"
            value={formatNumber(totalCount)}
            sub="audit events"
            icon={Hash}
            accent="blue"
          />
          <KpiTile
            label="Avg / admin"
            value={formatCurrency(admins.length > 0 ? totalGross / admins.length : 0)}
            sub="gross $ per admin"
            icon={Coins}
            accent="amber"
          />
        </div>
      </FadeIn>

      <FadeIn>
        <div className="space-y-3">
          <SectionHeading icon={ShieldCheck} title={`Top adjusters — ${label}`} />
          <div className="surface-sheen relative overflow-hidden rounded-2xl border bg-card p-4 sm:p-5">
            <AdminTable rows={admins} />
          </div>
          <p className="flex items-start gap-1.5 px-1 text-[11px] text-muted-foreground">
            <Info className="mt-0.5 size-3 shrink-0" />
            Admin attribution comes from the admin audit trail
            (admin_audit_events), the canonical record of who performed each
            adjustment. Manual withdrawals are counted as debits.
          </p>
        </div>
      </FadeIn>
    </div>
  );
}

function AdminTable({ rows }: { rows: AdminAdjustmentRow[] }) {
  return (
    <>
      {/* Mobile cards */}
      <div className="space-y-1.5 md:hidden">
        {rows.map((r, i) => (
          <div
            key={r.adminUserId}
            className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5"
          >
            <span className="w-7 shrink-0 text-xs tabular-nums text-muted-foreground">
              #{i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {r.displayUsername ?? r.username ?? r.adminUserId.slice(0, 8)}
              </p>
              <p className="text-[11px] tabular-nums text-muted-foreground">
                {formatNumber(r.count)}× · {formatNumber(r.uniqueUsers)} users
              </p>
            </div>
            <div className="shrink-0 text-right">
              <p className="text-sm font-medium tabular-nums text-rose-600 dark:text-rose-400">
                {formatCurrency(r.grossVolume)}
              </p>
              <p
                className={cn(
                  "text-[10px] tabular-nums",
                  r.net >= 0
                    ? "text-rose-600 dark:text-rose-400"
                    : "text-emerald-600 dark:text-emerald-400",
                )}
              >
                net {r.net >= 0 ? "+" : "−"}
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
              <TableHead className="w-[50px]">Rank</TableHead>
              <TableHead>Admin</TableHead>
              <TableHead className="text-right">Gross moved</TableHead>
              <TableHead className="text-right">Credits</TableHead>
              <TableHead className="text-right">Debits</TableHead>
              <TableHead className="text-right">Net</TableHead>
              <TableHead className="text-right">Events</TableHead>
              <TableHead className="text-right">Users</TableHead>
              <TableHead className="text-right">Avg</TableHead>
              <TableHead className="text-right">Max</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r, i) => (
              <TableRow key={r.adminUserId}>
                <TableCell className="tabular-nums text-muted-foreground">
                  #{i + 1}
                </TableCell>
                <TableCell className="font-medium">
                  {r.displayUsername ?? r.username ?? r.adminUserId.slice(0, 8)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-rose-600 dark:text-rose-400">
                  {formatCurrency(r.grossVolume)}
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
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {formatCurrency(r.avgSize)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {formatCurrency(r.maxSize)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
