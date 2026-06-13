"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

/**
 * Collapsible wrapper for /security panels — click the heading row to
 * expand/collapse the section body.
 */
export function CollapsibleSecuritySection({
  icon: Icon,
  title,
  children,
  defaultOpen = true,
}: {
  icon: React.ElementType;
  title: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="space-y-3">
      <CollapsibleTrigger
        render={
          <button
            type="button"
            className="flex w-full items-center justify-between gap-3 rounded-lg px-1 py-0.5 text-left transition-colors hover:bg-muted/40"
          >
            <div className="flex min-w-0 items-center gap-2.5">
              <div className="shrink-0 rounded-lg border border-primary/20 bg-primary/10 p-1.5 shadow-sm ring-1 ring-inset ring-white/5">
                <Icon className="size-4 text-primary" />
              </div>
              <span className="text-sm font-semibold tracking-tight sm:text-base">
                {title}
              </span>
            </div>
            <ChevronDown
              className={cn(
                "size-5 shrink-0 text-muted-foreground motion-safe:transition-transform motion-safe:duration-200",
                open && "rotate-180",
              )}
            />
          </button>
        }
      />
      <CollapsibleContent>
        <div>{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}
