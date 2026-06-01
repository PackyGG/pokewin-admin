import Link from "next/link";
import { ShieldAlert, AlertCircle, Activity, Eye } from "lucide-react";
import {
  KpiTile,
  SectionHeading,
} from "@/components/modern-panels";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { FadeIn } from "@/components/fade-in";
import { formatNumber, formatCurrency } from "@/lib/utils/format";
import { getCreatorRiskRows } from "@/lib/queries/insights-streamers/abuse";
import { RiskBadge } from "./risk-badge";
import { periodLabel, type StreamerPeriod } from "./types";
import { safeQuery } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";

/**
 * Sus / Abuse tab — every creator scored by 7 signals from
 * `getCreatorRiskRows`.
 *
 * Signals implemented (see queries/insights-streamers/abuse.ts):
 *   1. Low-quality cohort        — % never reaching $50 wager
 *   2. Cohort code-switching     — % of cohort with ≥2 codes
 *   3. Burst signups             — max 1h signups vs baseline
 *   4. Heavy borrow battles      — % of cohort wager that's borrow
 *   5. Self-play on stream       — creator's own wager during their stream
 *   6. Pack RTP / Upgrader z     — cohort game-outcome z-score vs baseline
 *   7. Cycle pattern             — % of cohort with ≥2 deposit→withdraw→
 *                                  redeposit-with-different-code cycles
 *
 * Combined risk = MAX(signal scores), not sum — so a creator with one
 * critical signal isn't diluted by zeros on the other axes.
 *
 * Amber 50+, rose 75+ per CLAUDE.md guidance.
 *
 * Note on House-POV for the strip: high risk = users winning at our
 * expense (sniping leaderboards, withdrawing cards funded by their
 * borrow share). So a high risk-creators count is "user-winning" → rose.
 */

/**
 * Explainer text shown in the tooltip of each signal chip — describes
 * WHAT the signal measures and HOW the score is computed, so admins
 * see the methodology without having to read the SQL.
 *
 * Keys are the canonical `SignalScore.label` strings produced by
 * `abuse.ts`. Stays in this file (not the query layer) because it's
 * UI copy, not analytics math.
 */
