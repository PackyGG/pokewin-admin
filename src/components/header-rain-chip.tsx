import { CloudRain, Users } from "lucide-react";
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
 * Compact live-rain countdown chip for the admin header — a cyan-tinted pill
 * that sits just to the LEFT of the profile menu. A rain glyph + the live
 * entrant count + the live $ pool total + the live countdown (reusing
 * RainCountdown). min-h-8 + rounded-full + the same p-1/px-3 padding rhythm
 * as the profile dropdown's trigger pill in admin-header.tsx, so the two
 * chips read as one matched pair sitting side by side.
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
  const pool = formatCurrency(rain.totalPoolUsd);
  return (
    <span
      className="hidden min-h-8 items-center gap-1.5 rounded-full border border-cyan-500/40 bg-cyan-500/10 px-3 text-xs font-medium text-cyan-700 sm:inline-flex dark:text-cyan-400"
      title={`Active rain · ${participants} · ${pool} pool · ${
        drawing ? "drawing winner" : endsInLabel(rain.endsAt)
      }`}
    >
      <CloudRain className="size-3.5 shrink-0" aria-hidden />
      {/* Live entrant count — surfaced IN the chip (not just the tooltip) so
          the headline number is visible at a glance. */}
      <span className="inline-flex items-center gap-1">
        <Users className="size-3 shrink-0" aria-hidden />
        <span className="tabular-nums">
          {formatNumber(rain.participantCount)}
        </span>
      </span>
      <span className="text-cyan-700/40 dark:text-cyan-400/40" aria-hidden>
        ·
      </span>
      {/* Pool $ total — now visible in the chip body, not just the tooltip,
          so the joined pool amount is readable at a glance. */}
      <span className="tabular-nums font-semibold">{pool}</span>
      <span className="text-cyan-700/40 dark:text-cyan-400/40" aria-hidden>
        ·
      </span>
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
