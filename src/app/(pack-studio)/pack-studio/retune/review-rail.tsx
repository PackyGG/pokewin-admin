"use client";

import { Check, Minus, TriangleAlert, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/utils/format";

import type { ReviewItem } from "./retune-review";

/**
 * The left rail — a scrollable list of every pack with its review state, letting
 * the operator jump straight to any pack. The active pack is highlighted; each
 * row shows a status glyph (approved / declined / pending / infeasible).
 */
export function ReviewRail({
  items,
  activeIndex,
  onJump,
}: {
  items: ReviewItem[];
  activeIndex: number;
  onJump: (index: number) => void;
}) {
  return (
    <nav
      aria-label="Pack review queue"
      className="max-h-[28rem] overflow-y-auto rounded-xl border bg-card p-1.5"
    >
      <ul className="space-y-0.5">
        {items.map((item, i) => {
          const active = i === activeIndex;
          const infeasible =
            item.status === "pending" &&
            !(item.adjusted ? item.adjusted.feasible : item.proposal.feasible);
          return (
            <li key={item.proposal.packId}>
              <button
                type="button"
                onClick={() => onJump(i)}
                aria-current={active ? "true" : undefined}
                className={cn(
                  "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs motion-safe:transition-colors",
                  active
                    ? "bg-accent text-accent-foreground"
                    : "hover:bg-muted/60",
                )}
              >
                <RowGlyph status={item.status} infeasible={infeasible} />
                <span className="min-w-0 flex-1 truncate font-medium">
                  {item.proposal.name}
                </span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {formatCurrency(item.proposal.price)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function RowGlyph({
  status,
  infeasible,
}: {
  status: ReviewItem["status"];
  infeasible: boolean;
}) {
  if (status === "approved") {
    return (
      <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
        <Check className="size-3" />
      </span>
    );
  }
  if (status === "declined") {
    return (
      <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <X className="size-3" />
      </span>
    );
  }
  if (infeasible) {
    return (
      <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-rose-500/15 text-rose-600 dark:text-rose-400">
        <TriangleAlert className="size-3" />
      </span>
    );
  }
  return (
    <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-muted/60 text-muted-foreground">
      <Minus className="size-3" />
    </span>
  );
}
