import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  ROLE_COLORS,
  STATUS_COLORS,
  USER_STATUS_COLORS,
} from "@/lib/constants";

/**
 * ──────────────────────────────────────────────────────────────────────────
 *  StatusBadge / ActiveBadge  (pokewin-admin · src/components/entity-surface)
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Shared pill primitives that read the EXISTING color maps in
 * `src/lib/constants.ts` (ROLE_COLORS / STATUS_COLORS / USER_STATUS_COLORS) so
 * a status pill looks identical everywhere instead of being hand-tinted per
 * surface (the discovery flagged inconsistent active/inactive treatments on
 * /packs). Built on the shadcn `<Badge>` with an `outline` base so the
 * tint-class from the map provides the color.
 *
 * House-POV note: these are STATUS pills (active / banned / shipped / role),
 * which are operational state, not money direction — so they intentionally do
 * NOT follow the emerald=house-up rule. For MONEY values use the helpers in
 * `src/lib/house-pov.ts` instead. The one money-adjacent case here is
 * `ActiveBadge` for a pack being live vs off, which is availability state, not
 * P&L — emerald "Active" reads as "this is on", matching the existing grid.
 */

type ColorMap = Record<string, string>;

const MAPS: Record<"status" | "role" | "userStatus", ColorMap> = {
  status: STATUS_COLORS,
  role: ROLE_COLORS,
  userStatus: USER_STATUS_COLORS,
};

/**
 * A pill colored from one of the constants color maps. `value` is looked up
 * (lower-cased) in the chosen `map`; an unknown value falls back to a neutral
 * zinc tint so a new status never renders uncolored/broken.
 *
 *   <StatusBadge map="status" value={withdrawal.status} />
 *   <StatusBadge map="role" value={user.role} />
 */
export function StatusBadge({
  value,
  map = "status",
  label,
  className,
}: {
  value: string;
  map?: "status" | "role" | "userStatus";
  /** Override the displayed text (defaults to a capitalized `value`). */
  label?: React.ReactNode;
  className?: string;
}) {
  const colors = MAPS[map];
  const tint =
    colors[value] ??
    colors[value?.toLowerCase()] ??
    "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30";
  return (
    <Badge
      variant="outline"
      className={cn("capitalize", tint, className)}
    >
      {label ?? value}
    </Badge>
  );
}

/**
 * Active / inactive availability pill — the canonical treatment for a pack (or
 * any entity) being live vs off. Emerald when on, neutral zinc when off, so an
 * inactive row is unmistakable at a glance (the discovery noted inactive packs
 * were too easy to miss when only dimmed). `size="sm"` matches the tiny inline
 * chip used inside dense table cells.
 */
export function ActiveBadge({
  active,
  activeLabel = "Active",
  inactiveLabel = "Off",
  size = "default",
  className,
}: {
  active: boolean;
  activeLabel?: string;
  inactiveLabel?: string;
  size?: "default" | "sm";
  className?: string;
}) {
  return (
    <Badge
      variant="outline"
      className={cn(
        active
          ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30"
          : "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30",
        size === "sm" && "h-4 px-1 text-[9px]",
        className,
      )}
    >
      {active ? activeLabel : inactiveLabel}
    </Badge>
  );
}

/**
 * A neutral count / meta chip — small outlined pill for secondary numeric
 * context inside a cell or header (e.g. "+12 cards", "3 packs"). Not colored by
 * any map; purely informational.
 */
export function MetaChip({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "h-5 border-border/60 px-1.5 text-[10px] font-medium tabular-nums text-muted-foreground",
        className,
      )}
    >
      {children}
    </Badge>
  );
}
