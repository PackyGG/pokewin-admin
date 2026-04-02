import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils/format";
import type { RakebackStats } from "@/lib/queries/rewards";

export function RewardsOverview({ stats }: { stats: RakebackStats }) {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Claimed</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{formatCurrency(stats.totalClaimed)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Pending</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{formatCurrency(stats.totalPending)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Claims</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{stats.claimCount}</p>
          </CardContent>
        </Card>
      </div>

      {stats.byType.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">By Type</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap items-center gap-6">
              {stats.byType.map((t) => (
                <div key={t.type} className="flex items-center gap-2">
                  <span className="text-sm capitalize">{t.type}</span>
                  <span className="text-sm font-medium">{formatCurrency(t.totalAmount)}</span>
                  <span className="text-xs text-muted-foreground">({t.claimCount} claims)</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
