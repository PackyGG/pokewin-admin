"use client";

import * as React from "react";
import { Gem, Package } from "lucide-react";

import { PanelRow, StatPanel } from "@/components/modern-panels";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { formatPct } from "../../../edge-calc/math";
import { LeverSlider } from "../../../system-edge-plan/_planner-ui";
import {
  clamp,
  SHARD_CASES,
  SHARDS_DEFAULT_EV_PER_SHARD_USD,
  SHARDS_DEFAULT_WAGER_PER_SHARD_USD,
  SHARDS_TARGET_GIVEBACK,
  effectiveShardGiveback,
  shardCaseValueUsd,
  shardConfigFromLevers,
  shardMonthlyCost,
  shardTypeWagerFromBaseline,
  weightedShardWager,
  type EdgePlanV2Baseline,
  type EdgePlanV2Projection,
  type PlannedLeversV2,
} from "../../_model-v2";
import { shardsEarnedInWindow } from "../../_shards-v2";
import { TEXT_TONE } from "../colors";
import { formatEvUsd } from "../utils";
import { EmptyLever } from "../components/empty-lever";
import { LeverHint } from "../components/lever-hint";
import {
  leverEdgeDragPct,
  RewardPanelTitle,
} from "../components/reward-edge-drag";

/**
 * ShardsSection — the NEW shard economy (Edge Plan 2.0 spec, 2026-06-12).
 *
 * Owner spec: users mint 1 shard per $X wagered (default $20), each shard
 * carries an expected house cost of $Y when redeemed in the shard shop
 * (default $0.06), per-gamemode earn weights (owner hint: upgrader earns at
 * ~50%), and the program is tuned against a 0.3%-of-wager giveback target.
 *
 * All math lives in `_shards-v2.ts` (pure, frozen core) — this section only
 * renders it. Shards default OFF → $0 in the projection at mount (the
 * default-zero invariant). House-POV: shard cost = house pays → rose; an
 * effective giveback at/below the 0.3% target renders emerald, above target
 * renders amber (budget warning, not yet a measured loss).
 */
