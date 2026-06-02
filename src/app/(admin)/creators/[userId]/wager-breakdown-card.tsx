import { Coins, TrendingUp } from "lucide-react";

import { StatPanel, PanelRow } from "@/components/modern-panels";
import { formatCurrency } from "@/lib/utils/format";
import { InfoHint } from "../_components/info-hint";

/**
 * Wager-volume breakdown for the creator's code cohort — the per-game
 * slice of the all-time Wager Volume KPI (packs + battles + upgrader sum
 * to it exactly). Migrated out of the old plain-`<Card>` FinancialsCard
 * into the modern acquisition band: "where did this creator's wager
 * volume come from".
 *
 * House POV: wager is money users risked → 🟢 emerald.
 */
export function WagerBreakdownCard({
  wagerVolumeUsd,
  wagerBreakdown,
}: {
  wagerVolumeUsd: number;
  wagerBreakdown: { packs: number; battles: number; upgrader: number };
}) {
  const packsAndBattles = wagerBreakdown.packs + wagerBreakdown.battles;
  const emerald = "text-emerald-600 dark:text-emerald-400";

  return (
    <StatPanel
      title="Wager Volume · lifetime"
      icon={Coins}
      accent="emerald"
      action={
        <InfoHint
          text="All-time wager volume from this creator's code cohort, split by game type. Packs + Battles + Upgrader sum exactly to the total. Money players risked = house income (emerald)."
          side="left"
        />
      }
    >
      <div className="space-y-1">
        <div
          className={`text-2xl font-bold tabular-nums leading-none sm:text-3xl ${
            wagerVolumeUsd > 0 ? emerald : "text-muted-foreground"
          }`}
          title="All-time real-customer wager booked on this creator's code"
        >
          {wagerVolumeUsd === 0 ? "—" : formatCurrency(wagerVolumeUsd)}
        </div>
        <p className="text-[11px] text-muted-foreground">
          Real-customer wager on this code — staff excluded
        </p>
      </div>
      <div className="mt-3 space-y-0.5">
        <PanelRow
          label="Packs & Battles"
          value={
            packsAndBattles === 0 ? "—" : formatCurrency(packsAndBattles)
          }
          valueClassName={packsAndBattles > 0 ? emerald : undefined}
        />
        <PanelRow
          label="Upgrader"
          value={
            wagerBreakdown.upgrader === 0
              ? "—"
              : formatCurrency(wagerBreakdown.upgrader)
          }
          valueClassName={wagerBreakdown.upgrader > 0 ? emerald : undefined}
        />
      </div>
      <p className="mt-3 inline-flex items-center gap-1 text-[10px] text-muted-foreground">
        <TrendingUp className="size-3" />
        Packs + Battles + Upgrader sum to the volume above
      </p>
    </StatPanel>
  );
}
