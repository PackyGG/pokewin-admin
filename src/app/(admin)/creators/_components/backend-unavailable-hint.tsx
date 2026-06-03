import { cn } from "@/lib/utils";
import { InfoHint } from "./info-hint";

/**
 * Inline "backend data unavailable" affordance for /creators KPI tiles
 * and panels.
 *
 * The /creators list reads several of its figures from the packy.gg
 * backend API (creator roster, deal caps, leaderboard spend, multiplier /
 * fill counts). When the backend is unreachable (prod env var unset, or
 * backend down) those reads degrade to "—" rather than crashing the page
 * (see the safeQuery wrappers on page.tsx). This little amber dot + ⓘ
 * marks the affected tile so the owner can tell "we genuinely have no
 * data here right now because the backend is down" apart from a real $0.
 *
 * Drops into the `action` slot of <KpiTile> / <StatPanel> (top-right
 * corner), so it sits exactly where the InfoHint normally lives. When a
 * tile already has an InfoHint, render this ALONGSIDE it (wrap both in a
 * flex row) — same pattern the Global PnL tile uses for its popover.
 *
 * Server-safe: string-only props + the string-only <InfoHint> client
 * component, so it renders directly from the server strip (no function
 * props cross the RSC boundary). House-POV / dark-mode neutral: amber is
 * a status hue (a degraded read), never a money figure.
 */

const DEFAULT_TEXT =
  "Backend data unavailable — the packy.gg backend is unreachable right now, so this figure can't load. The rest of the page still reflects the database. It'll fill in once the backend is reachable again.";

export function BackendUnavailableHint({
  text = DEFAULT_TEXT,
  side = "bottom",
}: {
  /** Override the tooltip copy (e.g. to name the specific figure). */
  text?: string;
  /** Tooltip placement — defaults to "bottom" (tiles sit near the top). */
  side?: "top" | "bottom" | "left" | "right";
}) {
  return (
    <span
      className="inline-flex items-center gap-1"
      aria-label="Backend data unavailable"
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 shrink-0 rounded-full bg-amber-500",
          "motion-safe:animate-pulse",
        )}
      />
      <InfoHint
        text={text}
        side={side}
        iconClassName="text-amber-500"
      />
    </span>
  );
}