export function ShardsSection({
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
  const typeWager = React.useMemo(
    () => shardTypeWagerFromBaseline(baseline),
    [baseline],
  );
  const config = React.useMemo(() => shardConfigFromLevers(levers), [levers]);

  const earningWager = weightedShardWager(typeWager, config.weights);
  const windowShards = shardsEarnedInWindow(typeWager, config);
  const periodDays =
    Number.isFinite(baseline.periodDays) && baseline.periodDays > 0
      ? baseline.periodDays
      : 30;
  const monthlyShards = (windowShards / periodDays) * 30;
  const monthlyCost = shardMonthlyCost(typeWager, config, baseline.periodDays);
  const giveback = effectiveShardGiveback(typeWager, config);
  const aboveTarget = giveback > SHARDS_TARGET_GIVEBACK + 1e-9;
  const givebackTone = aboveTarget ? TEXT_TONE.amber : TEXT_TONE.emerald;

  const setWeight =
    (key: "shardsPacksWeight" | "shardsBattlesWeight" | "shardsUpgraderWeight") =>
    (pct: number) =>
      setLevers((s) => ({ ...s, [key]: clamp(pct / 100, 0, 1) }));

  return (
    <div className="space-y-4">
      <StatPanel
        title={
          <RewardPanelTitle
            label="Shard program"
            dragPct={leverEdgeDragPct(projection, "shards")}
          />
        }
        icon={Gem}
        accent="purple"
      >
        <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
          In plain words: players mint shards as they bet and spend them in
          the shard shop — every shard costs the house a few cents.
        </p>
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-medium">Enable shard program</div>
            <p className="text-[11px] leading-snug text-muted-foreground">
              OFF (the default) contributes $0 to the projection. ON models
              issuance + cost from this window&apos;s real wager.
            </p>
          </div>
          <Switch
            checked={levers.shardsEnabled}
            onCheckedChange={(v) =>
              setLevers((s) => ({ ...s, shardsEnabled: v === true }))
            }
            aria-label="Enable shard program"
          />
        </div>

        {!levers.shardsEnabled ? (
          <EmptyLever note="Shards are OFF — the projection includes $0 shard cost. Toggle on to model the program (spec defaults: $20 wager per shard, $0.06 EV per shard → 0.30% giveback at full weights)." />
        ) : (
          <>
            <div className="grid gap-4 lg:grid-cols-2">
              <LeverHint hint="Dollars a user must wager to mint one shard. Higher = fewer shards minted = less house cost.">
                <LeverSlider
                  label="Wager per shard"
                  valueLabel={formatEvUsd(levers.shardsWagerPerShardUsd)}
                  value={levers.shardsWagerPerShardUsd}
                  onValueChange={(v) =>
                    setLevers((s) => ({
                      ...s,
                      shardsWagerPerShardUsd: clamp(v, 1, 100),
                    }))
                  }
                  min={1}
                  max={100}
                  step={0.5}
                  baselineMarker={SHARDS_DEFAULT_WAGER_PER_SHARD_USD}
                  baselineLabel="Spec default — $20 per shard"
                  preciseInput={{ unit: "usd", decimals: 2 }}
                />
              </LeverHint>
              <LeverHint hint="Expected house cost when a shard is eventually redeemed in the shard shop (shop packs are priced so EV per shard lands here).">
                <LeverSlider
                  label="EV per shard"
                  valueLabel={formatEvUsd(levers.shardsEvPerShardUsd)}
                  value={levers.shardsEvPerShardUsd}
                  onValueChange={(v) =>
                    setLevers((s) => ({
                      ...s,
                      shardsEvPerShardUsd: clamp(v, 0, 0.25),
                    }))
                  }
                  min={0}
                  max={0.25}
                  step={0.01}
                  baselineMarker={SHARDS_DEFAULT_EV_PER_SHARD_USD}
                  baselineLabel="Spec default — $0.06 per shard"
                  preciseInput={{ unit: "usd", decimals: 2 }}
                />
              </LeverHint>
              <LeverHint
                hint={`Packs wager this window: ${formatCurrency(typeWager.packs)}. The weight scales how much of it mints shards.`}
              >
                <LeverSlider
                  label="Packs earn weight"
                  valueLabel={`${Math.round(clamp(levers.shardsPacksWeight, 0, 1) * 100)}%`}
                  value={clamp(levers.shardsPacksWeight, 0, 1) * 100}
                  onValueChange={setWeight("shardsPacksWeight")}
                  min={0}
                  max={100}
                  step={1}
                  baselineMarker={100}
                  baselineLabel="100% = full earn"
                />
              </LeverHint>
              <LeverHint
                hint={`Battles wager this window: ${formatCurrency(typeWager.battles)}. The weight scales how much of it mints shards.`}
              >
                <LeverSlider
                  label="Battles earn weight"
                  valueLabel={`${Math.round(clamp(levers.shardsBattlesWeight, 0, 1) * 100)}%`}
                  value={clamp(levers.shardsBattlesWeight, 0, 1) * 100}
                  onValueChange={setWeight("shardsBattlesWeight")}
                  min={0}
                  max={100}
                  step={1}
                  baselineMarker={100}
                  baselineLabel="100% = full earn"
                />
              </LeverHint>
              <LeverHint
                hint={`Upgrader wager this window: ${formatCurrency(typeWager.upgrader)}. Owner hint: earn at ~50% so upgrader grinding mints fewer shards.`}
              >
                <LeverSlider
                  label="Upgrader earn weight"
                  valueLabel={`${Math.round(clamp(levers.shardsUpgraderWeight, 0, 1) * 100)}%`}
                  value={clamp(levers.shardsUpgraderWeight, 0, 1) * 100}
                  onValueChange={setWeight("shardsUpgraderWeight")}
                  min={0}
                  max={100}
                  step={1}
                  baselineMarker={50}
                  baselineLabel="Owner hint — upgrader earns at 50%"
                />
              </LeverHint>
            </div>

            <div className="mt-4 space-y-0.5 border-t pt-3">
              <PanelRow
                label="Shard-earning wager (window, weighted)"
                value={formatCurrency(earningWager)}
              />
              <PanelRow
                label="Monthly shard issuance"
                value={`${formatNumber(Math.round(monthlyShards))} shards`}
              />
              <PanelRow
                label="Monthly program cost"
                value={formatCurrency(monthlyCost)}
                valueClassName={TEXT_TONE.rose}
              />
              <PanelRow
                label={`Effective giveback (target ${formatPct(SHARDS_TARGET_GIVEBACK, 2)} of wager)`}
                value={`${formatPct(giveback, 3)} of wager`}
                valueClassName={givebackTone}
              />
            </div>
            <p className="mt-2 text-[11px] leading-snug text-muted-foreground/80">
              Giveback = shard cost ÷ total window wager. At full weights, $20
              per shard and $0.06 EV it sits exactly on the 0.30% target —
              emerald at/below target, amber above.
            </p>
          </>
        )}
      </StatPanel>

      <StatPanel title="Shard shop cases" icon={Package} accent="pink">
        <p className="mb-2 text-xs leading-relaxed text-muted-foreground">
          In plain words: what each shard-shop case costs us on average when
          it&apos;s opened.
        </p>
        <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
          The fixed 10-case shard-shop ladder. Expected house cost per case =
          shards × EV per shard ({formatEvUsd(levers.shardsEvPerShardUsd)}) —
          the table re-prices live when the EV input moves.
        </p>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Case</TableHead>
              <TableHead className="text-right">Shards</TableHead>
              <TableHead className="text-right">Expected cost</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {SHARD_CASES.map((c) => (
              <TableRow key={c.name}>
                <TableCell className="font-medium">{c.name}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatNumber(c.shards)}
                </TableCell>
                <TableCell
                  className={`text-right tabular-nums ${TEXT_TONE.rose}`}
                >
                  {formatCurrency(
                    shardCaseValueUsd(c, levers.shardsEvPerShardUsd),
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </StatPanel>
    </div>
  );
}
