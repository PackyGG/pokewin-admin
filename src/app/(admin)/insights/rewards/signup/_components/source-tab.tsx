import {
  Network,
  Users,
  UserPlus,
  Tag,
  TrendingUp,
  Sparkles,
} from "lucide-react";
import { SectionHeading } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { EmptyState } from "@/components/empty-state";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import {
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import {
  getSignupSourceBreakdown,
  type SignupSourceRow,
} from "@/lib/queries/insights-rewards/signup/source";
import { safeQuery } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";

/**
 * Source tab — two breakdowns:
 *
 *   1. Auth provider (`account.providerId`) — Discord / Google / …
 *   2. Affiliate code at signup (`user.affiliate_code`) — "Direct"
 *      bucket for users with no code
 *
 * Each row carries signups, claimants, claim rate, avg per claim,
 * total claim cost, 7d retention share. Sorted by signup count.
 */
export async function SourceTab({
  period,
}: {
  period: InsightsRewardsPeriod;
}) {
  const { data, error } = await safeQuery(
    () => getSignupSourceBreakdown(period),
    null,
    "insights-rewards-signup.source",
  );
  if (error || !data) {
    return (
      <TileErrorFallback
        label="Signup — Source"
        hint="The source query failed. Server logs hold the digest."
        size="panel"
      />
    );
  }
  const label = insightsRewardsPeriodLabel(period);
  if (data.totalSignups === 0) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <EmptyState
          icon={Network}
          title={`No signups in ${label.toLowerCase()}`}
          description="No signups in this window so source attribution is empty."
          compact
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="grid gap-4 xl:grid-cols-2">
          <SourcePanel
            icon={Users}
            title="By auth provider"
            description="Primary `account.providerId` per signup (earliest account row)."
            rows={data.providers}
            totalSignups={data.totalSignups}
            keyLabel="Provider"
          />
          <SourcePanel
            icon={Tag}
            title="By affiliate code"
            description="`user.affiliate_code` at signup. NULL → Direct."
            rows={data.affiliates}
            totalSignups={data.totalSignups}
            keyLabel="Code"
          />
        </div>
      </FadeIn>
    </div>
  );
}

function SourcePanel({
  icon: Icon,
  title,
  description,
  rows,
  totalSignups,
  keyLabel,
}: {
  icon: React.ElementType;
  title: string;
  description: string;
  rows: SignupSourceRow[];
  totalSignups: number;
  keyLabel: string;
}) {
  return (
    <div className="space-y-3">
      <SectionHeading icon={Icon} title={title} />
      <div className="surface-sheen relative overflow-hidden rounded-2xl border bg-card p-4 sm:p-5">
        <p className="text-[11px] text-muted-foreground">{description}</p>
        {rows.length === 0 ? (
          <div className="mt-3 text-xs text-muted-foreground">
            No rows.
          </div>
        ) : (
          <div className="mt-3 space-y-2">
            {/* Header row */}
            <div className="grid grid-cols-[minmax(0,1fr)_56px_64px_72px_64px] items-center gap-2 px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              <span>{keyLabel}</span>
              <span className="text-right">Signups</span>
              <span className="text-right">Claim %</span>
              <span className="text-right">Avg</span>
              <span className="text-right">Ret 7d</span>
            </div>
            {rows.map((r) => {
              const share =
                totalSignups > 0 ? (r.signups / totalSignups) * 100 : 0;
              return (
                <div
                  key={r.key}
                  className="grid grid-cols-[minmax(0,1fr)_56px_64px_72px_64px] items-center gap-2 rounded-lg border bg-muted/20 p-3"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm font-medium capitalize">
                      {r.label}
                    </span>
                    <span className="shrink-0 rounded-sm bg-muted px-1 py-0.5 text-[10px] tabular-nums text-muted-foreground">
                      {share.toFixed(0)}%
                    </span>
                  </div>
                  <span className="text-right text-sm tabular-nums">
                    {formatNumber(r.signups)}
                  </span>
                  <span className="text-right text-sm tabular-nums text-blue-600 dark:text-blue-400">
                    {(r.claimRate * 100).toFixed(1)}%
                  </span>
                  <span className="text-right text-sm tabular-nums text-rose-600 dark:text-rose-400">
                    {r.claimants > 0
                      ? formatCurrency(r.avgPerClaim)
                      : "—"}
                  </span>
                  <span className="text-right text-sm tabular-nums">
                    {r.retention7dShare === null
                      ? "—"
                      : `${(r.retention7dShare * 100).toFixed(0)}%`}
                  </span>
                </div>
              );
            })}
            {/* Sub-line breakdown */}
            <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              <SubStat
                icon={UserPlus}
                label="Total signups"
                value={formatNumber(rows.reduce((a, r) => a + r.signups, 0))}
              />
              <SubStat
                icon={Sparkles}
                label="Total claimants"
                value={formatNumber(rows.reduce((a, r) => a + r.claimants, 0))}
              />
              <SubStat
                icon={TrendingUp}
                label="Top source share"
                value={
                  rows[0]
                    ? `${((rows[0].signups / totalSignups) * 100).toFixed(1)}%`
                    : "—"
                }
              />
              <SubStat
                icon={TrendingUp}
                label="Top claim rate"
                value={(() => {
                  const cand = rows.filter((r) => r.signups >= 10);
                  if (cand.length === 0) return "—";
                  const best = cand.reduce((a, b) =>
                    b.claimRate > a.claimRate ? b : a,
                  );
                  return `${(best.claimRate * 100).toFixed(1)}% · ${best.label}`;
                })()}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function SubStat({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg border bg-muted/20 p-2">
      <Icon className="size-3.5 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[10px] uppercase tracking-wider text-muted-foreground">
          {label}
        </p>
        <p className="truncate text-xs font-medium tabular-nums">{value}</p>
      </div>
    </div>
  );
}
