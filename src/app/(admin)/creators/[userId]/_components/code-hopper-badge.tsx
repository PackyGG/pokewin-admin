import { Shuffle } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * "Code-hopper" indicator for a referred user who has used 2+ DISTINCT
 * affiliate codes (deposit/wager) — the canonical code-switching /
 * leaderboard-sniping signal reused from the streamers abuse-detection
 * surface. Surfaced inline on a creator's top-users list so an admin can
 * instantly see whether the creator's numbers are inflated by users who
 * only passed through their code.
 *
 * Amber: a sus / "worth a look" signal — matches the amber the streamers
 * risk surface uses for the 50–74 "probably worth an admin look" band.
 * This isn't a money figure, so the House-POV red/green rule doesn't
 * apply; amber reads as a neutral caution flag.
 *
 * The distinct-code count rides along in the chip ("3 codes") + the
 * title attribute so the admin sees the severity at a glance without a
 * drill-in.
 */
export function CodeHopperBadge({
  codeCount,
  className,
}: {
  codeCount: number;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-semibold",
        "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30",
        className,
      )}
      title={`Code-hopper — used ${codeCount} distinct affiliate codes (deposit/wager). Possible leaderboard-sniping / code-switching.`}
    >
      <Shuffle className="size-3" aria-hidden />
      {codeCount} codes
    </span>
  );
}
