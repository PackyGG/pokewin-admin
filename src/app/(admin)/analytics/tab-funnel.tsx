import type { AnalyticsPeriod } from "./types";

export async function FunnelTab({ period: _period }: { period: AnalyticsPeriod }) {
  void _period;
  return <div className="py-8 text-center text-sm text-muted-foreground">Coming up…</div>;
}
