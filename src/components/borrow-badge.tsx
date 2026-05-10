import { Banknote } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/utils/format";

/**
 * Single source of truth for "this pack open / battle was paid for with
 * a borrow" badge. Used on every surface that lists pack opens or
 * battles (transactions table, battles table, dashboard live feed,
 * user activity tab, transaction / battle detail pages) so the visual
 * cue is consistent everywhere.
 *
 * Why house POV is rose: a borrow means the user only paid (100 −
 * borrow%)% in cash up-front — the house fronted the rest. The
 * fronted amount is real exposure on our books regardless of whether
 * the open hits or whiffs, so admins should see it as a cost signal.
 *
 * Renders nothing when `percent` is 0 / null / undefined so it can be
 * dropped into table cells unconditionally without polluting rows
 * that weren't borrowed.
 */
export function BorrowBadge({
  percent,
  amountUsd,
  size = "default",
  className,
}: {
  /** 0–100. Anything ≤ 0 (or null/undefined) renders nothing. */
  percent: number | null | undefined;
  /**
   * Optional USD amount the house fronted. When provided, it shows up
   * as the secondary line ("$45.00 fronted") so admins don't have to
   * multiply % × bet in their head.
   */
  amountUsd?: number | null;
  /** "sm" tightens padding/font for inline list cells. */
  size?: "default" | "sm";
  className?: string;
}) {
  if (percent == null || percent <= 0) return null;
  const isSm = size === "sm";
  return (
    <Badge
      variant="outline"
      // Rose tint = house gave up cash on this open. Banknote icon is
      // distinct from the wager / payout icons used elsewhere so the
      // signal stands out at a glance even in a wide table row.
      className={cn(
        "inline-flex items-center gap-1 border-rose-500/30 bg-rose-500/15 text-rose-600 dark:text-rose-400 font-medium tabular-nums",
        isSm ? "h-4 px-1 text-[10px]" : "h-5 px-1.5 text-xs",
        className,
      )}
      title={
        amountUsd != null && amountUsd > 0
          ? `Borrowed ${percent}% — house fronted ${formatCurrency(amountUsd)}`
          : `${percent}% of this open was borrowed from the house`
      }
    >
      <Banknote className={isSm ? "size-2.5" : "size-3"} aria-hidden />
      <span>{percent}%</span>
      {amountUsd != null && amountUsd > 0 && !isSm && (
        <span className="text-rose-700/80 dark:text-rose-300/70">
          · {formatCurrency(amountUsd)}
        </span>
      )}
    </Badge>
  );
}
