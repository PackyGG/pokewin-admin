import { CheckCircle2, Clock, Award } from "lucide-react";
import { formatCurrency } from "@/lib/utils/format";
import type { RakebackStats } from "@/lib/queries/rewards";
import { KpiTile } from "@/components/modern-panels";

export function RewardsOverview({ stats }: { stats: RakebackStats }) {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-3">
        <KpiTile
          label="Total Claimed"
          value={formatCurrency(stats.totalClaimed)}
          icon={CheckCircle2}
          accent="emerald"
        />
        <KpiTile
          label="Total Pending"
          value={formatCurrency(stats.totalPending)}
          icon={Clock}
          accent="amber"
        />
        <KpiTile
          label="Total Claims"
          value={String(stats.claimCount)}
          icon={Award}
          accent="blue"
        />
      </div>

      {stats.byType.length > 0 && (
        <div className="rounded-2xl border bg-card/60 p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
            By Type
          </p>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            {stats.byType.map((t) => (
              <div key={t.type} className="flex items-center gap-2">
                <span className="text-sm capitalize">{t.type}</span>
                <span className="text-sm font-medium tabular-nums">
                  {formatCurrency(t.totalAmount)}
                </span>
                <span className="text-xs text-muted-foreground">
                  ({t.claimCount} claims)
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
