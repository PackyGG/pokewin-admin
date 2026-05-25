import { Card, CardContent } from "@/components/ui/card";
import { CloudRain } from "lucide-react";
import { AnimatedNumber } from "@/components/animated-number";
import { formatCurrency } from "@/lib/utils/format";
import type { ActiveRainSummary } from "@/lib/queries/dashboard";

/**
 * Relative "ends in" label, computed server-side at render. The dashboard
 * re-renders on its 60s tick, so this stays roughly current without a
 * client timer (good enough for a minutes-scale countdown).
 */
function endsInLabel(endsAtIso: string): string {
  const ms = new Date(endsAtIso).getTime() - Date.now();
  if (ms <= 0) return "ending now";
  const totalMin = Math.round(ms / 60000);
  if (totalMin < 1) return "ends in <1m";
  if (totalMin < 60) return `ends in ${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `ends in ${h}h ${m}m`;
}

/**
 * Dashboard "Active Rain" box — headline is the live participant
 * (entrant) count of the rain currently in play, with pool + time
 * remaining for context. Renders an idle state between rains.
 */
export function ActiveRainCard({ rain }: { rain: ActiveRainSummary }) {
  if (!rain) {
    return (
      <Card>
        <CardContent className="flex items-center gap-3 py-4">
          <div className="rounded-xl bg-muted p-2">
            <CloudRain className="size-5 text-muted-foreground" />
          </div>
          <div>
            <p className="text-card-title text-muted-foreground">Active Rain</p>
            <p className="text-sm font-medium text-muted-foreground">
              No rain running right now
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  const drawing = rain.status === "drawing";
  return (
    <Card className="bg-cyan-500/10">
      <CardContent className="flex flex-wrap items-center justify-between gap-4 py-4">
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-cyan-500/15 p-2 ring-1 ring-inset ring-white/5">
            <CloudRain className="size-5 text-cyan-500 dark:text-cyan-400" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <p className="text-card-title text-muted-foreground">Active Rain</p>
              <span className="inline-flex items-center gap-1 text-[11px] font-medium text-cyan-600 dark:text-cyan-400">
                <span className="relative flex size-1.5">
                  <span className="absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75 motion-safe:animate-ping" />
                  <span className="relative inline-flex size-1.5 rounded-full bg-cyan-500" />
                </span>
                {drawing ? "Drawing" : "Live"}
              </span>
            </div>
            <p className="text-sm font-medium text-muted-foreground">
              {drawing
                ? "Entries closed — drawing winner"
                : endsInLabel(rain.endsAt)}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-8 gap-y-2">
          <div>
            <p className="text-stat-label text-muted-foreground">Participants</p>
            <div className="text-stat-value tabular-nums text-cyan-600 dark:text-cyan-400">
              <AnimatedNumber value={rain.participantCount} format="number" />
            </div>
          </div>
          <div>
            <p className="text-stat-label text-muted-foreground">Pool</p>
            <div className="text-stat-value tabular-nums">
              {formatCurrency(rain.totalPoolUsd)}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
