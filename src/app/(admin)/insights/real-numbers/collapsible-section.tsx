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
 * Only the open/close toggle is client-side; `children` is the server-rendered
 * section content (data flow, streamed boundaries, House-POV colours all
 * unchanged). The heading visually matches the page's SectionHeading
 * (primary icon-chip + <h2> title) so nothing shifts beyond the chevron.
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
    <Collapsible open={open} onOpenChange={setOpen} className="space-y-3">
      <CollapsibleTrigger
        render={
          <button
            type="button"
            className="flex w-full items-center justify-between gap-3 rounded-lg px-1 py-0.5 text-left transition-colors hover:bg-muted/40"
          >
            <span className="flex min-w-0 items-center gap-2.5">
              <span className="shrink-0 rounded-lg border border-primary/20 bg-primary/10 p-1.5 shadow-sm ring-1 ring-inset ring-white/5">
                <Icon className="size-4 text-primary" />
              </span>
              <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm font-semibold tracking-tight sm:text-base">
                {title}
              </span>
            </span>
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
