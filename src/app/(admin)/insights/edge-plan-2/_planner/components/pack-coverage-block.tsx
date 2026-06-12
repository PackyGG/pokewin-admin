"use client";

import { Scale } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { StatPanel } from "@/components/modern-panels";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/utils/format";
import { LeverSlider } from "../../../system-edge-plan/_planner-ui";
import { formatPct, formatSignedUsd } from "../../../edge-calc/math";
import {
  RELOCK_WINDOW_DAYS,
  type PackCoverageAggregate,
  type PackCoverageResult,
} from "../../_pack-coverage-v2";
import { houseAccent, TEXT_TONE } from "../colors";
import { EmptyLever } from "./empty-lever";
import { LeverHint } from "./lever-hint";

/**
 * One daily pack's coverage result prepared by the section for display.
 *
 * `gateUnpriced` marks packs whose level gate exists but has NO empirical $
 * value yet (no player has reached the level → no wager-loss boundary). Those
 * packs are listed for context but EXCLUDED from the aggregate — including
 * them at $0 required loss would silently drag the ratio down with a number
 * we don't actually know.
 */
export type PackCoverageDisplayRow = {
  packId: string;
  name: string;
  gateUnpriced: boolean;
  result: PackCoverageResult;
};

function ratioLabel(ratio: number | null): string {
  if (ratio == null) return "n/a";
  return `${ratio.toFixed(2)}×`;
}

/** House-POV: coverage ≥ 1 = required loss covers the giveback → emerald. */
function ratioTone(ratio: number | null): string {
  if (ratio == null) return "text-muted-foreground";
  return ratio >= 1 ? TEXT_TONE.emerald : TEXT_TONE.rose;
}

/**
 * Wager-loss-vs-giveback coverage panel for the daily packs program.
 *
 * Pure display over the shipped `_pack-coverage-v2` module — the section owns
 * the inputs (per-pack EV / re-lock levers + grant frequency) and the LOCAL
 * incrementality state; this panel renders the aggregate + per-pack ratios
 * and hosts the one slider. No lever / model changes.
 */
