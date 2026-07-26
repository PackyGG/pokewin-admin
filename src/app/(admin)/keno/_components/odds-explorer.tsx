"use client";

import { useMemo, useState } from "react";
import {
  CircleDot,
  Dices,
  Percent,
  Sigma,
  Target,
  TrendingUp,
} from "lucide-react";

import { KpiTile, SectionHeading } from "@/components/modern-panels";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  getKenoHitProbability,
  getKenoHouseEdge,
  getKenoPayoutRow,
  getKenoRtp,
  type KenoRiskMode,
} from "@/lib/keno/payouts";
import type { KenoPayoutObservation } from "@/lib/queries/keno";
import { cn } from "@/lib/utils";
import { formatNumber } from "@/lib/utils/format";

const RISKS: Array<{
  value: KenoRiskMode;
  label: string;
  active: string;
  dot: string;
}> = [
  {
    value: "low",
    label: "Low",
    active:
      "border-emerald-500/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    dot: "bg-emerald-500",
  },
  {
    value: "medium",
    label: "Medium",
    active:
      "border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    dot: "bg-amber-500",
  },
  {
    value: "high",
    label: "High",
    active:
      "border-rose-500/50 bg-rose-500/10 text-rose-700 dark:text-rose-300",
    dot: "bg-rose-500",
  },
];

function formatProbability(value: number): string {
  if (value <= 0) return "0%";
  if (value >= 0.01) return `${(value * 100).toFixed(2)}%`;
  if (value >= 0.0001) return `${(value * 100).toFixed(4)}%`;
  return `${(value * 100).toPrecision(3)}%`;
}

