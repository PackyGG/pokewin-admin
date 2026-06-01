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

/**
 * Sus / Abuse tab — every creator scored by signals from
 * `getCreatorRiskRows`.
 *
 * Signals implemented (see queries/insights-streamers/abuse.ts):
 *   1. Low-quality cohort       — % never reaching $50 wager
 *   2. Cohort code-switching    — % of cohort with ≥2 codes
 *   3. Burst signups            — max 1h signups vs baseline
 *   4. Heavy borrow battles     — % of cohort wager that's borrow
 *
 * Each signal carries 0..N points; the page renders the capped sum.
 * Amber 50+, rose 75+ per CLAUDE.md guidance.
 *
 * Note on House-POV for the strip: high risk = users winning at our
 * expense (sniping leaderboards, withdrawing cards funded by their
 * borrow share). So a high risk-creators count is "user-winning" → rose.
 */
export async function SusTab({ period }: { period: StreamerPeriod }) {
  const rows = await getCreatorRiskRows(period);

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
                        {r.signals.map((sig) => (
                          <span
                            key={sig.label}
                            className="inline-flex items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400"
                            title={sig.detail ?? sig.label}
                          >
                            {sig.label}
                            <span className="tabular-nums opacity-70">
                              +{sig.score}
                            </span>
                          </span>
                        ))}
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
