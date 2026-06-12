"use client";

import * as React from "react";
import { Clock3, Ticket, Users } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { StatPanel, PanelRow } from "@/components/modern-panels";
import {
  formatCompactUsd,
  formatCurrency,
  formatDate,
  formatDateTime,
  formatNumber,
} from "@/lib/utils/format";
import type {
  RaffleHistoryRow,
  RaffleLifetimeHistory,
} from "@/lib/queries/insights-rewards/raffle/lifetime-history";
import { LeverSlider } from "../../../system-edge-plan/_planner-ui";
import {
  clamp,
  isLeverIncludedInEdgeV2,
  resolveLeverAnchorsV2,
  type EdgePlanV2Baseline,
  type EdgePlanV2Projection,
  type LiveRaffleInfo,
  type PlannedLeversV2,
} from "../../_model-v2";
import { TEXT_TONE } from "../colors";
import {
  EdgeInclusionToggle,
  InclusionAwareRewardTitle,
} from "../components/edge-inclusion-toggle";
import { EmptyLever, formatPercentInt } from "../components/empty-lever";
import { LeverHint } from "../components/lever-hint";
import { leverEdgeDragPct } from "../components/reward-edge-drag";

/**
 * RaffleKeepPanel — raffles in the 2026-06-12 overhaul: the three ×-multiplier
 * levers are GONE, replaced by ONE keep-slider (0–100%) that scales the real
 * 30d reconstructed raffle prize cost (`baseline.raffleCost`, valued at live
 * pack/card prices). 100% = keep the current program, 0% = raffles off.
 * The planned $ flows through the projection's "raffles" lever row.
 *
 * Below the slider: the currently-live (status=active) raffles as read-only
 * context cards from `baseline.liveRaffles`, then the LIFETIME history
 * (owner spec #10) — every raffle ever run (completed + active) from
 * `baseline.raffleHistory`, with the "Total raffle prize cost — all time"
 * line. The history is a listing scope (all raffles the house ran, live
 * prices); the 30d keep-slider planning basis is UNCHANGED and every block
 * is loudly window-labeled so the two never get conflated.
 *
 * Spec #14: the title row carries the "counts toward edge" switch.
 *
 * Prizes go OUT to users → house cost → House-POV rose.
 *
 * Consumed by `sections/giveaways.tsx` (the "Giveaways & budgets" workspace);
 * `RafflesSection` stays exported as a thin alias for any older wiring.
 */
