"use client";

import * as React from "react";
import { RotateCcw } from "lucide-react";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatCompactUsd, formatCurrency } from "@/lib/utils/format";
import {
  depositFeeDefaultSelectedAssets,
  depositFeeRevenueUsd,
  depositFeeSelectedVolumeUsd,
  resolvedDepositFeeAssets,
  type EdgePlanV2Baseline,
  type PlannedLeversV2,
} from "../../_model-v2";
import { EmptyLever } from "./empty-lever";

/**
 * DepositFeeControls — coin chips multi-select for the deposit-fee revenue
 * lever, driven by the REAL 30d per-asset deposit volume on the baseline
 * (`depositsByAsset`, ledger `crypto_asset` + `deposit_addresses.asset_id`).
 *
 *  - `depositFeeSelectedAssets === null` = the DEFAULT selection (every coin
 *    except the USDT family — USDT* chips are marked "exempt by default" but
 *    stay clickable for what-if modeling).
 *  - The first chip toggle materializes the resolved list; "Reset" returns
 *    to `null` so presets keep round-tripping against a fresh baseline.
 *  - Revenue readout is EMERALD (house income — house-POV color law).
 */
export function DepositFeeControls({
  baseline,
  levers,
  setLevers,
}: {
  baseline: Pick<EdgePlanV2Baseline, "depositsByAsset" | "periodDays">;
  levers: PlannedLeversV2;
  setLevers: React.Dispatch<React.SetStateAction<PlannedLeversV2>>;
}) {
  const assets = baseline.depositsByAsset;
  const selected = React.useMemo(
    () => new Set(resolvedDepositFeeAssets(baseline, levers)),
    [baseline, levers],
  );
  const defaultSelection = React.useMemo(
    () => new Set(depositFeeDefaultSelectedAssets(baseline)),
    [baseline],
  );

  const totalVolumeUsd = assets.reduce(
    (s, a) => s + Math.max(0, a.volumeUsd),
    0,
  );
  const selectedVolumeUsd = depositFeeSelectedVolumeUsd(baseline, levers);
  const revenueWindowUsd = depositFeeRevenueUsd(baseline, levers);
  const days = Math.max(1, baseline.periodDays);
  const revenueMonthlyUsd = (revenueWindowUsd / days) * 30;
  const selectedShare =
    totalVolumeUsd > 0 ? selectedVolumeUsd / totalVolumeUsd : 0;

  const toggleAsset = (asset: string) => {
    setLevers((s) => {
      const current = resolvedDepositFeeAssets(baseline, s);
      const next = current.includes(asset)
        ? current.filter((a) => a !== asset)
        : [...current, asset];
      return { ...s, depositFeeSelectedAssets: next };
    });
  };

  if (assets.length === 0) {
    return (
      <EmptyLever note="No completed deposits found in the 30-day window (or the per-coin scan timed out) — there is no coin volume to apply a fee to." />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">Coins charged the fee</span>
        {levers.depositFeeSelectedAssets != null && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 gap-1 px-2 text-[11px] text-muted-foreground"
            onClick={() =>
              setLevers((s) => ({ ...s, depositFeeSelectedAssets: null }))
            }
          >
            <RotateCcw className="size-3" />
            Reset to default
          </Button>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {assets.map((a) => {
          const isSelected = selected.has(a.asset);
          // Anything the model excludes from the default selection (the
          // USDT family) is flagged as fee-exempt-by-default on its chip.
          const exemptByDefault = !defaultSelection.has(a.asset);
          return (
            <button
              key={a.asset}
              type="button"
              aria-pressed={isSelected}
              onClick={() => toggleAsset(a.asset)}
              title={`${a.asset} · ${a.count} deposits · ${formatCurrency(a.volumeUsd)} (30d)`}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
                isSelected
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                  : "border-border bg-background/40 text-muted-foreground hover:bg-muted/40",
              )}
            >
              <span>{a.asset}</span>
              <span
                className={cn(
                  "tabular-nums",
                  isSelected
                    ? "text-emerald-600/70 dark:text-emerald-400/70"
                    : "text-muted-foreground/60",
                )}
              >
                {formatCompactUsd(a.volumeUsd)}
              </span>
              {exemptByDefault && (
                <span className="rounded-full border border-border/60 bg-muted/40 px-1.5 py-px text-[9px] font-normal uppercase tracking-wide text-muted-foreground">
                  exempt by default
                </span>
              )}
            </button>
          );
        })}
      </div>

      <p className="text-[11px] leading-snug text-muted-foreground/80">
        Click a coin to include/exclude it. USDT-family deposits are exempt by
        default; selecting them is what-if only. Volumes are real 30-day
        completed-deposit USD per coin.
      </p>

      <div className="rounded-lg border bg-background/40 px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="text-[10px]">
            {selected.size} of {assets.length} coins
          </Badge>
          <span className="text-[11px] text-muted-foreground">
            Selected volume {formatCurrency(selectedVolumeUsd)} of{" "}
            {formatCurrency(totalVolumeUsd)} ({(selectedShare * 100).toFixed(0)}
            %)
          </span>
        </div>
        <p className="mt-1.5 text-sm font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
          +{formatCurrency(revenueWindowUsd)}{" "}
          <span className="font-normal text-emerald-600/70 dark:text-emerald-400/70">
            fee revenue / 30d window · ≈ {formatCurrency(revenueMonthlyUsd)} /
            mo
          </span>
        </p>
        {levers.depositFeePct <= 0 && (
          <p className="mt-1 text-[11px] text-muted-foreground">
            Fee is 0% — set a fee above to project revenue.
          </p>
        )}
      </div>
    </div>
  );
}
