import { CloudRain, Timer } from "lucide-react";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import type { ActiveRainSummary } from "@/lib/queries/dashboard";
import { RainCountdown } from "./rain-countdown";

/**
 * Relative "ends in" label, computed server-side at render. Surfaced in the
 * chip's tooltip; the dashboard re-renders on its 60s tick so it stays
 * roughly current without a client timer.
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
 * Compact "Active Rain" chip for the dashboard hero's action slot. Headline
 * is the live entrant count of the current rain; pool + countdown live in
 * the tooltip. Renders a muted idle chip between rains.
 */
export function ActiveRainChip({ rain }: { rain: ActiveRainSummary }) {
  if (!rain) {
    return (
      <span
        className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-background/40 px-3 py-1.5 text-sm font-medium text-muted-foreground"
        title="No rain currently running"
      >
        <CloudRain className="size-4 shrink-0" aria-hidden />
        <span>No active rain</span>
      </span>
    );
  }
  const drawing = rain.status === "drawing";
  return (
    <span
      className="inline-flex items-center gap-2 rounded-full border border-cyan-500/40 bg-cyan-500/10 px-3 py-1.5 text-sm font-medium text-cyan-700 dark:text-cyan-400"
      title={`Active rain · ${rain.participantCount} ${
        rain.participantCount === 1 ? "participant" : "participants"
      } · ${formatCurrency(rain.totalPoolUsd)} pool · ${
        drawing ? "drawing winner" : endsInLabel(rain.endsAt)
      }`}
    >
      <CloudRain className="size-4 shrink-0" aria-hidden />
      <span className="tabular-nums text-base font-semibold text-foreground">
        {formatNumber(rain.participantCount)}
      </span>
      <span>in rain</span>
      <span className="text-cyan-700/40 dark:text-cyan-400/40" aria-hidden>
        ·
      </span>
      <span className="tabular-nums">{formatCurrency(rain.totalPoolUsd)}</span>
      <span className="text-cyan-700/40 dark:text-cyan-400/40" aria-hidden>
        ·
      </span>
      <Timer className="size-3.5 shrink-0" aria-hidden />
      {drawing ? (
        <span>drawing</span>
      ) : (
        // initialRemainingMs is computed server-side here (once, at request
        // time) and serialized to the client so RainCountdown's first paint is
        // byte-identical to the SSR markup — no #418. The client then re-syncs
        // to the live clock on mount.
        <RainCountdown
          endsAt={rain.endsAt}
          initialRemainingMs={new Date(rain.endsAt).getTime() - Date.now()}
        />
      )}
    </span>
  );
}
