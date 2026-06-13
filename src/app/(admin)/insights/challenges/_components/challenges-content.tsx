import {
  TrendingDown,
  Trophy,
  Target,
  CheckCircle2,
  Sigma,
  Percent,
  Hash,
  LineChart as LineChartIcon,
  ListChecks,
} from "lucide-react";
import { KpiTile, SectionHeading } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { EmptyState } from "@/components/empty-state";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { safeQuery } from "@/lib/errors/safe-query";
import {
  getChallengesOverview,
  challengesPeriodLabel,
  type ChallengesPeriod,
} from "@/lib/queries/insights-challenges";
import { ChallengesCostChart } from "./cost-chart";
import { ChallengesTable } from "./challenges-table";

/**
 * Body of /insights/challenges. Loads the overview aggregate, then renders
 * the KPI strip, the period-scoped daily-cost chart, and the current-state
 * per-challenge table. House-POV: challenge prizes flow OUT to users → rose;
 * counts / rates are neutral blue / cyan.
 */
export async function ChallengesContent({
  period,
}: {
  period: ChallengesPeriod;
}) {
  const res = await safeQuery(
    () => getChallengesOverview(period),
    null,
    "insights-challenges.overview",
    15_000,
  );

  if (res.error || !res.data) {
    return (
      <TileErrorFallback
        label="Challenges — Overview"
        hint="The challenges overview query failed. Server logs hold the digest."
        size="panel"
      />
    );
  }

  const data = res.data;
  const label = challengesPeriodLabel(period);

  // Drift-guard: tables absent on an un-migrated DB → muted "not available".
  if (!data.available) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <EmptyState
          icon={Trophy}
          title="Challenges not available on this database"
          description="The challenge tables are not present on the connected database. Switch to a database where the challenge feature has been provisioned."
          compact
        />
      </div>
    );
  }

  const completionPct = Math.round(data.overallCompletionRate * 100);

  return (
    <div className="space-y-6">
      {/* ── KPI strip ─────────────────────────────────────────────── */}
      <FadeIn>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <KpiTile
            label="Total prize cost"
            value={formatCurrency(data.totalPrizeCost)}
            sub={`${formatNumber(data.prizeLineCount)} prize lines · ${label}`}
            icon={TrendingDown}
            accent="rose"
          />
          <KpiTile
            label="Total challenges"
            value={formatNumber(data.totalChallenges)}
            sub="All time"
            icon={Target}
            accent="blue"
          />
          <KpiTile
            label="Active challenges"
            value={formatNumber(data.activeChallenges)}
            sub="Currently live"
            icon={CheckCircle2}
            accent="cyan"
          />
          <KpiTile
            label="Total claims"
            value={formatNumber(data.totalClaims)}
            sub="Claimed prizes"
            icon={Hash}
            accent="blue"
          />
          <KpiTile
            label="Avg claims / challenge"
            value={data.avgClaimsPerChallenge.toFixed(2)}
            sub="Claims / challenge count"
            icon={Sigma}
            accent="cyan"
          />
          <KpiTile
            label="Completion rate"
            value={`${completionPct}%`}
            sub="Σ claimed / Σ max claims"
            icon={Percent}
            accent="blue"
          />
        </div>
      </FadeIn>

      {/* ── Daily cost chart (period-scoped) ──────────────────────── */}
      <FadeIn>
        <div className="surface-sheen surface-raise relative overflow-hidden rounded-2xl border bg-gradient-to-br from-card via-card to-card/70 p-4 sm:p-5">
          <div
            aria-hidden
            className="pointer-events-none absolute -right-12 -top-12 size-32 rounded-full bg-rose-500/[0.08] blur-2xl"
          />
          <div className="relative">
            <SectionHeading
              icon={LineChartIcon}
              title={`Daily prize cost — ${label}`}
            />
            <div className="mt-3">
              {data.dailyCost.length === 0 ? (
                <EmptyState
                  icon={LineChartIcon}
                  title="No prize cost in this window"
                  description="No challenge prizes were paid in this period. Try a longer window."
                  compact
                />
              ) : (
                <ChallengesCostChart data={data.dailyCost} />
              )}
            </div>
          </div>
        </div>
      </FadeIn>

      {/* ── Per-challenge table (current-state) ───────────────────── */}
      <FadeIn>
        <div className="surface-sheen surface-raise relative overflow-hidden rounded-2xl border bg-gradient-to-br from-card via-card to-card/70 p-4 sm:p-5">
          <div className="relative space-y-3">
            <SectionHeading icon={ListChecks} title="All challenges" />
            {data.challenges.length === 0 ? (
              <EmptyState
                icon={Target}
                title="No challenges yet"
                description="No challenges have been created."
                compact
              />
            ) : (
              <ChallengesTable rows={data.challenges} />
            )}
          </div>
        </div>
      </FadeIn>
    </div>
  );
}
