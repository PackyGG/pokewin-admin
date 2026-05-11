import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Activity, Package, Swords } from "lucide-react";
import { AnimatedNumber } from "@/components/animated-number";

/**
 * 24h Activity tile — packs opened and battles played in the rolling
 * last 24 hours, side-by-side in a single card. Lives next to the
 * other secondary KPI tiles on the dashboard.
 *
 * Two metrics in one box (per admin spec) rather than two cards: it's
 * the same conceptual unit ("how busy was the platform today") and
 * keeps the row scannable.
 *
 * Numbers come from `getDashboardStats().activity.{packsOpened24h,
 * battlesPlayed24h}` — already excludes staff + blacklisted users.
 */
export function Activity24hCard({
  packsOpened,
  battlesPlayed,
}: {
  packsOpened: number;
  battlesPlayed: number;
}) {
  return (
    <Card className="bg-pink-500/10">
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
        <CardTitle className="truncate text-card-title text-muted-foreground">
          24h Activity
        </CardTitle>
        <Activity className="size-4 shrink-0 text-pink-400" />
      </CardHeader>
      <CardContent>
        {/* Two-up grid keeps both metrics same-size. Tabular-nums so
            the numbers stay aligned even as they animate. */}
        <div className="grid grid-cols-2 gap-3">
          <div className="min-w-0">
            <div className="truncate text-stat-value tabular-nums">
              <AnimatedNumber value={packsOpened} format="number" />
            </div>
            <p className="text-stat-label flex items-center gap-1">
              <Package className="size-3 shrink-0" />
              <span className="truncate">Packs opened</span>
            </p>
          </div>
          <div className="min-w-0">
            <div className="truncate text-stat-value tabular-nums">
              <AnimatedNumber value={battlesPlayed} format="number" />
            </div>
            <p className="text-stat-label flex items-center gap-1">
              <Swords className="size-3 shrink-0" />
              <span className="truncate">Battles</span>
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