export function PackCoverageBlock({
  aggregate,
  rows,
  incrementality,
  onIncrementalityChange,
  windowDays,
}: {
  /** Aggregate over PRICED packs only (see `PackCoverageDisplayRow`). */
  aggregate: PackCoverageAggregate;
  rows: PackCoverageDisplayRow[];
  /** Local planning assumption (0..1), owned by the section. */
  incrementality: number;
  onIncrementalityChange: (next: number) => void;
  /** Days the opens/usage figures were measured over (baseline window). */
  windowDays: number;
}) {
  const unpriced = rows.filter((r) => r.gateUnpriced);
  const pricedCount = rows.length - unpriced.length;
  const unpricedGiveback = unpriced.reduce(
    (s, r) => s + r.result.givebackUsd30d,
    0,
  );
  const profitTone =
    TEXT_TONE[houseAccent(aggregate.theoreticalIncrementalProfitUsd30d)];
  const floorUsd = -aggregate.givebackUsd30d;

  return (
    <StatPanel title="Wager-loss vs giveback coverage" icon={Scale} accent="emerald">
      <p className="mb-2 text-[11px] leading-relaxed text-muted-foreground">
        In plain words: to keep these packs unlocked, players must show fresh
        wager-loss every {RELOCK_WINDOW_DAYS} days (the re-lock gate). This
        panel checks whether that required loss flow covers what the packs
        give back —{" "}
        {aggregate.coverageRatio != null
          ? `right now every $1 of giveback sits behind ${ratioLabel(aggregate.coverageRatio)} of required loss.`
          : "right now there is no giveback flow to cover."}
      </p>
      <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
        Honest accounting: the gated loss is ALREADY inside GGR — players were
        losing this money before the program existed. Coverage is protection,
        not free money; never add the required loss to profit wholesale. Only
        the share that would not happen without the program (the
        incrementality assumption below) may be credited — the giveback is
        always a real cost.
      </p>

      {rows.length === 0 ? (
        <EmptyLever note="No daily-pack claimers in this window — no coverage flows to measure." />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-lg border bg-muted/20 px-3 py-2">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Required re-lock loss /{RELOCK_WINDOW_DAYS}d
              </p>
              <p
                className={`text-lg font-bold tabular-nums ${TEXT_TONE.emerald}`}
              >
                {formatCurrency(aggregate.requiredLossFlowUsd30d)}
              </p>
              <p className="text-[10px] leading-snug text-muted-foreground">
                already inside GGR — coverage, not new profit
              </p>
            </div>
            <div className="rounded-lg border border-rose-500/20 bg-rose-500/10 px-3 py-2">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Planned giveback /{RELOCK_WINDOW_DAYS}d
              </p>
              <p className={`text-lg font-bold tabular-nums ${TEXT_TONE.rose}`}>
                {formatCurrency(aggregate.givebackUsd30d)}
              </p>
              <p className="text-[10px] leading-snug text-muted-foreground">
                EV × opens × frequency, normalized to {RELOCK_WINDOW_DAYS}d
              </p>
            </div>
            <div className="rounded-lg border bg-muted/20 px-3 py-2">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Coverage ratio
              </p>
              <p
                className={`text-lg font-bold tabular-nums ${ratioTone(aggregate.coverageRatio)}`}
              >
                {ratioLabel(aggregate.coverageRatio)}
              </p>
              <p className="text-[10px] leading-snug text-muted-foreground">
                required loss ÷ giveback — ≥1.00× means fully covered
              </p>
            </div>
            <div className="rounded-lg border bg-muted/20 px-3 py-2">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Theoretical incremental profit /{RELOCK_WINDOW_DAYS}d
              </p>
              <p className={`text-lg font-bold tabular-nums ${profitTone}`}>
                {formatSignedUsd(aggregate.theoreticalIncrementalProfitUsd30d)}
              </p>
              <p className="text-[10px] leading-snug text-muted-foreground">
                at {formatPct(incrementality, 0)} incrementality assumption
              </p>
            </div>
          </div>

          <p className="mt-2 text-[10px] leading-snug text-muted-foreground">
            {aggregate.totalClaimers.toLocaleString()} claimers across{" "}
            {pricedCount} priced pack{pricedCount === 1 ? "" : "s"} · one-time
            unlock stock {formatCurrency(aggregate.oneTimeUnlockLossUsd)}{" "}
            (context only — unlock happens once per user, never in the ratio) ·
            giveback measured over the {windowDays}-day window, normalized to{" "}
            {RELOCK_WINDOW_DAYS}d to match the re-lock cadence. Per-pack EV,
            grant frequency and re-lock levers feed straight into these flows.
          </p>

          <div className="mt-3 rounded-xl border bg-muted/25 p-3">
            <LeverHint hint="Planning assumption — the share of the re-lock-gated loss that would NOT happen without the pack program. Only that share is credited as incremental profit; the giveback is always a real cost.">
              <LeverSlider
                label="Incrementality assumption"
                valueLabel={formatPct(incrementality, 0)}
                value={incrementality * 100}
                onValueChange={(v) =>
                  onIncrementalityChange(Math.min(1, Math.max(0, v / 100)))
                }
                min={0}
                max={100}
                step={1}
                baselineMarker={0}
                baselineLabel="0% = honest floor (pure giveback cost)"
                preciseInput={{ unit: "percent", decimals: 0 }}
              />
            </LeverHint>
            <p className="mt-1 text-[10px] leading-snug text-muted-foreground">
              At 0% the program credits no loss at all and costs exactly its
              giveback: {formatSignedUsd(floorUsd)}/{RELOCK_WINDOW_DAYS}d — the
              honest floor, shown unclamped.
            </p>
          </div>

          <div className="mt-3 space-y-2">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Per-pack coverage
            </p>
            {rows.map((r) => (
              <div
                key={r.packId}
                className="rounded-lg border bg-muted/15 px-2.5 py-2"
              >
                <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                  <p className="min-w-0 flex-1 truncate text-[11px] font-medium">
                    {r.name}
                  </p>
                  {r.gateUnpriced ? (
                    <Badge
                      variant="outline"
                      className={`px-1.5 py-0 text-[9px] ${TEXT_TONE.amber}`}
                    >
                      no $ basis — excluded from totals
                    </Badge>
                  ) : (
                    <span
                      className={cn(
                        "shrink-0 text-[11px] font-bold tabular-nums",
                        ratioTone(r.result.coverageRatio),
                      )}
                    >
                      {ratioLabel(r.result.coverageRatio)}
                    </span>
                  )}
                </div>
                <div className="mt-1 grid grid-cols-1 gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground sm:grid-cols-2">
                  <span>
                    Required loss flow:{" "}
                    <span className="font-semibold tabular-nums">
                      {r.gateUnpriced
                        ? "unknown"
                        : formatCurrency(r.result.requiredLossFlowUsd30d)}
                    </span>
                    /{RELOCK_WINDOW_DAYS}d
                  </span>
                  <span className="sm:text-right">
                    Giveback:{" "}
                    <span className="font-semibold tabular-nums">
                      {formatCurrency(r.result.givebackUsd30d)}
                    </span>
                    /{RELOCK_WINDOW_DAYS}d
                  </span>
                </div>
              </div>
            ))}
            {unpriced.length > 0 ? (
              <p className="text-[10px] leading-snug text-muted-foreground">
                {unpriced.length} pack{unpriced.length === 1 ? " has" : "s have"}{" "}
                a level gate with no empirical $ basis yet (no player at that
                level) — excluded from the totals above; their giveback runs{" "}
                {formatCurrency(unpricedGiveback)}/{RELOCK_WINDOW_DAYS}d.
              </p>
            ) : null}
          </div>
        </>
      )}
    </StatPanel>
  );
}
