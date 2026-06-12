"use client";

import * as React from "react";
import { Info } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/utils/format";
import {
  SEMANTIC_TONES,
  type SemanticTone,
  type ToneTokens,
} from "./tones";

/**
 * ─────────────────────────────────────────────────────────────────────
 * Cost-Breakdown page primitives (SCOPED — cost-breakdown / insights only)
 * ─────────────────────────────────────────────────────────────────────
 *
 * Small, page-local building blocks for the wager → P&L story. They give
 * the page a strong, consistent reading hierarchy WITHOUT touching the
 * app-wide shared primitives (modern-panels.tsx / the dashboard box
 * system, both of which other pages depend on).
 *
 * What lives here (all "use client"):
 *   • MetricInfoPopover     — the "i" → breakdown-list popover the owner
 *     likes, standardized: a header (what it means) + signed breakdown
 *     rows + an optional "= total" math line. Same shape as the dashboard
 *     P&L-Today popover, rebuilt locally so this page never imports the
 *     dashboard-scoped shell.
 *   • InfoRow / InfoTotal    — the rows + total used inside a popover.
 *   • ValueChip              — a semantic, tone-tinted value pill.
 *
 * The semantic tone vocabulary (SEMANTIC_TONES / SemanticTone) is DEFINED
 * in the directive-free `./tones` module — NOT here — so the SERVER
 * `page.tsx` can import the genuine object (importing a value from this
 * "use client" module on the server yields a client-reference proxy whose
 * `.face`/etc. are undefined → crash during Flight serialize). This file
 * re-exports them below so existing `./_components` importers keep working.
 *
 * All props are serializable primitives — no function props cross the RSC
 * boundary (these are "use client", fed plain data by the server page).
 */

// Re-export the server-safe tone vocabulary so existing importers of this
// module keep working. The tokens are DEFINED in `./tones` (a directive-
// free module) so the server page reads the real object — see that file.
export { SEMANTIC_TONES, type SemanticTone, type ToneTokens };

// ─── MetricInfoPopover ────────────────────────────────────────────

/**
 * The "i" info-button → breakdown-list popover (the owner's preferred
 * pattern). Renders a small Info trigger; the popover holds a title +
 * plain-language "what this means" block, then arbitrary children
 * (usually InfoRow list + an InfoTotal). `tone` tints the trigger focus
 * ring + the header accent so each metric's popover matches its tile.
 */
export function MetricInfoPopover({
  tone = "muted",
  label,
  title,
  blurb,
  children,
  align = "start",
}: {
  tone?: SemanticTone;
  /** aria-label / title for the trigger button. */
  label: string;
  /** Bold header line inside the popover. */
  title: React.ReactNode;
  /** Plain-language explanation under the header. */
  blurb: React.ReactNode;
  /** Popover body — typically an <InfoRow> list + an <InfoTotal>. */
  children?: React.ReactNode;
  align?: "start" | "center" | "end";
}) {
  const t = SEMANTIC_TONES[tone] ?? SEMANTIC_TONES.muted;
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={label}
            title={label}
            className={cn(
              "inline-flex shrink-0 items-center rounded text-muted-foreground/60 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2",
              t.focus,
            )}
          />
        }
      >
        <Info className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent
        align={align}
        sideOffset={6}
        className="w-[340px] max-w-[calc(100vw-2rem)] space-y-2.5 p-3"
      >
        <div>
          <p
            className={cn(
              "text-xs font-semibold uppercase tracking-wider",
              t.text,
            )}
          >
            {title}
          </p>
          <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
            {blurb}
          </p>
        </div>
        {children}
      </PopoverContent>
    </Popover>
  );
}

/**
 * One row in a breakdown popover: an icon chip, label, optional sub-line,
 * and a tone-coloured amount on the right. `sign` is the leading glyph so
 * a shrinking liability can show "+" on an emerald amount even when the
 * raw delta is negative.
 *
 * `iconNode` is a PRE-RENDERED icon element (e.g. `<Coins className=
 * "size-3" />`), not a component function — the server page renders the
 * lucide icon itself and passes the node, mirroring WaterfallRow's
 * `iconNode` pattern. Passing the bare LucideIcon function here would put
 * a function prop on a "use client" component ("Functions cannot be
 * passed directly to Client Components"). The tone-tinted chip wrapper
 * stays in here so callers only supply the glyph.
 */
export function InfoRow({
  iconNode,
  label,
  sub,
  amount,
  sign = "",
  tone = "muted",
}: {
  iconNode?: React.ReactNode;
  label: React.ReactNode;
  sub?: React.ReactNode;
  amount: number;
  sign?: "+" | "−" | "";
  tone?: SemanticTone;
}) {
  const t = SEMANTIC_TONES[tone] ?? SEMANTIC_TONES.muted;
  return (
    <li className="flex items-center justify-between gap-2 rounded px-1 py-0.5 text-[11px] hover:bg-muted/40">
      <span className="flex min-w-0 items-center gap-1.5">
        {iconNode && (
          <span
            className={cn(
              "flex size-5 shrink-0 items-center justify-center rounded",
              t.chip,
            )}
          >
            {iconNode}
          </span>
        )}
        <span className="min-w-0">
          <span className="block truncate font-medium text-foreground/90">
            {label}
          </span>
          {sub && (
            <span className="block truncate text-[10px] text-muted-foreground">
              {sub}
            </span>
          )}
        </span>
      </span>
      <span className={cn("shrink-0 font-semibold tabular-nums", t.text)}>
        {sign}
        {formatCurrency(Math.abs(amount))}
      </span>
    </li>
  );
}

/** The bottom "= total" math line of a breakdown popover. */
export function InfoTotal({
  label,
  amount,
  sign = "",
  tone = "muted",
  note,
}: {
  label: React.ReactNode;
  amount: number;
  sign?: "+" | "−" | "=" | "";
  tone?: SemanticTone;
  note?: React.ReactNode;
}) {
  const t = SEMANTIC_TONES[tone] ?? SEMANTIC_TONES.muted;
  return (
    <div className="border-t border-border/60 pt-2">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        <span className={cn("font-bold tabular-nums", t.text)}>
          {sign === "=" ? "= " : sign}
          {formatCurrency(Math.abs(amount))}
        </span>
      </div>
      {note && (
        <p className="mt-1 text-[10px] leading-snug text-muted-foreground">
          {note}
        </p>
      )}
    </div>
  );
}

// ─── ValueChip ────────────────────────────────────────────────────

/**
 * A small semantic value pill — tone-tinted background + matching text.
 * Used in the story lead to make the few key figures pop inline without
 * relying on raw coloured text alone.
 */
export function ValueChip({
  tone = "muted",
  children,
  className,
}: {
  tone?: SemanticTone;
  children: React.ReactNode;
  className?: string;
}) {
  const t = SEMANTIC_TONES[tone] ?? SEMANTIC_TONES.muted;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-1.5 py-px font-semibold tabular-nums ring-1 ring-inset",
        t.face,
        t.ring,
        t.text,
        className,
      )}
    >
      {children}
    </span>
  );
}
