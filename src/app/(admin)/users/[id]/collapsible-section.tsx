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
 * Trigger + content live inside ONE continuous bordered/rounded box (not two
 * separately-floating blocks) so an open section visibly reads as "this
 * content belongs to this header": the header fills the top of the box, a
 * `border-t` divider marks the seam, and the content fills the rest — the
 * outer box never gaps or re-borders itself between the two.
 *
 * State affordance (must be readable at a glance, not just from the chevron):
 *   • COLLAPSED — a tinted (`bg-muted/30`) neutral header row with a hover
 *     affordance (`cursor-pointer` + `hover:bg-muted/50` + border /
 *     text-foreground shift), chevron pointing RIGHT.
 *   • OPEN — the header switches to a primary-tinted background + border
 *     (`bg-primary/10` / `border-primary/25`) and the icon chip goes from
 *     outline-y (`bg-primary/10`) to filled (`bg-primary/20`), so an open
 *     section is unmistakable even at a glance. Chevron rotates DOWN.
 * The chevron rotation + panel height transition are `motion-safe:` so
 * reduced-motion users get the state instantly with no tween; the
 * background/border tint switch is a plain color transition either way.
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
        "overflow-hidden rounded-lg border transition-colors",
        open ? "border-primary/25" : "border-border/60 hover:border-border",
        className,
      )}
    >
      <CollapsibleTrigger
        render={
          <button
            type="button"
            className={cn(
              "group flex w-full cursor-pointer items-center justify-between gap-3 px-3 py-2.5 text-left transition-colors",
              open
                ? "bg-primary/10 hover:bg-primary/15"
                : "bg-muted/30 hover:bg-muted/50",
            )}
          >
            <span className="flex min-w-0 items-center gap-2">
              <span
                className={cn(
                  "shrink-0 rounded-md p-1.5 transition-colors",
                  open ? "bg-primary/20" : "bg-primary/10",
                )}
              >
                <Icon className="size-4 text-primary" />
              </span>
              <span className="truncate text-base font-semibold text-foreground/90 group-hover:text-foreground">
                {title}
              </span>
            </span>
            <ChevronDown
              className={cn(
                "size-5 shrink-0 text-muted-foreground group-hover:text-foreground motion-safe:transition-transform motion-safe:duration-200",
                open ? "rotate-0 text-primary" : "-rotate-90",
              )}
            />
          </button>
        }
      />
      <CollapsibleContent>
        <div className="border-t border-primary/15 px-3 py-4 sm:py-5">
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