function formatOneIn(value: number): string {
  if (value <= 0) return "Impossible";
  const oneIn = 1 / value;
  if (oneIn < 10) return `1 in ${oneIn.toFixed(2)}`;
  return `1 in ${formatNumber(Math.round(oneIn))}`;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function formatMultiplier(value: number): string {
  return `${value.toFixed(2)}×`;
}

function payoutOutcome(multiplier: number): string {
  if (multiplier > 1) return "Profit";
  if (multiplier === 1) return "Stake returned";
  if (multiplier > 0) return "Partial return";
  return "No payout";
}

export function KenoOddsExplorer({
  observations,
  evidenceUnavailable = false,
}: {
  observations: KenoPayoutObservation[];
  evidenceUnavailable?: boolean;
}) {
  const [risk, setRisk] = useState<KenoRiskMode>("low");
  const [picks, setPicks] = useState(10);

  const rows = useMemo(() => {
    const payoutRow = getKenoPayoutRow(risk, picks);
    return payoutRow.map((multiplier, hits) => {
      const matches = observations.filter(
        (row) =>
          row.risk === risk && row.picks === picks && row.hits === hits,
      );
      const hasDrift = matches.some(
        (match) => Math.abs(match.multiplier - multiplier) > 0.000_001,
      );
      return {
        hits,
        multiplier,
        probability: getKenoHitProbability(picks, hits),
        matches,
        hasDrift,
      };
    });
  }, [observations, picks, risk]);

  const anyMatch = 1 - getKenoHitProbability(picks, 0);
  const allMatch = getKenoHitProbability(picks, picks);
  const configuredRtp = getKenoRtp(risk, picks);
  const houseEdge = getKenoHouseEdge(risk, picks);
  const mostLikely = rows.reduce((best, row) =>
    row.probability > best.probability ? row : best,
  );
  const observedOutcomeCount = rows.filter(
    (row) => row.matches.length > 0,
  ).length;
  const payoutDriftCount = rows.filter((row) => row.hasDrift).length;
  const maximumWin = rows.reduce((highest, row) =>
    row.multiplier > highest.multiplier ? row : highest,
  );

  const evidenceLabel = evidenceUnavailable
    ? "Settlement evidence unavailable"
    : payoutDriftCount > 0
      ? `${payoutDriftCount} payout mismatch${payoutDriftCount === 1 ? "" : "es"}`
      : observedOutcomeCount > 0
        ? `${observedOutcomeCount}/${rows.length} outcomes verified · 0 mismatches`
        : "Backend paytable · no settled evidence yet";

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <SectionHeading
          icon={Sigma}
          title="Odds & chances"
          action={
            <Badge variant="outline" className="font-normal">
              Backend paytable · exact hypergeometric math
            </Badge>
          }
        />

        <div className="rounded-xl border bg-card p-4 sm:p-5">
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.65fr)_minmax(180px,0.7fr)]">
            <div className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                Risk profile
              </p>
              <div className="flex flex-wrap gap-2">
                {RISKS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={risk === option.value}
                    onClick={() => setRisk(option.value)}
                    className={cn(
                      "inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors",
                      risk === option.value
                        ? option.active
                        : "bg-background text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <span className={cn("size-2 rounded-full", option.dot)} />
                    {option.label}
                  </button>
                ))}
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Risk changes the configured payout curve, not the draw. Every
                mode draws the same ten numbers from forty.
              </p>
            </div>

            <div className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                Numbers picked
              </p>
              <div className="flex flex-wrap gap-2">
                {Array.from({ length: 10 }, (_, index) => index + 1).map(
                  (value) => (
                    <button
                      key={value}
                      type="button"
                      aria-label={`Pick ${value} numbers`}
                      aria-pressed={picks === value}
                      onClick={() => setPicks(value)}
                      className={cn(
                        "flex size-10 items-center justify-center rounded-lg border font-mono text-sm font-semibold transition-colors",
                        picks === value
                          ? "border-primary bg-primary text-primary-foreground shadow-sm"
                          : "bg-background text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {value}
                    </button>
                  ),
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                Select a pick count to load its complete configured paytable.
              </p>
            </div>

            <div className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                House edge
              </p>
              <div className="flex min-h-10 items-center gap-3 rounded-lg border bg-background px-3 py-2">
                <Percent className="size-4 shrink-0 text-cyan-500" />
                <span className="font-mono text-lg font-semibold tabular-nums">
                  {formatPercent(houseEdge)}
                </span>
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Exact from every configured multiplier. RTP{" "}
                {formatPercent(configuredRtp)}.
              </p>
            </div>
          </div>
        </div>
      </section>

      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
        <KpiTile
          label="Maximum win"
          value={formatMultiplier(maximumWin.multiplier)}
          sub={`${maximumWin.hits} ${maximumWin.hits === 1 ? "hit" : "hits"} · backend paytable`}
          icon={TrendingUp}
          accent="rose"
        />
        <KpiTile
          label="Configured RTP"
          value={formatPercent(configuredRtp)}
          sub={`${formatPercent(houseEdge)} house edge`}
          icon={Percent}
          accent="cyan"
        />
        <KpiTile
          label="Any match"
          value={formatProbability(anyMatch)}
          sub={formatOneIn(anyMatch)}
          icon={Target}
          accent="blue"
        />
        <KpiTile
          label={`All ${picks} match`}
          value={formatProbability(allMatch)}
          sub={formatOneIn(allMatch)}
          icon={CircleDot}
          accent="amber"
        />
        <KpiTile
          label="Most likely"
          value={`${mostLikely.hits} ${mostLikely.hits === 1 ? "hit" : "hits"}`}
          sub={formatProbability(mostLikely.probability)}
          icon={Sigma}
          accent="purple"
        />
      </div>

      <section className="space-y-3">
        <SectionHeading
          icon={Dices}
          title={`${risk[0].toUpperCase()}${risk.slice(1)} risk · ${picks} ${picks === 1 ? "pick" : "picks"}`}
          action={
            <Badge
              variant="outline"
              className={cn(
                "font-normal",
                payoutDriftCount > 0 &&
                  "border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300",
              )}
            >
              {evidenceLabel}
            </Badge>
          }
        />
        <div className="overflow-hidden rounded-xl border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Exact hits</TableHead>
                <TableHead className="text-right">Win multiplier</TableHead>
                <TableHead className="hidden md:table-cell">Result</TableHead>
                <TableHead className="text-right">Probability</TableHead>
                <TableHead className="text-right">Equivalent odds</TableHead>
                <TableHead className="hidden text-right lg:table-cell">
                  Settled evidence
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const observedGames = row.matches.reduce(
                  (sum, match) => sum + match.observedGames,
                  0,
                );
                const multiplierClass =
                  row.multiplier > 1
                    ? "border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300"
                    : row.multiplier === 1
                      ? "border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-300"
                      : "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
                return (
                  <TableRow
                    key={row.hits}
                    className={
                      row.hasDrift ? "bg-rose-500/5 hover:bg-rose-500/10" : ""
                    }
                  >
                    <TableCell className="font-medium">
                      {row.hits} {row.hits === 1 ? "hit" : "hits"}
                    </TableCell>
                    <TableCell className="text-right">
                      <Badge
                        variant="outline"
                        className={cn(
                          "font-mono text-sm font-semibold tabular-nums",
                          multiplierClass,
                        )}
                      >
                        {formatMultiplier(row.multiplier)}
                      </Badge>
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground md:table-cell">
                      {payoutOutcome(row.multiplier)}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {formatProbability(row.probability)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {formatOneIn(row.probability)}
                    </TableCell>
                    <TableCell className="hidden text-right tabular-nums lg:table-cell">
                      {row.hasDrift ? (
                        <span className="text-rose-600 dark:text-rose-400">
                          Multiplier mismatch
                        </span>
                      ) : observedGames > 0 ? (
                        `${formatNumber(observedGames)} games`
                      ) : (
                        "No settled games"
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
        <div className="rounded-lg border border-blue-500/30 bg-blue-500/10 p-3 text-xs leading-relaxed text-blue-700 dark:text-blue-300">
          Multipliers come from the backend&apos;s complete payout engine, not
          from historical results. Probability uses the exact chance of each
          hit count when ten numbers are drawn from forty. Configured RTP is Σ
          (probability × multiplier), and house edge is 1 − RTP. Settled games
          are used only to detect payout drift.
        </div>
      </section>
    </div>
  );
}
