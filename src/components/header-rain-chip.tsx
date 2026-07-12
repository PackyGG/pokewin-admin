import { CloudRain } from "lucide-react";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import { getActiveRain } from "@/lib/queries/dashboard";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { RainCountdown } from "@/app/(admin)/dashboard/rain-countdown";

/**
 * Relative "ends in" label for the chip's tooltip, computed server-side at
 * render (mirrors the dashboard chip's helper). The layout re-renders on
 * navigation, so it stays roughly current without a client timer.
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
 * Compact live-rain countdown chip for the admin header — a smaller sibling
 * of the dashboard's ActiveRainChip that sits just to the LEFT of the profile
 * menu. A cyan-tinted pill with a rain glyph + the live countdown (reusing
 * RainCountdown); the entrant count, pool, and ends-in live in the tooltip.
 *
 * Reads the single active/drawing rains row via the SAME read the dashboard
 * chip uses (getActiveRain), wrapped in safeQuery so a failed/slow lookup
 * degrades to nothing rather than throwing up the whole admin shell — a
 * decorative header chip must never take the admin down. Renders NOTHING
 * between rains (null rain) or on error, so it only appears when a rain is
 * actually live.
 *
 * Rendered behind its OWN <Suspense fallback={null}> in the admin layout, so
 * this read never blocks the header's first paint (shell-first streaming).
 * Hidden below sm — the mobile header stays a lean breadcrumb + avatar.
 */
export async function HeaderRainChip() {
  const { data: rain } = await safeQuery(
    () => getActiveRain(),
    null,
    "header.activeRain",
    REWARD_QUERY_TIMEOUT_MS,
  );
  if (!rain) return null;

  const drawing = rain.status === "drawing";
  const participants = `${formatNumber(rain.participantCount)} ${
    rain.participantCount === 1 ? "participant" : "participants"
  }`;
  return (
    <span
      className="hidden items-center gap-1.5 rounded-full border border-cyan-500/40 bg-cyan-500/10 px-2 py-1 text-xs font-medium text-cyan-700 sm:inline-flex dark:text-cyan-400"
      title={`Active rain · ${participants} · ${formatCurrency(
        rain.totalPoolUsd,
      )} pool · ${drawing ? "drawing winner" : endsInLabel(rain.endsAt)}`}
    >
      <CloudRain className="size-3.5 shrink-0" aria-hidden />
      {drawing ? (
        <span>drawing</span>
      ) : (
        // initialRemainingMs is computed server-side here (once, at request
        // time) and serialized down so RainCountdown's first client paint is
        // byte-identical to the SSR markup — no hydration #418. The client
        // then re-syncs to the live clock and starts its 1s tick on mount.
        <RainCountdown
          endsAt={rain.endsAt}
          initialRemainingMs={new Date(rain.endsAt).getTime() - Date.now()}
        />
      )}
    </span>
  );
}
