"use client";

import { useState } from "react";
import {
  Banknote,
  Bell,
  Bitcoin,
  ChevronDown,
  Coins,
  Dices,
  Gauge,
  Gem,
  Gift,
  Hourglass,
  Percent,
  Plus,
  SlidersHorizontal,
  Sparkles,
  Timer,
  Trophy,
  type LucideIcon,
} from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

/** Serializable icon keys — server pages must not pass component refs. */
const SECURITY_SECTION_ICONS = {
  banknote: Banknote,
  trophy: Trophy,
  percent: Percent,
  gem: Gem,
  gift: Gift,
  sparkles: Sparkles,
  coins: Coins,
  gauge: Gauge,
  dices: Dices,
  hourglass: Hourglass,
  bitcoin: Bitcoin,
  bell: Bell,
  sliders: SlidersHorizontal,
  timer: Timer,
  plus: Plus,
} as const satisfies Record<string, LucideIcon>;

export type SecuritySectionIcon = keyof typeof SECURITY_SECTION_ICONS;

/**
 * Collapsible wrapper for /security panels — click the heading row to
 * expand/collapse the section body.
 *
 * Trigger + content live inside ONE continuous bordered/rounded box — the
 * header fills the top, a `border-t` divider marks the seam, the content
 * fills the rest — so an open section visibly reads as "this content
 * belongs to this header" instead of two disconnected floating blocks.
 */
export function CollapsibleSecuritySection({
  icon,
  title,
  children,
  defaultOpen = false,
}: {
  icon: SecuritySectionIcon;
  title: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const Icon = SECURITY_SECTION_ICONS[icon] ?? SlidersHorizontal;

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn(
        "overflow-hidden rounded-lg border transition-colors",
        open ? "border-primary/25" : "border-border/60 hover:border-border",
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
            <div className="flex min-w-0 items-center gap-2.5">
              <div className="shrink-0 rounded-lg border border-primary/20 bg-primary/10 p-1.5 shadow-sm ring-1 ring-inset ring-white/5">
                <Icon className="size-4 text-primary" />
              </div>
              <span className="text-sm font-semibold tracking-tight text-foreground/90 group-hover:text-foreground sm:text-base">
                {title}
              </span>
            </div>
            <ChevronDown
              className={cn(
                "size-5 shrink-0 text-muted-foreground group-hover:text-foreground motion-safe:transition-transform motion-safe:duration-200",
                open && "rotate-180 text-primary",
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
