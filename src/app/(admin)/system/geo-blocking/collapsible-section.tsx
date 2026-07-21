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
 * Section-level collapsible — same pattern as the one on the user-detail
 * page (src/app/(admin)/users/[id]/collapsible-section.tsx), duplicated
 * locally rather than shared since this codebase keeps this small wrapper
 * per-route. Controlled — the caller owns the open state.
 *
 * Used here to bundle the ~250 countries that only differ from the default
 * by having item/physical withdrawal disabled into ONE collapsed summary
 * instead of flooding the restricted view with near-identical rows.
 */
export function CollapsibleSection({
  icon: Icon,
  title,
  subtitle,
  open,
  onOpenChange,
  className,
  children,
}: {
  icon: LucideIcon;
  title: string;
  subtitle?: string;
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
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold text-foreground">
                {title}
              </span>
              {subtitle && (
                <span className="block truncate text-xs text-muted-foreground">
                  {subtitle}
                </span>
              )}
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
