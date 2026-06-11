import { Suspense } from "react";
import {
  Users,
  UserCheck,
  Repeat,
  UserMinus,
  DollarSign,
  Info,
  Scale,
  TableProperties,
} from "lucide-react";

import { SectionHeading, KpiTile } from "@/components/modern-panels";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { FadeIn } from "@/components/fade-in";
import { safeQueryOrNull } from "@/lib/errors/safe-query";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { cn } from "@/lib/utils";

import { getCohortsData, type CohortsData } from "../_queries/cohorts-data";
import { CohortsChart, type CohortChartPoint } from "./cohorts-chart";

/**
 * Cohorts & LTV tab for `creators/[id]`.
 *
 * The quality of this creator's referred players over time — signup → FTD →
 * repeat-deposit → churn cohorts (bucketed by signup month) plus the lifetime
 * value (deposits) each cohort produced.
 *
 * LAYOUT (top → bottom):
 *   1. KPI strip — roll-up across every cohort (signups / FTDs / repeat /
 *      churned / deposits-LTV / lifetime net).
 *   2. Cohort funnel & LTV chart (grouped bars + deposits line).
 *   3. Per-cohort table — one row per signup month, funnel + rates + LTV.
 *
 * LAZY / never-preload: this whole tab is a self-contained component that
 * fetches ITS OWN data only when the Cohorts tab is opened, inside a keyed
 * Suspense boundary, via the cached + timeout-guarded `getCohortsData`. No
 * other tab's data is touched. MAIN/prod game DB is READ-ONLY.
 *
 * Self-contained: takes only the creator's `userId` (the referrer id, which
 * is also `affiliate_user_id`); everything else is fetched server-side.
 */
export function CohortsLtvTab({ userId }: { userId: string }) {
  return (
    <FadeIn className="space-y-5 sm:space-y-6">
      <SectionHeading icon={Users} title="Cohorts & LTV" />
      <Suspense fallback={<CohortsLtvSkeleton />}>
        <CohortsLtvContent userId={userId} />
      </Suspense>
    </FadeIn>
  );
}

