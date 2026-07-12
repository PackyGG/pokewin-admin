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
 * Design: FLAT + NEUTRAL, matching the rest of the admin (no colored fills /
 * gradients / glows). Trigger + content live inside ONE continuous
 * `bg-card` box with a hairline border and `rounded-xl`, so an open section
 * reads as one card: the header sits at the top, a neutral `border-t` marks
 * the seam, and the content fills the rest.
 *
 * State affordance (calm, not loud):
 *   • COLLAPSED — transparent header, chevron points RIGHT. A subtle
 *     `hover:bg-muted/40` gives the row a clickable affordance.
 *   • OPEN — the header takes a faint NEUTRAL wash (`bg-muted/30`) to seat
 *     the content beneath it, and the chevron rotates DOWN. No accent color
 *     is used for state — the open content + rotated chevron carry it.
 *
 * The chevron rotation is `motion-reduce:`-gated; the panel height tween is
 * handled globally (`[data-slot="collapsible-content"]` in globals.css,
 * 280ms ease-out, reduced-motion aware).
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
      className={cn(
        "overflow-hidden rounded-xl border border-border/60 bg-card",
        className,
      )}
    >
      <CollapsibleTrigger
        render={
          <button
            type="button"
            className={cn(
              "group flex w-full cursor-pointer items-center gap-2.5 px-4 py-3 text-left transition-colors",
              open ? "bg-muted/30 hover:bg-muted/50" : "hover:bg-muted/40",
            )}
          >
            <Icon className="size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" />
            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
              {title}
            </span>
            <ChevronDown
              className={cn(
                "size-4 shrink-0 text-muted-foreground/70 transition-transform duration-200 group-hover:text-foreground motion-reduce:transition-none",
                open ? "rotate-0" : "-rotate-90",
              )}
            />
          </button>
        }
      />
      <CollapsibleContent>
        <div className="border-t border-border/60 px-4 py-4 sm:py-5">
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
