import { Trophy, Skull, Clock, Hourglass } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type {
  DoubleDownResult,
  DoubleDownStatus,
} from "@/lib/queries/double-down-shared";

/**
 * Shared Double Down result + status badges — used by BOTH the
 * /insights/double-down audit log AND the /users/[id] Gaming-tab history log
 * so a round reads identically on both surfaces.
 *
 * House-POV color (CLAUDE.md, STRICT): a round result is colored from the
 * HOUSE's perspective, not the user's:
 *   - WIN  (user kept 90% of their winnings) = house COST   → 🔴 rose
 *   - LOSE (user forfeited their winnings)    = house GAIN   → 🟢 emerald
 *   - pending/unresolved                       = neutral      → 🔵 blue
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

const STATUS_META: Record<
  DoubleDownStatus,
  { label: string; className: string }
> = {
  offered: {
    label: "Offered",
    className:
      "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/25",
  },
  accepted: {
    label: "Accepted",
    className:
      "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/25",
  },
  resolved: {
    label: "Resolved",
    className:
      "bg-muted text-muted-foreground border-border",
  },
  expired: {
    label: "Expired",
    className:
      "bg-muted text-muted-foreground border-border",
  },
};

/** Neutral lifecycle status (offered/accepted/resolved/expired) — not money. */
export function DoubleDownStatusBadge({
  status,
}: {
  status: DoubleDownStatus;
}) {
  const meta = STATUS_META[status];
  return (
    <Badge
      variant="outline"
      className={cn("h-5 gap-1 py-0 text-[10px]", meta.className)}
    >
      <Clock className="size-2.5" />
      {meta.label}
    </Badge>
  );
}