async function CohortsLtvContent({ userId }: { userId: string }) {
  // 60s budget so the cold cohort scan (correlated per-user sub-selects over
  // the referred pool) completes + warms the cache rather than getting cut
  // off early — same budget the windowed-P&L tiles use.
  const { data, kind } = await safeQueryOrNull(
    () => getCohortsData(userId),
    "creator-hub.creators.cohorts",
    60_000,
  );

  if (!data) {
    // Truthful band copy — a hard failure must not masquerade as "slow".
    const timedOut = kind === "timeout";
    return (
      <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-sm">
        <Info className="mt-0.5 size-4 shrink-0 text-amber-500" />
        <div>
          <div className="font-medium text-amber-500">
            {timedOut
              ? "Cohorts are taking too long to load"
              : "Cohorts failed to load"}
          </div>
          <div className="mt-0.5 text-muted-foreground">
            {timedOut
              ? "The referred-player cohort scan timed out. Refresh to retry — the rest of the page is unaffected."
              : "The referred-player cohort scan failed — its data is unavailable right now. Refresh to retry; the rest of the page is unaffected."}
          </div>
        </div>
      </div>
    );
  }

  if (data.cohorts.length === 0) {
    return (
      <div className="flex items-start gap-3 rounded-lg border bg-muted/30 p-5 text-sm">
        <Users className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div>
          <div className="font-medium">No referred players yet</div>
          <div className="mt-0.5 text-muted-foreground">
            This creator has no referred sign-ups in the last{" "}
            {data.lookbackDays} days. Cohorts appear here once players sign up
            under their code.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5 sm:space-y-6">
      <CohortKpiStrip data={data} />

      {/* Chart wants oldest→newest so the x-axis reads chronologically; the
          query returns newest-first for the table, so reverse a shallow copy. */}
      <CohortsChart series={toChartSeries(data)} />

      <div className="space-y-3">
        <SectionHeading
          icon={TableProperties}
          title="Per-cohort breakdown"
          action={
            <span className="text-[11px] text-muted-foreground">
              by signup month · churn = no deposit in {data.churnWindowDays}d
            </span>
          }
        />
        <CohortTable data={data} />
      </div>

      <CohortFootnotes data={data} />
    </div>
  );
}

function toChartSeries(data: CohortsData): CohortChartPoint[] {
  return data.cohorts
    .slice()
    .reverse()
    .map((c) => ({
      label: c.monthLabel,
      signups: c.signups,
      ftds: c.ftds,
      repeat: c.repeatDepositors,
      depositsUsd: c.depositsUsd,
    }));
}

function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

// ── KPI strip (roll-up) ──────────────────────────────────────────────

function CohortKpiStrip({ data }: { data: CohortsData }) {
  const t = data.totals;
  const netLoaded = data.lifetimeNetUsd !== null;
  const net = data.lifetimeNetUsd ?? 0;
  // House-POV: net > 0 (kept more cash than card value shipped) → emerald;
  // net < 0 → rose.
  const netAccent: "emerald" | "rose" | "blue" =
    netLoaded && net > 0 ? "emerald" : netLoaded && net < 0 ? "rose" : "blue";

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {/* Funnel counts are neutral → blue/cyan/violet/amber. */}
      <KpiTile
        label="Signups"
        value={formatNumber(t.signups)}
        sub="referred players"
        icon={Users}
        accent="blue"
      />
      <KpiTile
        label="FTDs"
        value={formatNumber(t.ftds)}
        sub={`${pct(t.ftdRate)} of signups`}
        icon={UserCheck}
        accent="cyan"
      />
      <KpiTile
        label="Repeat"
        value={formatNumber(t.repeatDepositors)}
        sub={`${pct(t.repeatRate)} of FTDs`}
        icon={Repeat}
        accent="purple"
      />
      <KpiTile
        label="Churned"
        value={formatNumber(t.churned)}
        sub={`${formatNumber(t.active)} still active`}
        icon={UserMinus}
        accent="amber"
      />
      {/* Deposits = cash INTO the house → emerald. */}
      <KpiTile
        label="Deposits LTV"
        value={formatCurrency(t.depositsUsd)}
        sub={
          t.ftds > 0
            ? `${formatCurrency(t.avgDepositPerFtdUsd)} / depositor`
            : "no depositors yet"
        }
        icon={DollarSign}
        accent="emerald"
      />
      {/* Lifetime net (deposits − cardWD), creator-wide — reused from the
          existing creator P&L scan. */}
      <KpiTile
        label="Lifetime net"
        value={
          !netLoaded ? "—" : `${net > 0 ? "+" : ""}${formatCurrency(net)}`
        }
        sub={netLoaded ? "house P&L (all cohorts)" : "unavailable"}
        icon={Scale}
        accent={netAccent}
      />
    </div>
  );
}

// ── Per-cohort table ─────────────────────────────────────────────────

