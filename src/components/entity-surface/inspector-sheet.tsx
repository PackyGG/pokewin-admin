"use client";

import * as React from "react";
import Link from "next/link";
import { ExternalLink } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { LazyModalContent } from "@/components/ux";
import { cn } from "@/lib/utils";
import {
  type AccentColor,
  TILE_COLORS,
} from "@/components/modern-panels";

/**
 * ──────────────────────────────────────────────────────────────────────────
 *  InspectorSheet + QuickEditDrawer  (pokewin-admin · src/components/entity-surface)
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Side-sheet primitives that let the operator view an entity's detail (or
 * quick-edit it) WITHOUT leaving the list — the master/detail pattern the
 * discovery maps recommend for both /packs and /cards. Built on the existing
 * base-ui `<Sheet>` so motion/a11y/dark-mode come for free.
 *
 * Two deliberate behaviours:
 *
 *   1. DEFERRED BODY: the heavy detail body is wrapped in `LazyModalContent`,
 *     which only mounts (and only runs its effects / lazy chunks) once the
 *     sheet is OPEN. Opening the inspector therefore never blocks on detail
 *     data — the shell + header paint instantly and the body streams in behind
 *     its own delay-gated spinner. This satisfies CLAUDE.md's "don't load
 *     hidden components" rule for drawers.
 *   2. KEEP PAGE CONTEXT: it's a right-side overlay, not a navigation, so the
 *     list stays mounted underneath; closing returns to the exact same scroll
 *     position + selection.
 *
 * The component is CONTROLLED (`open` / `onOpenChange`) so the caller can drive
 * it from row-click state or a `?inspect=<id>` URL param. A `fullHref` renders
 * an "Open full page" affordance for the deep-dive (e.g. `/packs/[id]`), so the
 * inspector is a fast preview, never a replacement for the canonical page.
 */

export function InspectorSheet({
  open,
  onOpenChange,
  icon: Icon,
  accent = "blue",
  title,
  subtitle,
  /** Full-page deep link shown as an action in the header. */
  fullHref,
  fullLabel = "Open full page",
  /** Header action slot (edit / toggle / delete buttons). */
  actions,
  /** Footer slot (primary action row). */
  footer,
  /** The heavy detail body — deferred until open. */
  children,
  /** Pending UI while the body resolves; defaults to the lazy spinner. */
  fallback,
  /** Reserve body height so streaming content doesn't jump the sheet. */
  bodyMinHeight = 200,
  /** Sheet width on desktop (CSS length). Defaults to a roomy 30rem. */
  width = "30rem",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  icon?: React.ElementType;
  accent?: AccentColor;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  fullHref?: string;
  fullLabel?: string;
  actions?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
  fallback?: React.ReactNode;
  bodyMinHeight?: number | string;
  width?: string;
}) {
  const colors = TILE_COLORS[accent];
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        // Override the primitive's default sm:max-w-sm with a roomier width
        // for a detail inspector; full-width on phones is inherited.
        className="sm:max-w-[var(--inspector-w)] sm:w-[var(--inspector-w)] gap-0 p-0"
        style={{ ["--inspector-w" as string]: width }}
      >
        <SheetHeader className="border-b p-4">
          <div className="flex items-start gap-3 pr-8">
            {Icon && (
              <div
                className={cn(
                  "flex size-9 shrink-0 items-center justify-center rounded-xl border shadow-sm ring-1 ring-inset ring-white/5",
                  colors.bg,
                )}
              >
                <Icon className={cn("size-[18px]", colors.icon)} />
              </div>
            )}
            <div className="min-w-0 flex-1">
              <SheetTitle className="truncate pr-0 text-base">
                {title}
              </SheetTitle>
              {subtitle && (
                <SheetDescription className="truncate text-xs">
                  {subtitle}
                </SheetDescription>
              )}
            </div>
          </div>
          {(actions || fullHref) && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {actions}
              {fullHref && (
                // `render={<Link/>}` composes the button onto a Next Link so
                // the deep-dive is a real client navigation (the codebase's
                // standard Button-as-Link idiom).
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8"
                  nativeButton={false}
                  render={<Link href={fullHref} />}
                >
                  <ExternalLink className="size-3.5" />
                  {fullLabel}
                </Button>
              )}
            </div>
          )}
        </SheetHeader>

        {/* Scrollable, DEFERRED body — mounts only while open. */}
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <LazyModalContent
            open={open}
            minHeight={bodyMinHeight}
            fallback={fallback}
          >
            {children}
          </LazyModalContent>
        </div>

        {footer && <SheetFooter>{footer}</SheetFooter>}
      </SheetContent>
    </Sheet>
  );
}

/**
 * Quick-edit drawer — a narrower side-sheet for fast scalar edits (a pack's
 * price + active toggle, a card's price) without a full page navigation. Same
 * deferral contract: the form body only mounts when open. Caller supplies the
 * form (a `"use client"` component invoking the existing server action) as
 * `children` and the submit row as `footer`.
 *
 * This is intentionally separate from `InspectorSheet`: the inspector is for
 * VIEWING (read-heavy, deep link out), the drawer is for a focused EDIT. Both
 * preserve list context.
 */
export function QuickEditDrawer({
  open,
  onOpenChange,
  icon: Icon,
  accent = "amber",
  title,
  subtitle,
  footer,
  children,
  fallback,
  bodyMinHeight = 160,
  width = "26rem",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  icon?: React.ElementType;
  accent?: AccentColor;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
  fallback?: React.ReactNode;
  bodyMinHeight?: number | string;
  width?: string;
}) {
  const colors = TILE_COLORS[accent];
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="sm:max-w-[var(--qe-w)] sm:w-[var(--qe-w)] gap-0 p-0"
        style={{ ["--qe-w" as string]: width }}
      >
        <SheetHeader className="border-b p-4">
          <div className="flex items-start gap-3 pr-8">
            {Icon && (
              <div
                className={cn(
                  "flex size-9 shrink-0 items-center justify-center rounded-xl border shadow-sm ring-1 ring-inset ring-white/5",
                  colors.bg,
                )}
              >
                <Icon className={cn("size-[18px]", colors.icon)} />
              </div>
            )}
            <div className="min-w-0 flex-1">
              <SheetTitle className="truncate pr-0 text-base">
                {title}
              </SheetTitle>
              {subtitle && (
                <SheetDescription className="truncate text-xs">
                  {subtitle}
                </SheetDescription>
              )}
            </div>
          </div>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <LazyModalContent
            open={open}
            minHeight={bodyMinHeight}
            fallback={fallback}
          >
            {children}
          </LazyModalContent>
        </div>

        {footer && <SheetFooter>{footer}</SheetFooter>}
      </SheetContent>
    </Sheet>
  );
}
