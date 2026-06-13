import {
  DollarSign,
  Gauge,
  Package,
  Power,
  Sparkles,
} from "lucide-react";
import { getPacksListStats, type PackSetFilter } from "@/lib/queries/packs";
import { KpiTile } from "@/components/modern-panels";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { houseAccent, formatPercentValue } from "@/lib/house-pov";
import { safeQuery } from "@/lib/errors/safe-query";

const KPI_QUERY_TIMEOUT_MS = 10_000;

export async function PacksKpiStrip({ activeSet }: { activeSet: PackSetFilter }) {
  const { data: stats } = await safeQuery(
    () => getPacksListStats(activeSet),
    null,
    "packs.kpi",
    KPI_QUERY_TIMEOUT_MS,
  );

  if (!stats) {
    return (
      <TileErrorFallback
        label="Catalog stats"
        hint="The aggregate stats query failed or timed out. The pack list below is unaffected — refresh to retry."
      />
    );
  }

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
      <KpiTile
        label={activeSet === "onepiece" ? "OnePiece Packs" : "Pokemon Packs"}
        value={formatNumber(stats.totalPacks)}
        sub={
          stats.totalPacks > 0
            ? `${stats.activePacks} active · ${
                stats.totalPacks - stats.activePacks
              } off`
            : undefined
        }
        icon={Package}
        accent="blue"
      />
      <KpiTile
        label="Active"
        value={formatNumber(stats.activePacks)}
        sub={
          stats.totalPacks > 0
            ? `${Math.round((stats.activePacks / stats.totalPacks) * 100)}% of catalog`
            : undefined
        }
        icon={Power}
        accent="cyan"
      />
      <KpiTile
        label="Lifetime Opens"
        value={formatNumber(stats.totalOpenings)}
        icon={Sparkles}
        accent="purple"
      />
      <KpiTile
        label="Lifetime Revenue"
        value={formatCurrency(stats.totalRevenue)}
        sub={`payout ${formatCurrency(stats.totalPayout)}`}
        icon={DollarSign}
        accent="emerald"
      />
      <KpiTile
        label="House Edge"
        value={formatPercentValue(stats.houseEdgePct, 1)}
        sub={
          stats.totalRevenue > 0
            ? `${formatCurrency(stats.totalRevenue - stats.totalPayout)} kept`
            : "no opens yet"
        }
        icon={Gauge}
        accent={houseAccent(stats.houseEdgePct)}
      />
    </div>
  );
}