function CohortTable({ data }: { data: CohortsData }) {
  return (
    <Card size="sm" className="overflow-hidden p-0">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm">
          <thead>
            <tr className="border-b bg-muted/40 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              <th className="px-3 py-2.5">Cohort</th>
              <th className="px-3 py-2.5 text-right">Signups</th>
              <th className="px-3 py-2.5 text-right">FTDs</th>
              <th className="px-3 py-2.5 text-right">FTD rate</th>
              <th className="px-3 py-2.5 text-right">Repeat</th>
              <th className="px-3 py-2.5 text-right">Repeat rate</th>
              <th className="px-3 py-2.5 text-right">Active</th>
              <th className="px-3 py-2.5 text-right">Churned</th>
              <th className="px-3 py-2.5 text-right">Deposits LTV</th>
              <th className="px-3 py-2.5 text-right">Avg / FTD</th>
              <th className="px-3 py-2.5 text-right">Wager</th>
            </tr>
          </thead>
          <tbody>
            {data.cohorts.map((c) => (
              <tr
                key={c.monthKey}
                className="border-b last:border-0 transition-colors hover:bg-muted/30"
              >
                <td className="whitespace-nowrap px-3 py-2.5 font-medium">
                  {c.monthLabel}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums text-blue-600 dark:text-blue-400">
                  {formatNumber(c.signups)}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums text-cyan-600 dark:text-cyan-400">
                  {formatNumber(c.ftds)}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                  {c.signups > 0 ? pct(c.ftdRate) : "—"}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums text-violet-600 dark:text-violet-400">
                  {formatNumber(c.repeatDepositors)}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                  {c.ftds > 0 ? pct(c.repeatRate) : "—"}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                  {formatNumber(c.active)}
                </td>
                <td
                  className={cn(
                    "px-3 py-2.5 text-right tabular-nums",
                    c.churned > 0
                      ? "text-rose-600 dark:text-rose-400"
                      : "text-muted-foreground",
                  )}
                >
                  {formatNumber(c.churned)}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums font-medium text-emerald-600 dark:text-emerald-400">
                  {c.depositsUsd > 0 ? formatCurrency(c.depositsUsd) : "—"}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                  {c.ftds > 0 ? formatCurrency(c.avgDepositPerFtdUsd) : "—"}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums text-emerald-600/80 dark:text-emerald-400/80">
                  {c.wagerUsd > 0 ? formatCurrency(c.wagerUsd) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t bg-muted/40 text-sm font-semibold">
              <td className="px-3 py-2.5">All cohorts</td>
              <td className="px-3 py-2.5 text-right tabular-nums">
                {formatNumber(data.totals.signups)}
              </td>
              <td className="px-3 py-2.5 text-right tabular-nums">
                {formatNumber(data.totals.ftds)}
              </td>
              <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                {data.totals.signups > 0 ? pct(data.totals.ftdRate) : "—"}
              </td>
              <td className="px-3 py-2.5 text-right tabular-nums">
                {formatNumber(data.totals.repeatDepositors)}
              </td>
              <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                {data.totals.ftds > 0 ? pct(data.totals.repeatRate) : "—"}
              </td>
              <td className="px-3 py-2.5 text-right tabular-nums">
                {formatNumber(data.totals.active)}
              </td>
              <td className="px-3 py-2.5 text-right tabular-nums">
                {formatNumber(data.totals.churned)}
              </td>
              <td className="px-3 py-2.5 text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                {formatCurrency(data.totals.depositsUsd)}
              </td>
              <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                {data.totals.ftds > 0
                  ? formatCurrency(data.totals.avgDepositPerFtdUsd)
                  : "—"}
              </td>
              <td className="px-3 py-2.5 text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                {formatCurrency(data.totals.wagerUsd)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </Card>
  );
}

// ── Footnotes (honest about definitions + data coverage) ─────────────

function CohortFootnotes({ data }: { data: CohortsData }) {
  return (
    <div className="space-y-1 rounded-lg border border-border/60 bg-muted/20 p-3 text-[11px] leading-relaxed text-muted-foreground">
      <p>
        <span className="font-medium text-foreground">Cohort</span> = referred
        players grouped by the month they signed up (via{" "}
        <code className="rounded bg-muted px-1">referred_by</code>). Staff &amp;
        creator accounts and the managed blacklist are excluded, matching the
        Overview signup count. Scan bounded to the last {data.lookbackDays} days
        of signups.
      </p>
      <p>
        <span className="font-medium text-foreground">FTD</span> = ever
        deposited ({" "}
        <code className="rounded bg-muted px-1">total_deposited &gt; 0</code>
        ). <span className="font-medium text-foreground">Repeat</span> = ≥2
        completed deposits.{" "}
        <span className="font-medium text-foreground">Churned</span> = deposited
        but no completed deposit in the last {data.churnWindowDays} days.
      </p>
      <p>
        <span className="font-medium text-foreground">Deposits LTV</span> is a
        real per-cohort figure (Σ lifetime deposits). The{" "}
        <span className="font-medium text-foreground">Lifetime net</span> KPI
        (deposits − card-withdrawals, coverage-attributed) is a creator-wide
        total — the same figure as the Overview Creator-Net box — and is{" "}
        <span className="italic">not</span> split per cohort.
      </p>
    </div>
  );
}

// ── Skeleton ─────────────────────────────────────────────────────────

function CohortsLtvSkeleton() {
  return (
    <div className="space-y-5 sm:space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <Card key={i} size="sm" className="space-y-2 p-4">
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-7 w-20" />
            <Skeleton className="h-3 w-24" />
          </Card>
        ))}
      </div>
      <Card size="sm" className="space-y-3 p-4 sm:p-5">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-[260px] w-full rounded-md" />
      </Card>
      <Card size="sm" className="space-y-2 p-4">
        <Skeleton className="h-5 w-44" />
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-9 w-full rounded" />
        ))}
      </Card>
    </div>
  );
}
