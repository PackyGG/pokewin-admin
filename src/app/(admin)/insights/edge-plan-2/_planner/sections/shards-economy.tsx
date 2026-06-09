"use client";

import * as React from "react";
import { Gem } from "lucide-react";

import { StatPanel, PanelRow } from "@/components/modern-panels";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/utils/format";
import { LeverSlider } from "../../../system-edge-plan/_planner-ui";
import { PackFirstTunerCard } from "../../_pack-visual-v2";
import {
  clamp,
  type EdgePlanV2Baseline,
  type EdgePlanV2Projection,
  type PlannedLeversV2,
} from "../../_model-v2";
import {
  formatEvUsd,
  MAX_WAGER_PER_GEM_USD,
  MIN_WAGER_PER_GEM_USD,
  multLabel,
  shardsPerDollarFromWagerPerGem,
  wagerPerGemFromShardsPerDollar,
  wagerPerGemLabel,
} from "../utils";
import { leverEdgeDragPct, RewardPanelTitle } from "../components/reward-edge-drag";

export function ShardsEconomySection({
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
  const dataBadge =
    baseline.shardsDataSource === "raffle_proxy"
      ? "Baseline from raffle prize proxy"
      : baseline.shardsDataSource === "backend"
        ? "Live backend"
        : "Planning default";

  return (
    <div className="space-y-4">
      <StatPanel
        title={
          <RewardPanelTitle
            label="Shards earn"
            dragPct={leverEdgeDragPct(projection, "shards-earn")}
          />
        }
        icon={Gem}
        accent="purple"
      >
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="text-[10px]">
            {dataBadge}
          </Badge>
          <span className="text-xs text-muted-foreground">
            Set how much wager earns one gem (replaces raffle tickets). Spend shifts to shard shop packs.
          </span>
        </div>
        <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
          <LeverSlider
            label="Wager per gem"
            valueLabel={wagerPerGemLabel(
              wagerPerGemFromShardsPerDollar(levers.shardsPerDollarWager),
            )}
            value={wagerPerGemFromShardsPerDollar(levers.shardsPerDollarWager)}
            onValueChange={(v) =>
              setLevers((s) => ({
                ...s,
                shardsPerDollarWager: shardsPerDollarFromWagerPerGem(
                  clamp(v, MIN_WAGER_PER_GEM_USD, MAX_WAGER_PER_GEM_USD),
                ),
              }))
            }
            min={MIN_WAGER_PER_GEM_USD}
            max={MAX_WAGER_PER_GEM_USD}
            step={0.5}
            baselineMarker={wagerPerGemFromShardsPerDollar(
              baseline.shardsPerDollarWager,
            )}
            baselineLabel="Baseline earn rate"
            preciseInput={{ unit: "usd", decimals: 2 }}
          />
          <LeverSlider
            label="Earn rate mult."
            valueLabel={multLabel(levers.shardEarnMult)}
            value={levers.shardEarnMult * 100}
            onValueChange={(v) =>
              setLevers((s) => ({ ...s, shardEarnMult: clamp(v / 100, 0, 5) }))
            }
            min={0}
            max={500}
            step={1}
            baselineMarker={100}
            baselineLabel="1× = baseline intensity"
            preciseInput={{ unit: "multiplier" }}
          />
          <LeverSlider
            label="Redemption intensity"
            valueLabel={multLabel(levers.shardRedemptionMult)}
            value={levers.shardRedemptionMult * 100}
            onValueChange={(v) =>
              setLevers((s) => ({
                ...s,
                shardRedemptionMult: clamp(v / 100, 0, 5),
              }))
            }
            min={0}
            max={500}
            step={1}
            baselineMarker={100}
            preciseInput={{ unit: "multiplier" }}
          />
          <LeverSlider
            label="Packs+battles earn weight"
            valueLabel={`${(levers.shardPackBattleWeight * 100).toFixed(0)}%`}
            value={levers.shardPackBattleWeight * 100}
            onValueChange={(v) =>
              setLevers((s) => ({
                ...s,
                shardPackBattleWeight: clamp(v / 100, 0, 1),
              }))
            }
            min={0}
            max={100}
            step={1}
            baselineMarker={100}
          />
          <LeverSlider
            label="Upgrader earn weight"
            valueLabel={`${(levers.shardUpgraderWeight * 100).toFixed(0)}%`}
            value={levers.shardUpgraderWeight * 100}
            onValueChange={(v) =>
              setLevers((s) => ({
                ...s,
                shardUpgraderWeight: clamp(v / 100, 0, 1),
              }))
            }
            min={0}
            max={100}
            step={1}
            baselineMarker={100}
            disabled={
              !baseline.gameTypes.some(
                (g) => g.type === "upgrader" && g.dataAvailable,
              )
            }
          />
        </div>
        <div className="mt-3 border-t pt-3">
          <PanelRow
            label="Redemption cost proxy (window)"
            value={formatCurrency(baseline.shardsRedemptionCost)}
          />
        </div>
      </StatPanel>

      <StatPanel
        title={
          <RewardPanelTitle
            label="Shard shop packs"
            dragPct={leverEdgeDragPct(projection, "shards")}
          />
        }
        icon={Gem}
        accent="pink"
      >
        <p className="mb-4 text-xs text-muted-foreground">
          Plan EV per pack before prod shop packs exist. Pack art above each slider.
        </p>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {baseline.shardShopRows.map((p) => {
            const plannedEv =
              levers.shardShopPackEvUsd[p.packId] ?? p.measuredEvUsd;
            return (
              <PackFirstTunerCard
                key={p.packId}
                packId={p.packId}
                name={p.name}
                slug={p.slug}
                imageUrl={p.imageUrl}
                cardPreviews={p.cardPreviews}
                measuredEvUsd={p.measuredEvUsd}
                plannedEvUsd={plannedEv}
                badge="Shard shop"
                subtitle={`${p.shardPrice} shards · ${p.redemptionsBaseline} redemptions`}
                inactive={p.redemptionsBaseline === 0}
                slider={
                  <LeverSlider
                    label="Planned EV / open"
                    valueLabel={formatEvUsd(plannedEv)}
                    value={plannedEv}
                    onValueChange={(usd) =>
                      setLevers((s) => ({
                        ...s,
                        shardShopPackEvUsd: {
                          ...s.shardShopPackEvUsd,
                          [p.packId]: Math.max(0, usd),
                        },
                      }))
                    }
                    min={0}
                    max={Math.max(50, plannedEv * 3, p.measuredEvUsd * 3, 10)}
                    step={0.01}
                    preciseInput={{ unit: "usd", decimals: 2 }}
                  />
                }
              />
            );
          })}
        </div>
      </StatPanel>
    </div>
  );
}
