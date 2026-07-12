"use client";

import { useState } from "react";
import {
  Banknote,
  ChevronDown,
  Info,
  Layers,
  PiggyBank,
  Receipt,
  Scale,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

/**
 * Serializable icon keys — the page is a server component, so it must pass a
 * string key (never a component ref) across the RSC boundary. Mirrors the
 * /security page's CollapsibleSecuritySection icon-map pattern.
 */
export const REAL_NUMBERS_SECTION_ICONS = {
  layers: Layers,
  scale: Scale,
  receipt: Receipt,
  banknote: Banknote,
  piggyBank: PiggyBank,
  sparkles: Sparkles,
  info: Info,
} as const satisfies Record<string, LucideIcon>;

export type RealNumbersSectionIcon = keyof typeof REAL_NUMBERS_SECTION_ICONS;

/**
 * Collapsible wrapper for the /insights/real-numbers sections — click the
 * heading row to expand/collapse the section body. Same mechanism as the
 * /security page's CollapsibleSecuritySection (shadcn Collapsible + a
 * ChevronDown that rotates 180° when open) so the two pages feel consistent.
 *
 * Trigger + content live inside ONE continuous bordered/rounded box — the
 * header fills the top, a `border-t` divider marks the seam, the content
 * fills the rest — so an open section visibly reads as "this content
 * belongs to this header" instead of two disconnected floating blocks.
 *
 * Only the open/close toggle is client-side; `children` is the server-rendered
 * section content (data flow, streamed boundaries, House-POV colours all
 * unchanged). The heading keeps the page's SectionHeading icon-chip language
 * (primary icon-chip + title) so nothing shifts beyond the added box + chevron.
 */
export function CollapsibleSection({
  icon,
  title,
  children,
  defaultOpen = true,
}: {
  icon: RealNumbersSectionIcon;
  title: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const Icon = REAL_NUMBERS_SECTION_ICONS[icon] ?? Layers;

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
            <span className="flex min-w-0 items-center gap-2.5">
              <span className="shrink-0 rounded-lg border border-primary/20 bg-primary/10 p-1.5 shadow-sm ring-1 ring-inset ring-white/5">
                <Icon className="size-4 text-primary" />
              </span>
              <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm font-semibold tracking-tight text-foreground/90 group-hover:text-foreground sm:text-base">
                {title}
              </span>
            </span>
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
