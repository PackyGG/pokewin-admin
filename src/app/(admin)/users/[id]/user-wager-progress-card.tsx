"use client";

/**
 * Per-user withdrawal wager-requirement PROGRESS (read-only display).
 *
 * Sibling to `user-wager-requirement-card.tsx` (which manages the per-user
 * override CONFIG). This card shows the user's actual progress toward that
 * requirement: total / completed / remaining + a per-source breakdown with
 * the contribution weighting, sourced read-only from the backend-written
 * `balances` columns (see `getUserWagerProgress`).
 *
 * `data === null` → the sweepstakes columns aren't on the connected DB
 * (prod) or the user has no balances row → render a muted "not available"
 * state instead of crashing the Account tab.
 *
 * House-POV finance colors (CLAUDE.md): requirement total / completed /
 * remaining are neutral INFO → blue/foreground; still-locked (un-wagered)
 * balance is user money we owe but gated → rose. Nothing is framed green.
 *
 * The `required` / `remaining` figures are DERIVED (total × bps) and labeled
 * as estimates; `completed` and the five lifetime totals are backend truth.
 */

import { Target, Gauge, Hourglass, Lock, Gem, AlertTriangle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { StatPanel, KpiTile } from "@/components/modern-panels";
import { formatCurrency } from "@/lib/utils/format";
import type { UserWagerProgress } from "@/lib/queries/users-wager-progress";

const BPS_PER_X = 10000;
const formatX = (bps: number): string =>
  `${(bps / BPS_PER_X).toLocaleString("en-US", { maximumFractionDigits: 2 })}×`;

export function UserWagerProgressCard({
  data,
}: {
  data: UserWagerProgress | null;
}) {
  if (!data) {
    return (
      <Card className="border-dashed">
        <CardContent className="pt-6">
          <div className="flex items-start gap-3 rounded-md border border-muted-foreground/30 bg-muted/40 p-3 text-xs text-muted-foreground">
            <AlertTriangle className="size-4 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-medium text-foreground">
                Wager progress not available
              </p>
              <p>
                This user has no balance record, or the connected database
                doesn&apos;t carry the sweepstakes wager-progress columns. No
                requirement progress can be shown.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  const {
    completedUsd,
    requiredUsd,
    remainingUsd,
    exempt,
    sources,
    totalLockedUsd,
    gameWeights,
    shards,
    shardWagerProgress,
    backendAvailable,
  } = data;

  const pct =
    requiredUsd && requiredUsd > 0
      ? Math.min(100, (completedUsd / requiredUsd) * 100)
      : null;

  return (
    <div className="space-y-3">
      {exempt && (
        <div className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs font-medium text-amber-600 dark:text-amber-400">
          <AlertTriangle className="size-4 shrink-0" />
          User is EXEMPT (0× override) — no wager requirement gates their
          withdrawals.
        </div>
      )}

      {/* Top KPIs — neutral/blue (info, not a user gain). */}
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
        <KpiTile
          icon={Target}
          label="Requirement"
          accent="blue"
          value={requiredUsd != null ? formatCurrency(requiredUsd) : "—"}
          sub={requiredUsd != null ? "estimated total" : "backend unavailable"}
        />
        <KpiTile
          icon={Gauge}
          label="Completed"
          accent="blue"
          value={formatCurrency(completedUsd)}
          sub="weighted wager cleared"
        />
        <KpiTile
          icon={Hourglass}
          label="Remaining"
          accent="blue"
          value={
            exempt
              ? "$0.00"
              : remainingUsd != null
                ? formatCurrency(remainingUsd)
                : "—"
          }
          sub={remainingUsd != null ? "left to wager" : "needs requirement"}
        />
      </div>

      {/* Progress bar (only meaningful when a requirement total is known). */}
      {pct != null && (
        <div className="space-y-1">
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-blue-500 motion-safe:transition-[width] motion-safe:duration-700"
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="text-[11px] tabular-nums text-muted-foreground">
            {pct.toFixed(1)}% complete
          </p>
        </div>
      )}

      {/* Per-source breakdown — auditable: shows total × multiplier =
          contribution, plus the still-locked (rose) balance per source. */}
      <StatPanel title="Per-source breakdown" icon={Target} accent="blue">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-[11px] uppercase tracking-wider text-muted-foreground">
                <th className="py-1.5 pr-2 text-left font-medium">Source</th>
                <th className="px-2 py-1.5 text-right font-medium">Lifetime</th>
                <th className="px-2 py-1.5 text-right font-medium">Weight</th>
                <th className="px-2 py-1.5 text-right font-medium">
                  Adds to req.
                </th>
                <th className="py-1.5 pl-2 text-right font-medium">Locked</th>
              </tr>
            </thead>
            <tbody>
              {sources.map((s) => (
                <tr key={s.key} className="border-b border-border/40 last:border-0">
                  <td className="py-1.5 pr-2 text-left">{s.label}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {formatCurrency(s.lifetimeTotalUsd)}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                    {s.requirementBps != null ? formatX(s.requirementBps) : "—"}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {s.contributionUsd != null
                      ? formatCurrency(s.contributionUsd)
                      : "—"}
                  </td>
                  <td className="py-1.5 pl-2 text-right tabular-nums">
                    {s.lockedUsd > 0 ? (
                      <span className="text-rose-600 dark:text-rose-400">
                        {formatCurrency(s.lockedUsd)}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t font-medium">
                <td className="py-1.5 pr-2 text-left">Total</td>
                <td className="px-2 py-1.5 text-right tabular-nums">—</td>
                <td className="px-2 py-1.5 text-right" />
                <td className="px-2 py-1.5 text-right tabular-nums">
                  {requiredUsd != null ? formatCurrency(requiredUsd) : "—"}
                </td>
                <td className="py-1.5 pl-2 text-right tabular-nums">
                  {totalLockedUsd > 0 ? (
                    <span className="text-rose-600 dark:text-rose-400">
                      {formatCurrency(totalLockedUsd)}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>

        {/* Game weights + shards (informational). */}
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
          {gameWeights && (
            <span className="inline-flex items-center gap-1.5">
              <Gauge className="size-3.5" />
              Game weights — packs {formatX(gameWeights.packsBps)} · battles{" "}
              {formatX(gameWeights.battlesBps)} · upgrader{" "}
              {formatX(gameWeights.upgraderBps)}
            </span>
          )}
          {shards > 0 && (
            <span className="inline-flex items-center gap-1.5">
              <Gem className="size-3.5" />
              {shards.toLocaleString("en-US")} shards ·{" "}
              {shardWagerProgress.toLocaleString("en-US", {
                maximumFractionDigits: 2,
              })}{" "}
              shard-wager progress
            </span>
          )}
          {totalLockedUsd > 0 && (
            <span className="inline-flex items-center gap-1.5">
              <Lock className="size-3.5" />
              {formatCurrency(totalLockedUsd)} still locked behind the
              requirement
            </span>
          )}
        </div>

        {/* Auditable formula + honest disclaimer. */}
        <p className="mt-3 border-t pt-2 text-[11px] leading-relaxed text-muted-foreground">
          <span className="font-medium text-foreground">How this is computed:</span>{" "}
          Requirement = Σ (source lifetime total × its multiplier). Remaining =
          max(0, requirement − completed). <span className="font-medium">Completed</span>{" "}
          and the lifetime totals are read directly from the backend-maintained{" "}
          <code className="font-mono">balances</code> columns; the requirement
          total and remaining are{" "}
          <span className="font-medium">estimated</span> from those inputs and
          should be reconciled against the backend&apos;s exact gating rule.
          {!backendAvailable &&
            " The wager-weight backend config wasn't reachable, so the estimate is unavailable — only the backend-truth completed + lifetime totals are shown."}
        </p>
      </StatPanel>
    </div>
  );
}
