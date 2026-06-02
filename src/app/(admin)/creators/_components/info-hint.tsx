"use client";

import { Info } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/**
 * Small muted "ⓘ" info affordance for the creator surfaces (list + detail).
 *
 * Wraps the SAME shadcn Tooltip pattern already used elsewhere in the repo
 * (e.g. insights/cost-breakdown/waterfall-row.tsx): a hoverable lucide
 * `Info` icon that reveals a one-line plain-English explanation of the
 * KPI / stat / display box it sits next to. Subtle by default
 * (`text-muted-foreground/60`, `size-3`) so it reads as a hint, not
 * clutter.
 *
 * Props are string-only (`text`, optional `side` enum + className strings)
 * so this client component is safe to render directly from the Server
 * Components on these surfaces — no function props cross the RSC boundary.
 */
export function InfoHint({
  text,
  side = "top",
  className,
  iconClassName,
}: {
  /** Plain-English one-liner shown in the tooltip. */
  text: string;
  /** Tooltip placement — defaults to "top". */
  side?: "top" | "bottom" | "left" | "right";
  /** Extra classes on the trigger wrapper (e.g. alignment tweaks). */
  className?: string;
  /** Extra classes on the icon itself (e.g. size overrides). */
  iconClassName?: string;
}) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              className={cn(
                "inline-flex shrink-0 cursor-help text-muted-foreground/60 transition-colors hover:text-muted-foreground",
                className,
              )}
              aria-label={text}
            >
              <Info className={cn("size-3", iconClassName)} />
            </span>
          }
        />
        <TooltipContent
          side={side}
          className="max-w-[18rem] text-xs leading-relaxed"
        >
          {text}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
