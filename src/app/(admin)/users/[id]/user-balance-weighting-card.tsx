"use client";

/**
 * Per-user "what part of the balance counts how much, toward what" display.
 *
 * Companion to `UserWagerProgressCard` (which shows the WITHDRAWAL debt gate).
 * This card projects the live funding-source wager-weight matrix
 * (`getSourceWagerWeights`) onto THIS user's current balance composition: of
 * their available balance, how much is deposit/organic (the 1× baseline) vs
 * each still-unwagered bonus source, and — per destination (withdrawal,
 * races/leaderboards, rakeback) — how much of it would COUNT when
 * wagered (balance × weight) vs is excluded (weight < 1×).
 *
 * Weights apply at wager time, so these are forward-looking "earning power"
 * figures, not settled amounts. Enforcement lives in the game backend; this is
 * a read-only admin projection. `data === null` → the connected DB lacks the
 * sweepstakes columns (drift) or the user has no balance row → muted state.
 *
 * Colors: these are informational config figures, not P&L, so they are NOT
 * framed with the house-POV gain/loss palette. Full weight (1×) reads as
 * normal foreground, partial (<1×) as amber (reduced), excluded (0×) as muted.
 */

import { Scale, AlertTriangle, Info } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { StatPanel, KpiTile } from "@/components/modern-panels";
import { formatCurrency } from "@/lib/utils/format";
import type {
  UserBalanceWeighting,
  WeightDestinationKey,
} from "@/lib/queries/users-balance-weighting";

const BPS_PER_X = 10000;

const formatX = (bps: number): string =>
  `${(bps / BPS_PER_X).toLocaleString("en-US", { maximumFractionDigits: 2 })}×`;

/** Counted USD for a balance chunk toward a destination = balance × bps/1×. */
const counted = (balanceUsd: number, bps: number | null): number | null =>
  bps == null ? null : Math.round(((balanceUsd * bps) / BPS_PER_X) * 100) / 100;

function weightTone(bps: number | null): string {
  if (bps == null) return "text-muted-foreground";
  if (bps >= BPS_PER_X) return "text-foreground";
  if (bps <= 0) return "text-muted-foreground";
  return "text-amber-600 dark:text-amber-400";
}

export function UserBalanceWeightingCard({
  data,
}: {
  data: UserBalanceWeighting | null;
}) {
  if (!data) {
    return (
      <Card className="border-dashed">
        <CardContent>
          <div className="flex items-start gap-3 rounded-md border border-muted-foreground/30 bg-muted/40 p-3 text-xs text-muted-foreground">
            <AlertTriangle className="size-4 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-medium text-foreground">
                Balance weighting not available
              </p>
              <p>
                This user has no balance record, or the connected database
                doesn&apos;t carry the sweepstakes funding-source columns.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  const { availableBalanceUsd, destinations, rows, backendAvailable } = data;

  // Per-destination totals: how much of the balance counts vs is excluded.
  const totals = destinations.map((d) => {
    let countsUsd = 0;
    let known = backendAvailable;
    for (const r of rows) {
      const c = counted(r.balanceUsd, r.weightBps[d.key]);
      if (c == null) {
        known = false;
      } else {
        countsUsd += c;
      }
    }
    countsUsd = Math.round(countsUsd * 100) / 100;
    return {
      key: d.key as WeightDestinationKey,
      label: d.label,
      countsUsd,
      excludedUsd: Math.round((availableBalanceUsd - countsUsd) * 100) / 100,
      known,
    };
  });

  return (
    <div className="space-y-3">
      {/* Per-destination summary — "of the balance, how much counts here". */}
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
        {totals.map((t) => (
          <KpiTile
            key={t.key}
            icon={Scale}
            label={`Counts toward ${t.label}`}
            accent="blue"
            value={t.known ? formatCurrency(t.countsUsd) : "—"}
            sub={
              t.known
                ? `of ${formatCurrency(availableBalanceUsd)} · ${formatCurrency(
                    Math.max(0, t.excludedUsd),
                  )} excluded`
                : "backend config unreachable"
            }
          />
        ))}
      </div>

      <StatPanel title="Balance by source × destination" icon={Scale} accent="blue">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-[11px] uppercase tracking-wider text-muted-foreground">
                <th className="py-1.5 pr-2 text-left font-medium">Source</th>
                <th className="px-2 py-1.5 text-right font-medium">Balance</th>
                {destinations.map((d) => (
                  <th
                    key={d.key}
                    className="px-2 py-1.5 text-right font-medium"
                  >
                    {d.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.key}
                  className="border-b border-border/40 last:border-0"
                >
                  <td className="py-1.5 pr-2 text-left">{r.label}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {formatCurrency(r.balanceUsd)}
                  </td>
                  {destinations.map((d) => {
                    const bps = r.weightBps[d.key];
                    const c = counted(r.balanceUsd, bps);
                    return (
                      <td
                        key={d.key}
                        className="px-2 py-1.5 text-right tabular-nums"
                      >
                        <span className={weightTone(bps)}>
                          {bps != null ? formatX(bps) : "—"}
                        </span>
                        {c != null && (
                          <span className="block text-[11px] text-muted-foreground">
                            {formatCurrency(c)}
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t font-medium">
                <td className="py-1.5 pr-2 text-left">Counts total</td>
                <td className="px-2 py-1.5 text-right tabular-nums">
                  {formatCurrency(availableBalanceUsd)}
                </td>
                {totals.map((t) => (
                  <td
                    key={t.key}
                    className="px-2 py-1.5 text-right tabular-nums"
                  >
                    {t.known ? formatCurrency(t.countsUsd) : "—"}
                  </td>
                ))}
              </tr>
            </tfoot>
          </table>
        </div>

        <p className="mt-3 border-t pt-2 text-[11px] leading-relaxed text-muted-foreground">
          <span className="inline-flex items-center gap-1 font-medium text-foreground">
            <Info className="size-3.5" /> How this works:
          </span>{" "}
          Weights are basis points (1× = counts the same as a deposit; 0× =
          doesn&apos;t count). Deposits &amp; organic game winnings are the 1×
          baseline; each bonus source counts at its configured rate. Weights
          apply at <span className="font-medium">wager time</span>, so these are
          the forward-looking value each part of the balance carries when
          wagered — the <span className="font-medium">Races / Leaderboards</span>{" "}
          rate further composes with the per-game weights (packs / battles /
          upgrader). Enforcement runs in the game backend.
          {!backendAvailable &&
            " The wager-weight backend config wasn't reachable, so the weights are hidden — the balance composition is still exact."}
        </p>
      </StatPanel>
    </div>
  );
}