const SIGNAL_EXPLANATIONS: Record<string, string> = {
  "Low-quality cohort":
    "Share of the creator's referred users whose LIFETIME wager is under $50. " +
    "Score ramps 0→35 as the share rises from 50% to 100%. " +
    "Min cohort size of 5 to avoid noise.",
  "Cohort code-switching":
    "Share of the creator's cohort that has used ≥2 distinct affiliate codes. " +
    "Score ramps 0→25 as the share rises from 20% to 40%. " +
    "Indicator of sniping / multi-creator hopping.",
  "Burst signups":
    "Largest single-hour spike of cohort signups vs the hourly mean across the period. " +
    "Score scales with the spike/mean ratio (cap 20). " +
    "Triggers only when the spike is ≥8 signups and ≥5× the mean.",
  "Heavy borrow battles":
    "Share of the cohort's BATTLE wager that was funded by borrow (sponsorship). " +
    "Score ramps 0→20 as the share rises from 30% to 60%. " +
    "High share = cohort is wager-farming without committing their balance.",
  "Self-play on stream":
    "Creator's OWN wager (from their balance) during their own live stream windows, " +
    "as a share of total stream-time wager (their wager + cohort wager). " +
    "Score: 30%→25 pts (amber), 50%→40 pts, 80%→60 pts (rose). " +
    "Min $200 self-wager to gate noise.",
  "Pack RTP anomaly":
    "Cohort's pack RTP (card value / pack wager, non-borrow) vs the population baseline. " +
    "Z-score computed against the spread of per-creator-cohort RTPs. " +
    "|z|≥1.5 → 30 pts, |z|≥2.5 → 60 pts. Min 10 cohort pack opens.",
  "Upgrader hit-rate anomaly":
    "Cohort's upgrader hit rate (wins / bets) vs the population baseline. " +
    "Z-score computed against the spread of per-creator-cohort hit rates. " +
    "|z|≥1.5 → 30 pts, |z|≥2.5 → 60 pts. Min 10 cohort upgrader bets.",
  "Cycle pattern":
    "Cohort users who deposit → wager → withdraw → re-deposit with a DIFFERENT " +
    "affiliate code, repeated ≥2 times in the period. " +
    "Score: 10% of cohort affected → 30 pts, ≥20% → 60 pts. Min cohort 5.",
};
export async function SusTab({ period }: { period: StreamerPeriod }) {
  // SusTab fans out across 4 signal queries (abuse base + self-play +
  // cohort-rtp anomaly + cycle). Any one of them failing would crash
  // the whole tab — safeQuery degrades to an inline error tile so the
  // rest of /insights/streamers stays reachable.
  const { data: rows, error } = await safeQuery(
    () => getCreatorRiskRows(period),
    [] as Awaited<ReturnType<typeof getCreatorRiskRows>>,
    "insights-streamers.abuse",
  );
  if (error) {
    return (
      <TileErrorFallback
        label="Streamers — Sus / Abuse"
        hint="The risk-scoring query failed. Server logs hold the digest."
        size="panel"
      />
    );
  }

  const high = rows.filter((r) => r.totalRiskScore >= 75).length;
  const medium = rows.filter(
    (r) => r.totalRiskScore >= 50 && r.totalRiskScore < 75,
  ).length;
  const watchlist = rows.filter(
    (r) => r.totalRiskScore >= 30 && r.totalRiskScore < 50,
  ).length;
  const clean = rows.filter((r) => r.totalRiskScore < 30).length;

  // Hide creators with truly zero signals from the table — they're
  // noise in a risk view. The KPI tile reflects them so the strip
  // still sums to the full population.
  const flagged = rows.filter((r) => r.totalRiskScore > 0);

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
          <KpiTile
            label="High Risk"
            value={formatNumber(high)}
            sub="Score 75+ — investigate"
            icon={AlertCircle}
            accent="rose"
          />
          <KpiTile
            label="Medium"
            value={formatNumber(medium)}
            sub="Score 50–74 — review"
            icon={ShieldAlert}
            accent="amber"
          />
          <KpiTile
            label="Watchlist"
            value={formatNumber(watchlist)}
            sub="Score 30–49"
            icon={Activity}
            accent="cyan"
          />
          <KpiTile
            label="Clean"
            value={formatNumber(clean)}
            sub="No flagged signals"
            icon={ShieldAlert}
            accent="emerald"
          />
        </div>
      </FadeIn>

      <FadeIn delay={75}>
        <SectionHeading
          icon={ShieldAlert}
          title={`Flagged Streamers — ${periodLabel(period)}`}
        />
        <div className="surface-sheen surface-raise rounded-xl border bg-card mt-3">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-14 text-center">Risk</TableHead>
                <TableHead>Streamer</TableHead>
                <TableHead>Code</TableHead>
                <TableHead className="text-right">Referred</TableHead>
                <TableHead className="text-right">Cohort Wager</TableHead>
                <TableHead>Signals</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {flagged.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="py-10 text-center text-sm text-muted-foreground"
                  >
                    No flagged signals across {formatNumber(rows.length)} creators in this window.
                  </TableCell>
                </TableRow>
              ) : (
                flagged.map((r) => (
                  <TableRow key={r.userId}>
                    <TableCell className="text-center">
                      <RiskBadge score={r.totalRiskScore} />
                    </TableCell>
                    <TableCell>
                      <Link
                        href={`/creators/${r.userId}`}
                        className="font-medium hover:underline"
                      >
                        {r.username ?? r.userId.slice(0, 8)}
                      </Link>
                    </TableCell>
                    <TableCell>
                      {r.primaryCode ? (
                        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                          {r.primaryCode}
                        </code>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatNumber(r.referredCount)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                      {formatCurrency(r.cohortWagerUsd)}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1.5">
                        {r.signals.map((sig) => {
                          // Two-line tooltip: this creator's specific
                          // detail (top), then the methodology so the
                          // admin knows what to act on. Falls back to
                          // just the detail/label when no explainer is
                          // wired for this signal (defensive — covers
                          // future-added signals that haven't been
                          // mapped here yet).
                          const explain = SIGNAL_EXPLANATIONS[sig.label];
                          const tooltip = explain
                            ? `${sig.detail ?? sig.label}\n\n${explain}`
                            : (sig.detail ?? sig.label);
                          return (
                            <span
                              key={sig.label}
                              className="inline-flex items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400"
                              title={tooltip}
                            >
                              {sig.label}
                              <span className="tabular-nums opacity-70">
                                +{sig.score}
                              </span>
                            </span>
                          );
                        })}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Link
                        href={`/creators/${r.userId}`}
                        className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                        title="Open creator detail"
                      >
                        <Eye className="size-3.5" />
                      </Link>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </FadeIn>
    </div>
  );
}
