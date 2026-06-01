import { TrendingUp, Target, Percent, BarChart3 } from "lucide-react";
import { FadeIn } from "@/components/fade-in";
import { KpiTile, SectionHeading } from "@/components/modern-panels";
import { formatCompactUsd, formatNumber } from "@/lib/utils/format";
import { getUpgraderProfitability } from "@/lib/queries/insights-games/upgrader";
import type { GamesPeriod } from "@/lib/queries/insights-games/_shared";
import { labelForPeriod } from "@/lib/queries/insights-games/_shared";
import { UpgraderHistogram } from "./upgrader-histogram";
import { UpgraderBucketPopover } from "./upgrader-bucket-popover";

/**
 * Upgrader tab — totals + per-target-multiplier bucket breakdown.
 *
 * No borrow on upgrader (verified — no field, no convention). The
 * creator-on-stream filter still applies (same session_windows CTE).
 *
 * The bucket table is the headline: admins read it as "how the
 * house edge changes with the target multiplier" (e.g. 100×+
 * tickets pay <1% of the time but the bets are tiny → the bucket
 * is small but high-margin).
 */
export async function UpgraderTab({ period }: { period: GamesPeriod }) {
  const data = await getUpgraderProfitability(period);
  const t = data.totals;
  const pnlAccent = t.pnl >= 0 ? "emerald" : "rose";

  // Cohort aggregates — buckets are already keyed by the operator-
  // facing range labels; group them up into the operator-facing
  // cohort names (matches the histogram colour groups).
  type Cohort = "Low rollers" | "Mid rollers" | "Risk takers" | "Whales";
  const cohortBuckets: Record<Cohort, { bets: number; wager: number; payout: number }> = {
    "Low rollers": { bets: 0, wager: 0, payout: 0 },
    "Mid rollers": { bets: 0, wager: 0, payout: 0 },
    "Risk takers": { bets: 0, wager: 0, payout: 0 },
    Whales: { bets: 0, wager: 0, payout: 0 },
  };
  const cohortOrder: Cohort[] = ["Low rollers", "Mid rollers", "Risk takers", "Whales"];
  for (const c of data.cohorts) {
    if (c.cohort === "Other") continue;
    const b = data.buckets.find((x) => x.label === c.label);
    if (!b) continue;
    const acc = cohortBuckets[c.cohort];
    acc.bets += b.bets;
    acc.wager += b.totalWager;
    acc.payout += b.totalPayout;
  }
  const cohortRows = cohortOrder.map((cohort) => {
    const a = cohortBuckets[cohort];
    const pnl = a.wager - a.payout;
    return {
      cohort,
      bets: a.bets,
      wager: a.wager,
      payout: a.payout,
      pnl,
      rtpPct: a.wager > 0 ? (a.payout / a.wager) * 100 : 0,
      marginPct: a.wager > 0 ? (pnl / a.wager) * 100 : 0,
    };
  });

  // Histogram source — same buckets the table draws from, plus the
  // cohort tag so the chart can colour bars by group.
  const histogramData = data.buckets.map((b) => {
    const cohort = data.cohorts.find((c) => c.label === b.label);
    return {
      label: b.label,
      cohort: cohort?.cohort ?? "Other",
      bets: b.bets,
      wager: b.totalWager,
    };
  });

  return (
    <FadeIn>
      <div className="space-y-6">
        {/* KPI strip */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <KpiTile
            label="Bets"
            value={formatNumber(t.bets)}
            sub={labelForPeriod(period)}
            icon={TrendingUp}
            accent="blue"
          />
          <KpiTile
            label="Wager"
            value={formatCompactUsd(t.wager)}
            sub={`Avg ${formatCompactUsd(t.avgBet)} / bet`}
            icon={TrendingUp}
            accent="emerald"
          />
          <KpiTile
            label="Payout"
            value={formatCompactUsd(t.payouts)}
            sub={`Hit rate ${t.hitRatePct.toFixed(2)}%`}
            icon={Target}
            accent="rose"
          />
          <KpiTile
            label="P&L"
            value={formatCompactUsd(t.pnl)}
            sub={`${t.marginPct.toFixed(2)}% margin · RTP ${t.rtpPct.toFixed(2)}%`}
            icon={Percent}
            accent={pnlAccent}
          />
        </div>

        {/* Cohort summary — operator-facing groups derived from the
            target-multiplier buckets. Low rollers (<5×), Mid (5–10×),
            Risk takers (10–100×), Whales (100×+). Cohort tells you
            who the players are, the buckets below tell you how the
            edge behaves. */}
        {t.bets > 0 && (
          <>
            <SectionHeading icon={Target} title="By cohort" />
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {cohortRows.map((c) => {
                const cohortAccent: "emerald" | "blue" | "amber" | "purple" =
                  c.cohort === "Low rollers"
                    ? "emerald"
                    : c.cohort === "Mid rollers"
                      ? "blue"
                      : c.cohort === "Risk takers"
                        ? "amber"
                        : "purple";
                return (
                  <div
                    key={c.cohort}
                    className="rounded-2xl border bg-card p-4"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        {c.cohort}
                      </p>
                      <span
                        className={`text-[10px] font-medium uppercase ${
                          cohortAccent === "emerald"
                            ? "text-emerald-500"
                            : cohortAccent === "blue"
                              ? "text-blue-500"
                              : cohortAccent === "amber"
                                ? "text-amber-500"
                                : "text-purple-500"
                        }`}
                      >
                        {formatNumber(c.bets)} bets
                      </span>
                    </div>
                    <p
                      className={`mt-1 text-xl font-bold tabular-nums ${c.pnl >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}
                    >
                      {formatCompactUsd(c.pnl)}
                    </p>
                    <p className="text-[10px] text-muted-foreground">
                      RTP {c.rtpPct.toFixed(2)}% · margin{" "}
                      {c.marginPct.toFixed(2)}%
                    </p>
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      Wager{" "}
                      <span className="font-medium text-emerald-600 dark:text-emerald-400">
                        {formatCompactUsd(c.wager)}
                      </span>{" "}
                      · Payout{" "}
                      <span className="font-medium text-rose-600 dark:text-rose-400">
                        {formatCompactUsd(c.payout)}
                      </span>
                    </p>
                  </div>
                );
              })}
            </div>
          </>
        )}

        {/* Target multiplier distribution histogram */}
        {t.bets > 0 && (
          <>
            <SectionHeading
              icon={BarChart3}
              title="Target multiplier distribution"
            />
            <div className="rounded-2xl border bg-card p-4 sm:p-5">
              <p className="mb-2 text-xs text-muted-foreground">
                Bet counts per bucket — bar colour groups bucket into the
                cohort above.
              </p>
              <UpgraderHistogram data={histogramData} />
            </div>
          </>
        )}

        {/* Bucket breakdown — now with drilldown popover per row */}
        <SectionHeading icon={Target} title="By target multiplier" />
        {t.bets === 0 ? (
          <div className="rounded-2xl border bg-card p-8 text-center text-sm text-muted-foreground">
            No upgrader plays in this period.
          </div>
        ) : (
          <div className="overflow-hidden rounded-2xl border bg-card">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-semibold">Target</th>
                    <th className="px-3 py-2 text-right font-semibold">Bets</th>
                    <th className="px-3 py-2 text-right font-semibold">Wager</th>
                    <th className="px-3 py-2 text-right font-semibold">Payout</th>
                    <th className="px-3 py-2 text-right font-semibold">P&amp;L</th>
                    <th className="px-3 py-2 text-right font-semibold">RTP</th>
                    <th className="px-3 py-2 text-right font-semibold">Hit %</th>
                    <th className="px-3 py-2 text-right font-semibold">
                      <span className="sr-only">Drilldown</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.buckets
                    .filter((b) => b.bets > 0)
                    .map((b) => {
                      const cohort = data.cohorts.find((c) => c.label === b.label);
                      return (
                        <tr key={b.label} className="border-b last:border-0 hover:bg-muted/30">
                          <td className="px-3 py-2 font-medium">{b.label}</td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {formatNumber(b.bets)}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                            {formatCompactUsd(b.totalWager)}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-rose-600 dark:text-rose-400">
                            {formatCompactUsd(b.totalPayout)}
                          </td>
                          <td
                            className={`px-3 py-2 text-right tabular-nums font-medium ${b.pnl >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}
                          >
                            {formatCompactUsd(b.pnl)}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {b.rtpPct.toFixed(2)}%
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {b.hitRatePct.toFixed(2)}%
                          </td>
                          <td className="px-3 py-2 text-right">
                            <UpgraderBucketPopover
                              bucket={b.label}
                              period={period}
                              cohort={cohort?.cohort ?? "Other"}
                            />
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </FadeIn>
  );
}
