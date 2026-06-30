import { Trophy, Skull, Hourglass } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { DoubleDownResult } from "@/lib/queries/double-down-shared";

/**
 * Shared Double Down result badge — used by BOTH the /insights/double-down
 * audit log AND the /users/[id] Gaming-tab history log so a round reads
 * identically on both surfaces.
 *
 * House-POV color (CLAUDE.md, STRICT): a round result is colored from the
 * HOUSE's perspective, not the user's:
 *   - WIN  (the user is paid a voucher) = house COST → 🔴 rose
 *   - LOSE (the user forfeits the win)   = house GAIN → 🟢 emerald
 *   - pending/unresolved                  = neutral    → 🔵 blue
 */
export function DoubleDownResultBadge({
  result,
}: {
  result: DoubleDownResult | null;
}) {
  if (result === "win") {
    return (
      <Badge
        variant="outline"
        className="h-5 gap-1 py-0 text-[10px] bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30"
      >
        <Trophy className="size-2.5" />
        Win
      </Badge>
    );
  }
  if (result === "lose") {
    return (
      <Badge
        variant="outline"
        className="h-5 gap-1 py-0 text-[10px] bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30"
      >
        <Skull className="size-2.5" />
        Lose
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="h-5 gap-1 py-0 text-[10px] bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30"
    >
      <Hourglass className="size-2.5" />
      Pending
    </Badge>
  );
}
