import Link from "next/link";
import { UserMinus, TrendingDown, Users, AlertTriangle } from "lucide-react";
import { SectionHeading, KpiTile, StatPanel, PanelRow } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { EmptyState } from "@/components/empty-state";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { safeQuery } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { getRakebackLapsed, type RakebackLapsedReason } from "@/lib/queries/insights-rewards/rakeback/lapsed";
import { compareRakebackLapsed } from "@/lib/clickhouse/compare/insights-rakeback-lapsed";
import { type InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";

/**
 * Lapsed claimants tab. Users who claimed in the prior-equal window but
 * NOT in the current window. Each row is classified by why they may
 * have stopped:
 *
 *   - churned       no deposit and no wager in the current window
 *   - less_active   wager dropped > 25% vs prior
 *   - still_active  wager is similar or higher — config / UX issue,
 *                   not disengagement
 *
 * Lifetime windows have no prior frame → empty-state.
 *
 * House-POV: lapsed rakeback is COST we no longer have to pay → not
 * automatically a "loss" for the house. We surface it as rose (still
 * "rakeback events") so the colour family stays consistent with the
 * rest of the page, but the framing in copy is "lost claims" rather
 * than "money lost".
 */
export async function LapsedTab({
  period,
}: {
  period: InsightsRewardsPeriod;
}) {
  const lapsedRes = await safeQuery(
    () => getRakebackLapsed(period),
    null,
    "insights-rewards-rakeback.lapsed",
  );
  if (lapsedRes.error || !lapsedRes.data) {
    if (lapsedRes.error) {
      return (
        <TileErrorFallback
          label="Rakeback — Lapsed claimants"
          hint="The lapsed-claimants query failed."
          size="panel"
        />
      );
    }
    return (
      <div className="rounded-2xl border bg-card p-4">
        <EmptyState
          icon={UserMinus}
          title="Lapsed view not defined for All time"
          description="Pick a finite period (24h / 3d / 7d / 30d / 90d) — lapsed claimants are users who were active in the prior-equal window."
          compact
        />
      </div>
    );
  }
  const data = lapsedRes.data;
  void compareRakebackLapsed(period, data);
  if (data.totalLapsedUsers === 0) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <EmptyState
          icon={UserMinus}
          title="No lapsed claimants"
          description="Every claimant from the prior-equal window also claimed in the current window."
          compact
        />
      </div>
    );
  }

  const totalReasons =
    data.reasons.churned + data.reasons.lessActive + data.reasons.stillActive;
  const reasonShare = (n: number) =>
    totalReasons > 0 ? (n / totalReasons) * 100 : 0;

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <KpiTile
            label="Lapsed claimants"
            value={formatNumber(data.totalLapsedUsers)}
            sub="Prior window only"
            icon={UserMinus}
            accent="rose"
          />
          <KpiTile
            label="Lost claims (USD)"
            value={formatCurrency(data.totalLostRakeback)}
            sub="Prior-window rakeback total"
            icon={TrendingDown}
            accent="rose"
          />
          <KpiTile
            label="Churned share"
            value={`${reasonShare(data.reasons.churned).toFixed(0)}%`}
            sub={`${formatNumber(data.reasons.churned)} users`}
            icon={AlertTriangle}
            accent="rose"
          />
          <KpiTile
            label="Still active share"
            value={`${reasonShare(data.reasons.stillActive).toFixed(0)}%`}
            sub={`${formatNumber(data.reasons.stillActive)} users not claiming`}
            icon={Users}
            accent="blue"
          />
        </div>
      </FadeIn>

      <FadeIn>
        <div className="grid gap-3 sm:grid-cols-3">
          <StatPanel title="Churned" icon={UserMinus} accent="rose">
            <p className="text-2xl font-bold leading-tight tracking-tight tabular-nums text-rose-600 dark:text-rose-400 sm:text-3xl">
              {formatNumber(data.reasons.churned)}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              No deposit + no wager in current window
            </p>
            <div className="mt-3 space-y-0.5 border-t pt-3 text-sm">
              <PanelRow
                label="Share of lapsed"
                value={`${reasonShare(data.reasons.churned).toFixed(1)}%`}
              />
            </div>
          </StatPanel>
          <StatPanel title="Less active" icon={TrendingDown} accent="rose">
            <p className="text-2xl font-bold leading-tight tracking-tight tabular-nums text-rose-600 dark:text-rose-400 sm:text-3xl">
              {formatNumber(data.reasons.lessActive)}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Wager dropped &gt; 25% vs prior
            </p>
            <div className="mt-3 space-y-0.5 border-t pt-3 text-sm">
              <PanelRow
                label="Share of lapsed"
                value={`${reasonShare(data.reasons.lessActive).toFixed(1)}%`}
              />
            </div>
          </StatPanel>
          <StatPanel title="Still active" icon={Users} accent="blue">
            <p className="text-2xl font-bold leading-tight tracking-tight tabular-nums text-blue-600 dark:text-blue-400 sm:text-3xl">
              {formatNumber(data.reasons.stillActive)}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Similar wager — likely config / UX issue
            </p>
            <div className="mt-3 space-y-0.5 border-t pt-3 text-sm">
              <PanelRow
                label="Share of lapsed"
                value={`${reasonShare(data.reasons.stillActive).toFixed(1)}%`}
              />
            </div>
          </StatPanel>
        </div>
      </FadeIn>

      <FadeIn>
        <SectionHeading
          icon={UserMinus}
          title="Top 25 lapsed by prior rakeback"
        />
        <div className="mt-3 overflow-hidden rounded-2xl border bg-card">
          <div className="max-h-[34rem] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-card text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                <tr className="border-b border-border/40">
                  <th className="px-4 py-2 text-left sm:px-5">User</th>
                  <th className="px-3 py-2 text-right">Prior rakeback</th>
                  <th className="px-3 py-2 text-right">Prior claims</th>
                  <th className="px-3 py-2 text-right">Current wager</th>
                  <th className="px-3 py-2 text-right">Prior wager</th>
                  <th className="px-3 py-2 text-right">Current deposit</th>
                  <th className="px-3 py-2 text-center">Reason</th>
                </tr>
              </thead>
              <tbody>
                {data.sampleUsers.map((u) => (
                  <tr
                    key={u.userId}
                    className="border-t border-border/40 hover:bg-muted/30"
                  >
                    <td className="px-4 py-2 sm:px-5">
                      <Link
                        href={`/users/${u.userId}`}
                        className="truncate text-foreground hover:underline"
                      >
                        {u.username ?? u.userId.slice(0, 10)}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-rose-600 dark:text-rose-400">
                      {formatCurrency(u.priorRakeback)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatNumber(u.priorClaims)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatCurrency(u.currentWager)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                      {formatCurrency(u.priorWager)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatCurrency(u.currentDeposit)}
                    </td>
                    <td className="px-3 py-2 text-center">
                      <ReasonBadge reason={u.reason} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </FadeIn>
    </div>
  );
}

function ReasonBadge({ reason }: { reason: RakebackLapsedReason }) {
  const label =
    reason === "churned"
      ? "Churned"
      : reason === "less_active"
        ? "Less active"
        : "Still active";
  const cls =
    reason === "churned"
      ? "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30"
      : reason === "less_active"
        ? "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30"
        : "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30";
  return (
    <span
      className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-medium ${cls}`}
    >
      {label}
    </span>
  );
}
