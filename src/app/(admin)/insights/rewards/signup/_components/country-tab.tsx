import { Globe2, Layers, Users } from "lucide-react";
import { SectionHeading } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { EmptyState } from "@/components/empty-state";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import {
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import { getSignupCountryBreakdown } from "@/lib/queries/insights-rewards/signup/country";
import { safeQuery } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";

/**
 * Country tab — top-15 countries by signup with per-country claim
 * rate, claim volume, avg per claim, 7d retention. Plus a continent
 * rollup above for the at-a-glance regional read.
 */
export async function CountryTab({
  period,
}: {
  period: InsightsRewardsPeriod;
}) {
  const { data, error } = await safeQuery(
    () => getSignupCountryBreakdown(period),
    null,
    "insights-rewards-signup.country",
  );
  if (error || !data) {
    return (
      <TileErrorFallback
        label="Signup — Country"
        hint="The country query failed. Server logs hold the digest."
        size="panel"
      />
    );
  }
  const label = insightsRewardsPeriodLabel(period);
  if (data.totalSignups === 0) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <EmptyState
          icon={Globe2}
          title={`No signups in ${label.toLowerCase()}`}
          description="No signups in this window so country breakdown is empty."
          compact
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Continent rollup */}
      <FadeIn>
        <div className="space-y-3">
          <SectionHeading icon={Layers} title="Continent rollup" />
          <div className="surface-sheen relative overflow-hidden rounded-2xl border bg-card p-4 sm:p-5">
            <p className="text-[11px] text-muted-foreground">
              `user.continent_code` rollup. Coarser than per-country
              but useful for the regional read.
            </p>
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {data.continents.map((c) => (
                <div
                  key={c.code}
                  className="rounded-lg border bg-muted/20 p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      {c.code}
                    </span>
                    <span className="text-[10px] tabular-nums text-blue-600 dark:text-blue-400">
                      {(c.claimRate * 100).toFixed(0)}%
                    </span>
                  </div>
                  <p className="mt-1 text-xl font-bold leading-tight tracking-tight tabular-nums">
                    {formatNumber(c.signups)}
                  </p>
                  <p className="text-[10px] text-muted-foreground">
                    {formatNumber(c.claimants)} claimed
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </FadeIn>

      {/* Per-country list */}
      <FadeIn>
        <div className="space-y-3">
          <SectionHeading icon={Globe2} title={`Top 15 countries — ${label}`} />
          <div className="surface-sheen relative overflow-hidden rounded-2xl border bg-card p-4 sm:p-5">
            {/* Horizontal-scroll wrapper mirrors the sibling cohort /
                heatmap tabs: the 5 fixed metric columns (≈396px with
                gaps) would otherwise crush the share bar to zero and
                crowd the row below ~400px. Scrolling keeps every column
                at its intended width on phones instead. */}
            <div className="overflow-x-auto">
              <div className="inline-block min-w-full">
                <div className="grid grid-cols-[44px_minmax(120px,1fr)_72px_64px_96px_64px] items-center gap-2 px-2 pb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  <span>Code</span>
                  <span>Share bar</span>
                  <span className="text-right">Signups</span>
                  <span className="text-right">Claim %</span>
                  <span className="text-right">Volume</span>
                  <span className="text-right">Ret 7d</span>
                </div>
                <div className="space-y-1.5">
                  {data.countries.map((c) => (
                    <div
                      key={c.code}
                      className="grid grid-cols-[44px_minmax(120px,1fr)_72px_64px_96px_64px] items-center gap-2 rounded-lg border bg-muted/20 px-2 py-2"
                    >
                      <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                        {c.code}
                      </span>
                      <div className="h-2 overflow-hidden rounded-sm bg-muted">
                        <div
                          className="h-full bg-blue-500/60 transition-all"
                          style={{
                            width: `${data.totalSignups > 0 ? (c.signups / data.totalSignups) * 100 : 0}%`,
                          }}
                        />
                      </div>
                      <span className="text-right text-sm tabular-nums">
                        {formatNumber(c.signups)}
                      </span>
                      <span className="text-right text-sm tabular-nums text-blue-600 dark:text-blue-400">
                        {(c.claimRate * 100).toFixed(1)}%
                      </span>
                      <span className="text-right text-sm tabular-nums text-rose-600 dark:text-rose-400">
                        {formatCurrency(c.claimVolume)}
                      </span>
                      <span className="text-right text-sm tabular-nums">
                        {c.retention7dShare === null
                          ? "—"
                          : `${(c.retention7dShare * 100).toFixed(0)}%`}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <div className="mt-3 flex items-center gap-2 text-[11px] text-muted-foreground">
              <Users className="size-3.5" />
              <span>
                {formatNumber(data.totalSignups)} signups · &ldquo;??&rdquo; = country code missing
              </span>
            </div>
          </div>
        </div>
      </FadeIn>
    </div>
  );
}
