import { Suspense } from "react";
import { CloudRain } from "lucide-react";

import { RainCountdown } from "@/app/(admin)/dashboard/rain-countdown";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import { getActiveRain } from "@/lib/queries/dashboard";
import { formatCurrency, formatNumber } from "@/lib/utils/format";

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
 * Live-rain card for the shared admin header. Its 40px height, rounded-lg
 * shape, border and muted surface match the profile card beside it. The
 * two-line layout keeps the pool, total entries and end timer readable
 * without turning the topbar into a long pill.
 *
 * The read is failure-isolated because optional header status must never take
 * down the dashboard shell. There is no card between rains.
 */
async function HeaderRainChip() {
  const { data: rain } = await safeQuery(
    () => getActiveRain(),
    null,
    "header.activeRain",
    REWARD_QUERY_TIMEOUT_MS,
  );
  if (!rain) return null;

  const drawing = rain.status === "drawing";
  const entries = `${formatNumber(rain.participantCount)} ${
    rain.participantCount === 1 ? "entry" : "entries"
  }`;
  const pool = formatCurrency(rain.totalPoolUsd);

  return (
    <span
      className="hidden h-10 items-center gap-2 rounded-lg border border-border/60 bg-muted/40 px-2.5 text-xs sm:inline-flex"
      title={`Active rain · ${entries} · ${pool} pool · ${
        drawing ? "drawing winner" : endsInLabel(rain.endsAt)
      }`}
      aria-label={`Active rain, ${entries}, ${pool} pool`}
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-cyan-500/12 text-cyan-700 dark:text-cyan-400">
        <CloudRain className="size-4" aria-hidden />
      </span>
      <span className="flex min-w-0 flex-col justify-center gap-0.5 leading-none">
        <span className="flex items-center gap-1.5 font-semibold text-foreground">
          <span>Rain</span>
          <span className="tabular-nums text-cyan-700 dark:text-cyan-400">
            {pool}
          </span>
        </span>
        <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="tabular-nums">{entries}</span>
          <span aria-hidden>·</span>
          {drawing ? (
            <span className="text-cyan-700 dark:text-cyan-400">
              Drawing now
            </span>
          ) : (
            <span>
              Ends in{" "}
              <RainCountdown
                endsAt={rain.endsAt}
                initialRemainingMs={
                  new Date(rain.endsAt).getTime() - Date.now()
                }
              />
            </span>
          )}
        </span>
      </span>
    </span>
  );
}

/**
 * Shared streamed slot used by every dashboard shell. Keeping the Suspense
 * boundary here prevents one shell from accidentally making the MAIN read
 * blocking or omitting the rain card entirely.
 */
export function HeaderRainSlot() {
  return (
    <Suspense fallback={null}>
      <HeaderRainChip />
    </Suspense>
  );
}
