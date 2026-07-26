"use client";

import { useMemo, useState } from "react";
import { CircleDot, Dices, Percent, Sigma, Target } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { KpiTile, SectionHeading } from "@/components/modern-panels";
import { cn } from "@/lib/utils";
import { formatNumber } from "@/lib/utils/format";
import type { KenoPayoutObservation } from "@/lib/queries/keno";

type Risk = KenoPayoutObservation["risk"];

const RISKS: Array<{
  value: Risk;
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

function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  const size = Math.min(k, n - k);
  let result = 1;
  for (let i = 1; i <= size; i += 1) {
    result = (result * (n - size + i)) / i;
  }
  return result;
}

function hitProbability(picks: number, hits: number): number {
  return (
    (choose(picks, hits) * choose(40 - picks, 10 - hits)) / choose(40, 10)
  );
}

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

function formatHouseEdge(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

export function KenoOddsExplorer({
  observations,
}: {
  observations: KenoPayoutObservation[];
}) {
  const [risk, setRisk] = useState<Risk>("low");
  const [picks, setPicks] = useState(10);

  const rows = useMemo(
    () =>
      Array.from({ length: picks + 1 }, (_, hits) => {
        const probability = hitProbability(picks, hits);
        const matches = observations.filter(
          (row) =>
            row.risk === risk && row.picks === picks && row.hits === hits,
        );
        return { hits, probability, matches };
      }),
    [observations, picks, risk],
  );

  const anyMatch = 1 - hitProbability(picks, 0);
  const allMatch = hitProbability(picks, picks);
  const mostLikely = rows.reduce((best, row) =>
    row.probability > best.probability ? row : best,
  );
  const observedOutcomeCount = rows.filter(
    (row) => row.matches.length > 0,
  ).length;
  const expectedReturnFloor = rows.reduce((sum, row) => {
    if (row.matches.length === 0) return sum;
    const confirmedMultiplier = Math.max(
      ...row.matches.map((match) => match.multiplier),
    );
    return sum + row.probability * confirmedMultiplier;
  }, 0);
  const coveredProbability = rows.reduce(
    (sum, row) => sum + (row.matches.length > 0 ? row.probability : 0),
    0,
  );
  const hasCompletePayoutCurve = rows.every(
    (row) => row.matches.length === 1,
  );
  const houseEdgeCeiling = 1 - expectedReturnFloor;

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <SectionHeading
          icon={Sigma}
          title="Odds & chances"
          action={
            <Badge variant="outline" className="font-normal">
              Exact hypergeometric draw math
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
                Risk changes payouts, not draw probability. The same ten balls
                are drawn from forty for every profile.
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
                Select a pick count to recalculate every exact-hit outcome.
              </p>
            </div>

            <div className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                House edge
              </p>
              <div className="flex min-h-10 items-center gap-3 rounded-lg border bg-background px-3 py-2">
                <Percent className="size-4 shrink-0 text-cyan-500" />
                <span className="font-mono text-lg font-semibold tabular-nums">
                  {hasCompletePayoutCurve ? null : "≤ "}
                  {formatHouseEdge(houseEdgeCeiling)}
                </span>
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {hasCompletePayoutCurve
                  ? "Exact expected edge from this complete payout curve."
                  : `Mathematical ceiling from confirmed payouts covering ${formatProbability(coveredProbability)} of outcomes.`}
              </p>
            </div>
          </div>
        </div>
      </section>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
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
        <KpiTile
          label="Live payout coverage"
          value={`${observedOutcomeCount}/${rows.length}`}
          sub={`${risk} risk · ${picks} picks`}
          icon={Dices}
          accent="cyan"
        />
      </div>

      <section className="space-y-3">
        <SectionHeading
          icon={Dices}
          title={`${risk[0].toUpperCase()}${risk.slice(1)} risk · ${picks} ${picks === 1 ? "pick" : "picks"}`}
        />
        <div className="overflow-hidden rounded-xl border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Exact hits</TableHead>
                <TableHead className="text-right">Probability</TableHead>
                <TableHead className="text-right">Equivalent odds</TableHead>
                <TableHead className="text-right">
                  Observed live multiplier
                </TableHead>
                <TableHead className="text-right">Observed games</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const observedGames = row.matches.reduce(
                  (sum, match) => sum + match.observedGames,
                  0,
                );
                return (
                  <TableRow key={row.hits}>
                    <TableCell className="font-medium">
                      {row.hits} {row.hits === 1 ? "hit" : "hits"}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {formatProbability(row.probability)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {formatOneIn(row.probability)}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {row.matches.length > 0
                        ? row.matches
                            .map((match) => `${match.multiplier.toFixed(2)}×`)
                            .join(" · ")
                        : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {observedGames > 0 ? formatNumber(observedGames) : "—"}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-700 dark:text-amber-300">
          Draw probabilities are exact. House edge is calculated as 1 − the
          sum of each exact-hit probability × its payout multiplier. When the
          selected payout curve is incomplete, the ≤ value is an upper bound
          from confirmed multipliers only; unseen outcomes are not assumed to
          pay 0×. Payout curves are backend constants, not database
          configuration, so the multiplier column reports values confirmed by
          settled production games.
        </div>
      </section>
    </div>
  );
}
