"use client";

import * as React from "react";
import { Info, type LucideIcon } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/utils/format";

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
 * What lives here:
 *   • SEMANTIC_TONES        — the page's restrained colour language. Held /
 *     unrealized liabilities get AMBER so they never read as a realized
 *     loss (rose); realized costs / money-back stay rose; the house keep
 *     (GGR/NGR/P&L positive) is emerald; the base wager is blue.
 *   • MetricInfoPopover     — the "i" → breakdown-list popover the owner
 *     likes, standardized: a header (what it means) + signed breakdown
 *     rows + an optional "= total" math line. Same shape as the dashboard
 *     P&L-Today popover, rebuilt locally so this page never imports the
 *     dashboard-scoped shell.
 *   • InfoRow / InfoTotal    — the rows + total used inside a popover.
 *   • ValueChip              — a semantic, tone-tinted value pill.
 *
 * All props are serializable primitives — no function props cross the RSC
 * boundary (these are "use client", fed plain data by the server page).
 */

// ─── Semantic tone language ───────────────────────────────────────

export type SemanticTone =
  /** Money the house KEEPS / is up on (GGR, NGR, P&L positive). */
  | "keep"
  /** A realized cost — money that flowed BACK to users (rose). */
  | "cost"
  /** Held / unrealized liability the house still owes (amber, NOT a
   *  realized loss). */
  | "held"
  /** The starting wager / a neutral cash-in (blue). */
  | "base"
  /** Honest leftover / rounding (muted). */
  | "muted";

type ToneTokens = {
  /** Tinted face background. */
  face: string;
  /** Hairline ring in the tone hue. */
  ring: string;
  /** Icon-chip background. */
  chip: string;
  /** Value / accent text colour (light + dark). */
  text: string;
  /** Bare icon colour. */
  icon: string;
  /** Magnitude-bar fill. */
  bar: string;
  /** Focus ring for interactive triggers. */
  focus: string;
};

export const SEMANTIC_TONES: Record<SemanticTone, ToneTokens> = {
  keep: {
    face: "bg-emerald-500/[0.07]",
    ring: "ring-emerald-500/20",
    chip: "bg-emerald-500/15 text-emerald-500 dark:text-emerald-400",
    text: "text-emerald-600 dark:text-emerald-400",
    icon: "text-emerald-500",
    bar: "bg-emerald-500/55",
    focus: "focus-visible:ring-emerald-500/40",
  },
  cost: {
    face: "bg-rose-500/[0.06]",
    ring: "ring-rose-500/20",
    chip: "bg-rose-500/15 text-rose-500 dark:text-rose-400",
    text: "text-rose-600 dark:text-rose-400",
    icon: "text-rose-500",
    bar: "bg-rose-500/55",
    focus: "focus-visible:ring-rose-500/40",
  },
  held: {
    face: "bg-amber-500/[0.07]",
    ring: "ring-amber-500/20",
    chip: "bg-amber-500/15 text-amber-500 dark:text-amber-400",
    text: "text-amber-600 dark:text-amber-400",
    icon: "text-amber-500",
    bar: "bg-amber-500/55",
    focus: "focus-visible:ring-amber-500/40",
  },
  base: {
    face: "bg-blue-500/[0.06]",
    ring: "ring-blue-500/20",
    chip: "bg-blue-500/15 text-blue-500 dark:text-blue-400",
    text: "text-blue-600 dark:text-blue-400",
    icon: "text-blue-500",
    bar: "bg-blue-500/55",
    focus: "focus-visible:ring-blue-500/40",
  },
  muted: {
    face: "bg-muted/40",
    ring: "ring-border/60",
    chip: "bg-muted text-muted-foreground",
    text: "text-muted-foreground",
    icon: "text-muted-foreground",
    bar: "bg-muted-foreground/40",
    focus: "focus-visible:ring-ring/40",
  },
};

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
 */
export function InfoRow({
  icon: Icon,
  label,
  sub,
  amount,
  sign = "",
  tone = "muted",
}: {
  icon?: LucideIcon;
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
        {Icon && (
          <span
            className={cn(
              "flex size-5 shrink-0 items-center justify-center rounded",
              t.chip,
            )}
          >
            <Icon className="size-3" />
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
