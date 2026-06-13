import Link from "next/link";
import { Package, TrendingUp } from "lucide-react";
import {
  SectionHeading,
  KpiTile,
} from "@/components/modern-panels";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  formatMaxWinMultiplier,
  type PackMaxWinStats,
} from "@/lib/queries/pack-max-wins";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { cn } from "@/lib/utils";

function formatShare(share: number): string {
  return `${(share * 100).toFixed(1)}%`;
}

const RANGE_BAR_COLORS = [
  "bg-blue-500",
  "bg-purple-500",
  "bg-amber-500",
  "bg-cyan-500",
  "bg-emerald-500",
  "bg-rose-500",
  "bg-orange-500",
  "bg-pink-500",
];

export function PackMaxWinsSection({ stats }: { stats: PackMaxWinStats }) {
  if (stats.totalPacks === 0) {
    return (
      <section className="max-w-md space-y-4">
        <SectionHeading icon={Package} title="Pack max wins" />
        <Card>
          <CardContent className="py-8 text-sm text-muted-foreground">
            No priced packs with cards in the pool yet.
          </CardContent>
        </Card>
      </section>
    );
  }

  const packsByRange = new Map<string, typeof stats.packs>();
  for (const pack of stats.packs) {
    const list = packsByRange.get(pack.rangeKey) ?? [];
    list.push(pack);
    packsByRange.set(pack.rangeKey, list);
  }

  return (
    <section className="space-y-6">
      <div className="grid max-w-2xl grid-cols-2 gap-3 md:grid-cols-3">
        <KpiTile
          label="Packs analyzed"
          value={formatNumber(stats.totalPacks)}
          icon={Package}
          accent="blue"
        />
        {stats.peak && (
          <KpiTile
            label="Highest max win"
            value={formatMaxWinMultiplier(stats.peak.maxWinMultiplier)}
            sub={stats.peak.name}
            icon={TrendingUp}
            accent="amber"
          />
        )}
      </div>

      <div className="max-w-md space-y-4">
        <SectionHeading icon={Package} title="Pack max wins" />
        <p className="text-sm text-muted-foreground">
          Max win = top card value ÷ pack price (e.g. $400 top pull on a $1 pack → 400×).
          Shard packs excluded.
        </p>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">
              Packs by max-win range
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {stats.ranges.map((row, index) => (
              <div key={row.key} className="space-y-1.5">
                <div className="flex items-center justify-between gap-3 text-sm">
                  <span className="font-medium">{row.label}</span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {formatNumber(row.packCount)} · {formatShare(row.share)}
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn(
                      "h-full rounded-full transition-all",
                      RANGE_BAR_COLORS[index % RANGE_BAR_COLORS.length],
                    )}
                    style={{
                      width: `${Math.max(row.share * 100, row.packCount > 0 ? 2 : 0)}%`,
                    }}
                  />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <div className="max-w-3xl space-y-6">
        {stats.ranges.map((range) => {
          const packs = packsByRange.get(range.key) ?? [];
          if (packs.length === 0) return null;
          return (
            <div key={range.key} className="space-y-3">
              <h3 className="text-sm font-semibold tracking-tight">
                {range.label}
                <span className="ml-2 font-normal text-muted-foreground">
                  ({formatNumber(packs.length)} pack{packs.length === 1 ? "" : "s"})
                </span>
              </h3>
              <Card>
                <CardContent className="divide-y p-0">
                  {packs.map((pack) => (
                    <div
                      key={pack.packId}
                      className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <Link
                            href={`/packs?inspect=${pack.packId}`}
                            className="truncate font-medium hover:underline"
                          >
                            {pack.name}
                          </Link>
                          {!pack.active && (
                            <Badge variant="secondary" className="text-[10px]">
                              Inactive
                            </Badge>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {formatCurrency(pack.priceUsd)} pack · top pull{" "}
                          {formatCurrency(pack.topCardUsd)}
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="text-lg font-bold tabular-nums text-amber-600 dark:text-amber-400">
                          {formatMaxWinMultiplier(pack.maxWinMultiplier)}
                        </p>
                        <p className="text-[11px] text-muted-foreground">max win</p>
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            </div>
          );
        })}
      </div>
    </section>
  );
}