export function RaffleKeepPanel({
  baseline,
  levers,
  projection,
  setLevers,
}: {
  baseline: EdgePlanV2Baseline;
  levers: PlannedLeversV2;
  projection: EdgePlanV2Projection;
  setLevers: React.Dispatch<React.SetStateAction<PlannedLeversV2>>;
}) {
  const keepPct = clamp(levers.raffleKeepPct, 0, 1);
  const windowLabel = baseline.periodLabel;

  // Anchored raffle cost — measured 30d reconstruction, falling back to the
  // live-raffle prize value when that leg degraded (lever stays LIVE).
  const raffleAnchor = React.useMemo(
    () => resolveLeverAnchorsV2(baseline).raffles,
    [baseline],
  );

  // Planned raffle prize cost from the shared "raffles" lever row.
  const rafflesLever = projection.levers.find((l) => l.key === "raffles");
  const plannedRaffleCost =
    rafflesLever?.plannedCost ?? raffleAnchor.anchorUsd * keepPct;

  return (
    <StatPanel
      title={
        <InclusionAwareRewardTitle
          label="Raffles"
          dragPct={leverEdgeDragPct(projection, "raffles")}
          included={isLeverIncludedInEdgeV2(levers, "raffles")}
        />
      }
      icon={Ticket}
      accent="rose"
      action={
        <EdgeInclusionToggle
          leverKey="raffles"
          levers={levers}
          setLevers={setLevers}
        />
      }
    >
      <p className="mb-2 text-xs leading-relaxed text-muted-foreground">
        In plain words: prizes we give away in ticket raffles — one slider
        keeps or cuts the whole program.
      </p>
      <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
        On-site ticket raffles — prizes pay out pack/card items, valued at the
        live price. Real reconstructed prize cost this window ({windowLabel}):{" "}
        <span className={`font-medium ${TEXT_TONE.rose}`}>
          {formatCurrency(baseline.raffleCost)}
        </span>
        . One keep-slider scales it: 100% keeps the current program, 0% turns
        raffles off. The planning basis is the {windowLabel.toLowerCase()}{" "}
        window — the all-time history further down is context, not the basis.
      </p>

      <PanelRow
        label={`Real reconstructed raffle prize cost (${windowLabel})`}
        value={
          <span className={`font-semibold ${TEXT_TONE.rose}`}>
            {formatCurrency(baseline.raffleCost)}
          </span>
        }
      />
      <PanelRow
        label={`Planned raffle prize cost (${windowLabel})`}
        value={
          <span className={`font-semibold ${TEXT_TONE.rose}`}>
            {formatCurrency(plannedRaffleCost)}
          </span>
        }
      />

      {raffleAnchor.estimated && raffleAnchor.anchorUsd > 0 && (
        <p className="mb-2 text-[11px] text-amber-600 dark:text-amber-400">
          Measured raffle-cost leg unavailable — anchoring the keep-slider on
          the live raffles&apos; prize value instead (estimated).
        </p>
      )}
      {raffleAnchor.anchorUsd <= 0 ? (
        <div className="mt-2">
          <EmptyLever note="No reconstructed raffle prize cost in this window — nothing to scale." />
        </div>
      ) : (
        <div className="mt-2">
          <LeverHint hint="Share of the current raffle program you keep. Cost scales straight with it — 50% halves the raffle prize spend, 0% removes it.">
            <LeverSlider
              label="Keep raffles at"
              valueLabel={formatPercentInt(keepPct * 100)}
              value={keepPct * 100}
              onValueChange={(pct) =>
                setLevers((s) => ({
                  ...s,
                  raffleKeepPct: clamp(pct / 100, 0, 1),
                }))
              }
              min={0}
              max={100}
              step={1}
              baselineMarker={100}
              baselineLabel={`100% = current program (real ${windowLabel.toLowerCase()} reconstructed cost)`}
              preciseInput={{ unit: "percent", decimals: 0 }}
            />
          </LeverHint>
        </div>
      )}

      {/* ── Currently-live raffles (read-only context) ──────────────────── */}
      <div className="mt-4 border-t pt-3">
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Currently live raffles · {formatNumber(baseline.liveRaffles.length)}
        </p>
        {baseline.liveRaffles.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">
            No raffle is live right now.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {baseline.liveRaffles.map((raffle) => (
              <LiveRaffleCard key={raffle.id} raffle={raffle} />
            ))}
          </div>
        )}
      </div>

      {/* ── All raffles ever (owner spec #10 — lifetime history) ─────────── */}
      <RaffleLifetimeHistoryBlock history={baseline.raffleHistory ?? null} />
    </StatPanel>
  );
}

const MAX_PRIZE_LINES = 3;

