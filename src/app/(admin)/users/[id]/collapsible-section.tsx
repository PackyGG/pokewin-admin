"use client";

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { ChevronDown } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

/**
 * Section-level collapsible shared across the user-detail page (Deposits &
 * Withdrawals, Sold & Exchanged, …). Controlled — the caller owns the open
 * state so it can run side effects on toggle (e.g. reset pagination on
 * re-open).
 *
 * The trigger is deliberately chrome-y so a COLLAPSED section still reads
 * obviously as "there's more here, click to expand" rather than an ambiguous
 * heading:
 *   • a bordered, tinted (`bg-muted/30`), rounded header row,
 *   • a hover affordance (`cursor-pointer` + `hover:bg-muted/50` + border /
 *     text-foreground shift),
 *   • a chevron that points RIGHT when collapsed and rotates DOWN when open.
 * The rotation is `motion-safe:` so reduced-motion users get the state
 * instantly with no tween.
 */
export function CollapsibleSection({
  icon: Icon,
  title,
  open,
  onOpenChange,
  className,
  children,
}: {
  icon: LucideIcon;
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Collapsible
      open={open}
      onOpenChange={onOpenChange}
      className={cn("space-y-4 sm:space-y-6", className)}
    >
      <CollapsibleTrigger
        render={
          <button
            type="button"
            className="group flex w-full cursor-pointer items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/30 px-3 py-2.5 text-left transition-colors hover:border-border hover:bg-muted/50"
          >
            <span className="flex min-w-0 items-center gap-2">
              <span className="shrink-0 rounded-md bg-primary/10 p-1.5">
                <Icon className="size-4 text-primary" />
              </span>
              <span className="truncate text-base font-semibold text-foreground/90 group-hover:text-foreground">
                {title}
              </span>
            </span>
            <ChevronDown
              className={cn(
                "size-5 shrink-0 text-muted-foreground group-hover:text-foreground motion-safe:transition-transform motion-safe:duration-200",
                open ? "rotate-0" : "-rotate-90",
              )}
            />
          </button>
        }
      />
      <CollapsibleContent>{children}</CollapsibleContent>
    </Collapsible>
  );
}
