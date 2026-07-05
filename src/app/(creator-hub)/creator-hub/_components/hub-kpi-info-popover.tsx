"use client";

import { Info } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

export type HubInfoLine = {
  label: string;
  /** Pre-formatted display value. */
  value: string;
  tone?: "emerald" | "rose" | "muted" | "foreground";
};

/**
 * Generic (i) breakdown popover for Creator Hub KPI tiles — same chrome as
 * the main dashboard GGR / creator-cost info buttons.
 */
export function HubKpiInfoPopover({
  title,
  description,
  lines,
  footer,
  ariaLabel,
  ringClassName = "focus-visible:ring-cyan-500/40",
}: {
  title: string;
  description: string;
  lines?: HubInfoLine[];
  footer?: HubInfoLine;
  ariaLabel?: string;
  ringClassName?: string;
}) {
  const toneClass = (tone: HubInfoLine["tone"]) => {
    switch (tone) {
      case "emerald":
        return "text-emerald-600 dark:text-emerald-400";
      case "rose":
        return "text-rose-600 dark:text-rose-400";
      case "muted":
        return "text-muted-foreground";
      default:
        return "text-foreground";
    }
  };

  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={ariaLabel ?? `Show ${title} breakdown`}
            title={ariaLabel ?? `Show ${title} breakdown`}
            className={cn(
              "rounded text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2",
              ringClassName,
            )}
          />
        }
      >
        <Info className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        className="w-[340px] max-w-[calc(100vw-2rem)] space-y-2 p-3"
      >
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {title}
          </p>
          <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">
            {description}
          </p>
        </div>

        {lines && lines.length > 0 && (
          <ul className="max-h-72 space-y-0.5 overflow-y-auto pr-1">
            {lines.map((line, i) => (
              <li
                key={`${line.label}-${i}`}
                className="flex items-center justify-between gap-2 rounded px-1 py-0.5 text-[11px] hover:bg-muted/40"
              >
                <span className="truncate text-muted-foreground">
                  {line.label}
                </span>
                <span
                  className={cn(
                    "shrink-0 font-medium tabular-nums",
                    toneClass(line.tone),
                  )}
                >
                  {line.value}
                </span>
              </li>
            ))}
          </ul>
        )}

        {footer && (
          <div className="border-t border-border/60 pt-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold uppercase tracking-wider">
                {footer.label}
              </span>
              <span
                className={cn(
                  "font-bold tabular-nums",
                  toneClass(footer.tone ?? "foreground"),
                )}
              >
                {footer.value}
              </span>
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