function LiveRaffleCard({ raffle }: { raffle: LiveRaffleInfo }) {
  const shown = raffle.prizes.slice(0, MAX_PRIZE_LINES);
  const hidden = raffle.prizes.length - shown.length;

  return (
    <div className="rounded-lg border bg-background/40 p-3">
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 truncate text-xs font-semibold text-foreground">
          {raffle.title ?? "Untitled raffle"}
        </p>
        <span
          className={`shrink-0 text-xs font-semibold tabular-nums ${TEXT_TONE.rose}`}
        >
          {formatCompactUsd(raffle.prizeValueUsd)}
        </span>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <Ticket className="size-3" aria-hidden />
          {formatNumber(raffle.totalEntries)} entries
        </span>
        <span className="inline-flex items-center gap-1">
          <Users className="size-3" aria-hidden />
          {formatNumber(raffle.participantCount)} participants
        </span>
        <span className="inline-flex items-center gap-1">
          <Clock3 className="size-3" aria-hidden />
          {raffle.endsAt ? `ends ${formatDateTime(raffle.endsAt)}` : "no end set"}
        </span>
      </div>

      {shown.length > 0 && (
        <div className="mt-2 space-y-0.5">
          {shown.map((line, i) => (
            <p
              key={`${line.type}-${line.id}-${i}`}
              className="flex items-center justify-between gap-2 text-[10px] tabular-nums text-muted-foreground"
            >
              <span className="min-w-0 truncate">
                {formatNumber(line.quantity)}× {line.type}
              </span>
              <span className="shrink-0">
                {formatCurrency(line.unitPriceUsd)} ea
              </span>
            </p>
          ))}
          {hidden > 0 && (
            <p className="text-[10px] text-muted-foreground/70">
              +{hidden} more prize line{hidden === 1 ? "" : "s"}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Lifetime raffle history (owner spec #10) ────────────────────────────────

/** Rows shown while collapsed — expanding reveals the rest, NO extra query. */
const HISTORY_COLLAPSED_ROWS = 10;

/**
 * Every raffle ever run (completed + active), one bounded additive query
 * already on the baseline (`getRaffleLifetimeHistory`, shared
 * prize-valuation at live prices). Collapsed beyond ~10 rows — "show all"
 * only reveals already-fetched rows. Null = the leg degraded this build →
 * loud band, never silent zeros.
 */
function RaffleLifetimeHistoryBlock({
  history,
}: {
  history: RaffleLifetimeHistory | null;
}) {
  const [showAll, setShowAll] = React.useState(false);

  return (
    <div className="mt-4 border-t pt-3">
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        All raffles ever · all time
        {history != null && (
          <span className="ml-1.5 font-normal normal-case tracking-normal">
            ({formatNumber(history.completedCount)} completed ·{" "}
            {formatNumber(history.activeCount)} active)
          </span>
        )}
      </p>

      {history == null ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-[11px] text-amber-800 dark:text-amber-200">
          The lifetime raffle-history read degraded this build — no history
          shown (never silent zeros). The 30d keep-slider planning basis
          above is unaffected. Reload to retry.
        </div>
      ) : (
        <>
          {history.truncated && (
            <div className="mb-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-800 dark:text-amber-200">
              The bounded history read hit its row cap — the listing and the
              all-time total under-count.
            </div>
          )}

          <div className="space-y-0.5">
            <PanelRow
              label="Total raffle prize cost — all time"
              value={
                <span className={`font-semibold ${TEXT_TONE.rose}`}>
                  {formatCurrency(history.completedPrizeCostUsd)}
                </span>
              }
            />
            <PanelRow
              label="Committed on active raffles (not yet awarded)"
              value={
                <span className={`${TEXT_TONE.rose}`}>
                  {formatCurrency(history.activePrizeValueUsd)}
                </span>
              }
            />
          </div>

          {history.rows.length === 0 ? (
            <p className="mt-2 text-[11px] text-muted-foreground">
              No raffle has ever been run.
            </p>
          ) : (
            <>
              <div className="mt-2 overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Raffle</TableHead>
                      <TableHead className="text-right">Prize value</TableHead>
                      <TableHead className="text-right">Entries</TableHead>
                      <TableHead className="text-right">Participants</TableHead>
                      <TableHead>End date</TableHead>
                      <TableHead className="text-right">Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(showAll
                      ? history.rows
                      : history.rows.slice(0, HISTORY_COLLAPSED_ROWS)
                    ).map((row) => (
                      <RaffleHistoryTableRow key={row.id} row={row} />
                    ))}
                  </TableBody>
                </Table>
              </div>

              {history.rows.length > HISTORY_COLLAPSED_ROWS && (
                <button
                  type="button"
                  onClick={() => setShowAll((v) => !v)}
                  className="mt-1.5 text-[11px] font-medium text-muted-foreground underline-offset-2 hover:underline"
                >
                  {showAll
                    ? "Collapse"
                    : `Show all ${formatNumber(history.rows.length)} raffles`}
                </button>
              )}
            </>
          )}

          <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
            History listing scope: every raffle the house ran, valued at live
            prices via the shared prize-valuation helper — not customer-scoped
            like the 30d planning anchor above, so the all-time total can
            sit slightly above the scoped cost. Expanding reveals
            already-loaded rows only (no extra query).
          </p>
        </>
      )}
    </div>
  );
}

function RaffleHistoryTableRow({ row }: { row: RaffleHistoryRow }) {
  const endDate =
    row.status === "completed"
      ? (row.completedAtIso ?? row.endsAtIso)
      : row.endsAtIso;
  return (
    <TableRow>
      <TableCell
        className="max-w-[180px] truncate text-xs font-medium"
        title={row.title ?? undefined}
      >
        {row.title ?? "Untitled raffle"}
      </TableCell>
      <TableCell
        className={`text-right text-xs font-semibold tabular-nums ${TEXT_TONE.rose}`}
      >
        {formatCurrency(row.prizeValueUsd)}
      </TableCell>
      <TableCell className="text-right text-xs tabular-nums">
        {formatNumber(row.totalEntries)}
      </TableCell>
      <TableCell className="text-right text-xs tabular-nums">
        {formatNumber(row.participantCount)}
      </TableCell>
      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
        {endDate != null
          ? row.status === "active"
            ? `ends ${formatDate(endDate)}`
            : formatDate(endDate)
          : "—"}
      </TableCell>
      <TableCell className="text-right">
        <Badge
          variant="outline"
          className={
            row.status === "active"
              ? `text-[10px] ${TEXT_TONE.blue}`
              : "text-[10px] text-muted-foreground"
          }
        >
          {row.status}
        </Badge>
      </TableCell>
    </TableRow>
  );
}

/** Back-compat alias — older wiring imported `RafflesSection`. */
export { RaffleKeepPanel as RafflesSection };
