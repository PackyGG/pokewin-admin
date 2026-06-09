"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";

import { StatPanel, type AccentColor } from "@/components/modern-panels";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { TEXT_TONE } from "./colors";

/** Text-tone keys a group headline can use (House-POV, dark-mode aware). */
export type LeverGroupTone = keyof typeof TEXT_TONE;

/**
 * A single lever workspace card with progressive disclosure.
 *
 * Wraps the house `StatPanel` and splits a dense slider cluster into:
 *   - **Basic** (`children`) — always visible.
 *   - **Advanced** (`advanced`) — tucked behind a "Advanced · N" toggle
 *     (shadcn/base-ui `Collapsible`), so the rakeback / affiliate / deposit-
 *     bonus / races clusters stay calm by default but every knob is one
 *     click away.
 *
 * House conventions: `StatPanel` accent + the optional `headline` tone come
 * from `colors.ts` (the verified color-token source), dark-mode aware, no
 * inline color values. The collapse animation is the shared
 * `[data-slot="collapsible-content"]` transition wired in `globals.css`
 * (height ease, reduced-motion safe).
 */
export function LeverGroup({
  title,
  icon,
  accent,
  action,
  intro,
  headline,
  children,
  advanced,
  advancedCount,
  advancedLabel = "Advanced",
  defaultAdvancedOpen = false,
}: {
  title: React.ReactNode;
  icon: React.ElementType;
  accent: AccentColor;
  /** Optional node rendered in the panel's top-right (e.g. a Switch). */
  action?: React.ReactNode;
  /** Optional lead-in copy shown above the Basic cluster. */
  intro?: React.ReactNode;
  /**
   * Optional prominent headline figure (e.g. realized cost this window),
   * tinted via the shared `TEXT_TONE` tokens.
   */
  headline?: { label: React.ReactNode; value: React.ReactNode; tone?: LeverGroupTone };
  /** Always-visible (Basic) controls. */
  children: React.ReactNode;
  /** Collapsed (Advanced) controls. Omit to render a Basic-only card. */
  advanced?: React.ReactNode;
  /** Count shown as "Advanced · N". Omit to show a plain "Advanced" label. */
  advancedCount?: number;
  /** Override the toggle label (default "Advanced"). */
  advancedLabel?: string;
  /** Open the Advanced cluster on first render. */
  defaultAdvancedOpen?: boolean;
}) {
  const [open, setOpen] = React.useState(defaultAdvancedOpen);
  const hasAdvanced = advanced != null;

  return (
    <StatPanel title={title} icon={icon} accent={accent} action={action}>
      {intro != null && (
        <div className="mb-3 text-xs leading-relaxed text-muted-foreground">
          {intro}
        </div>
      )}

      {headline != null && (
        <div className="mb-3 flex items-baseline justify-between gap-3 border-b pb-3">
          <span className="min-w-0 truncate text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {headline.label}
          </span>
          <span
            className={cn(
              "shrink-0 text-lg font-bold tabular-nums",
              headline.tone ? TEXT_TONE[headline.tone] : undefined,
            )}
          >
            {headline.value}
          </span>
        </div>
      )}

      <div className="space-y-3">{children}</div>

      {hasAdvanced && (
        <Collapsible
          open={open}
          onOpenChange={setOpen}
          className="mt-4 border-t pt-3"
        >
          <CollapsibleTrigger
            render={
              <Button
                variant="outline"
                size="sm"
                className="w-full justify-between gap-1.5"
              >
                <span className="flex items-center gap-1.5">
                  {advancedLabel}
                  {typeof advancedCount === "number" && advancedCount > 0 && (
                    <span className="text-muted-foreground">
                      · {advancedCount}
                    </span>
                  )}
                </span>
                <ChevronDown
                  className={cn(
                    "size-3.5 text-muted-foreground motion-safe:transition-transform motion-safe:duration-200",
                    open && "rotate-180",
                  )}
                />
              </Button>
            }
          />
          <CollapsibleContent>
            <div className="space-y-3 pt-3">{advanced}</div>
          </CollapsibleContent>
        </Collapsible>
      )}
    </StatPanel>
  );
}
