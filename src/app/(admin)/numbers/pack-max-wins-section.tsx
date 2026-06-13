import { Package } from "lucide-react";
import { SectionHeading } from "@/components/modern-panels";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  formatMaxWinMultiplier,
  type PackMaxWinStats,
} from "@/lib/queries/pack-max-wins";
import { formatNumber } from "@/lib/utils/format";
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
  return (
    <section className="space-y-4">
      <SectionHeading icon={Package} title="Pack max wins" />
      <Card className="overflow-hidden">
        <CardHeader className="border-b bg-muted/30 pb-4">
          <CardTitle className="text-base font-semibold">
            Packs by max-win range
          </CardTitle>
          <CardDescription className="text-sm leading-relaxed">
            Max win = top card value ÷ pack price (e.g. $400 on a $1 pack → 400×).
            Shard packs excluded.
            {stats.totalPacks > 0 && (
              <>
                {" "}
                <span className="text-foreground/80">
                  {formatNumber(stats.totalPacks)} packs
                  {stats.peak
                    ? ` · highest ${formatMaxWinMultiplier(stats.peak.maxWinMultiplier)} (${stats.peak.name})`
                    : ""}
                  .
                </span>
              </>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-5">
          {stats.totalPacks === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No priced packs with cards in the pool yet.
            </p>
          ) : (
            <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
              {stats.ranges.map((row, index) => (
                <div
                  key={row.key}
                  className="grid grid-cols-[4.5rem_1fr_auto] items-center gap-x-3 gap-y-2"
                >
                  <span className="text-sm font-semibold tabular-nums tracking-tight">
                    {row.label}
                  </span>
                  <div className="h-2.5 overflow-hidden rounded-full bg-muted">
                    <div
                      className={cn(
                        "h-full rounded-full transition-all",
                        RANGE_BAR_COLORS[index % RANGE_BAR_COLORS.length],
                      )}
                      style={{
                        width: `${Math.max(row.share * 100, row.packCount > 0 ? 4 : 0)}%`,
                      }}
                    />
                  </div>
                  <span className="min-w-[5.5rem] text-right text-sm tabular-nums text-muted-foreground">
                    {formatNumber(row.packCount)}
                    <span className="mx-1 text-muted-foreground/50">·</span>
                    {formatShare(row.share)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
