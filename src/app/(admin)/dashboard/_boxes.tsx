"use client";

import * as React from "react";
import { Info, type LucideIcon } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { AnimatedNumber } from "@/components/animated-number";
import { formatCurrency } from "@/lib/utils/format";
import { cn } from "@/lib/utils";

/**
 * ─────────────────────────────────────────────────────────────────────
 * Dashboard box system (DASHBOARD-SCOPED — do NOT reuse on other pages)
 * ─────────────────────────────────────────────────────────────────────
 *
 * One cohesive visual language for every metric/info box on the
 * dashboard, distilled from the polished "P&L Today" tile
 * (today-pnl-stat-card.tsx) which is the quality bar. The same hairline
 * ring + tinted face + header (title · info-popover · status chip) + a
 * two-tier hierarchy (hero value → sub-chip row under a hairline
 * divider) is captured here once so the GGR / Wager / Deposits /
 * Withdrawals / PnL / Reward-cost / Creator-cost cards all read as a
 * single family instead of eight near-but-not-quite-identical cards.
 *
 * WHY THIS LIVES UNDER dashboard/ AND NOT in src/components: the shared
 * app-wide primitives (KpiTile / StatPanel / MetricTile in
 * modern-panels.tsx, and StatCard in ./stat-card.tsx) are consumed by
 * /users/[id], /creators and /analytics. Restyling those would silently
 * change those pages. This module is imported ONLY by the dashboard box
 * components, so the new look is scoped to /dashboard by construction.
 *
 * Hierarchy (three weights, one language):
 *   • DashboardHeroBox   — the headline metric box. Big value, optional
 *     info popover, optional status chip, optional sub-chip row. Used
 *     for the primary KPI strip + the today-cost tiles.
 *   • DashboardKpiBox    — the compact secondary KPI tile (denser, reads
 *     lighter than the hero box) for the all-time snapshot strip.
 *   • DashboardFaceChip  — the small sub-metric chip shown on a box face
 *     (Deposits/Withdrawals on P&L Today, Packs/Battles/Upgrader on
 *     Wager, the two loudest cost lines on the cost tiles).
 *
 * Plus the shared info-popover shell used by every box's "i" button so
 * the breakdown popovers are visually identical:
 *   • DashboardInfoPopover    — the trigger + PopoverContent shell.
 *   • DashboardPopoverHeader   — title + description block.
 *   • DashboardBreakdownRow    — one icon · label · (sub) · amount row.
 *   • DashboardBreakdownTotal   — the bottom "= total" math line.
 *
 * All props are serializable primitives — no function props cross the
 * RSC boundary (AnimatedNumber takes the `format` string-enum, not a
 * formatter fn) per CLAUDE.md / Next 15.
 */

// ─── Accent tokens ────────────────────────────────────────────────
//
// A box's accent drives BOTH its tinted face and its matching hairline
// ring (the P&L Today look: a tinted panel with a defined ring edge in
// the same hue), plus the status-chip + value colors. `emerald` / `rose`
// double as the House-POV state colors (house in profit → emerald, house
// in the red / a house cost → rose); the rest (cyan / purple / blue /
// pink / amber) are identity-only accents for cards whose value has no
// inherent house-POV sign (Wager, Deposits, Withdrawals, …).

export type BoxAccent =
  | "emerald"
  | "rose"
  | "cyan"
  | "purple"
  | "blue"
  | "pink"
  | "amber";

type AccentTokens = {
  /** Tinted card face. */
  face: string;
  /** Hairline ring in the accent hue — deepens the tint into a defined edge. */
  ring: string;
  /** Status-chip background + icon color. */
  chip: string;
  /** Value / accent text color (light + dark). */
  text: string;
  /** Sub-chip border tint. */
  chipBorder: string;
  /** Info-popover focus ring. */
  focus: string;
};

const ACCENTS: Record<BoxAccent, AccentTokens> = {
  emerald: {
    face: "bg-emerald-500/10",
    ring: "ring-emerald-500/20",
    chip: "bg-emerald-500/15 text-emerald-400",
    text: "text-emerald-600 dark:text-emerald-400",
    chipBorder: "border-emerald-500/15",
    focus: "focus-visible:ring-emerald-500/40",
  },
  rose: {
    face: "bg-rose-500/10",
    ring: "ring-rose-500/20",
    chip: "bg-rose-500/15 text-rose-400",
    text: "text-rose-600 dark:text-rose-400",
    chipBorder: "border-rose-500/15",
    focus: "focus-visible:ring-rose-500/40",
  },
  cyan: {
    face: "bg-cyan-500/10",
    ring: "ring-cyan-500/20",
    chip: "bg-cyan-500/15 text-cyan-400",
    text: "text-cyan-600 dark:text-cyan-400",
    chipBorder: "border-cyan-500/15",
    focus: "focus-visible:ring-cyan-500/40",
  },
  purple: {
    face: "bg-purple-500/10",
    ring: "ring-purple-500/20",
    chip: "bg-purple-500/15 text-purple-400",
    text: "text-purple-600 dark:text-purple-400",
    chipBorder: "border-purple-500/15",
    focus: "focus-visible:ring-purple-500/40",
  },
  blue: {
    face: "bg-blue-500/10",
    ring: "ring-blue-500/20",
    chip: "bg-blue-500/15 text-blue-400",
    text: "text-blue-600 dark:text-blue-400",
    chipBorder: "border-blue-500/15",
    focus: "focus-visible:ring-blue-500/40",
  },
  pink: {
    face: "bg-pink-500/10",
    ring: "ring-pink-500/20",
    chip: "bg-pink-500/15 text-pink-400",
    text: "text-pink-600 dark:text-pink-400",
    chipBorder: "border-pink-500/15",
    focus: "focus-visible:ring-pink-500/40",
  },
  amber: {
    face: "bg-amber-500/10",
    ring: "ring-amber-500/20",
    chip: "bg-amber-500/15 text-amber-400",
    text: "text-amber-600 dark:text-amber-400",
    chipBorder: "border-amber-500/15",
    focus: "focus-visible:ring-amber-500/40",
  },
};

/** Public accessor so a box can grab its accent's value-text / focus class. */
export function boxAccent(accent: BoxAccent): AccentTokens {
  return ACCENTS[accent];
}

// ─── DashboardHeroBox ─────────────────────────────────────────────

/**
 * The headline metric box — the P&L Today shape generalized. A tinted
 * face + matching hairline ring in the accent hue, a header with the
 * title (plus an optional info-popover slot and an optional date/period
 * caption) and an optional status chip on the right, the big hero value,
 * and an optional sub-chip row sitting under a hairline divider so the
 * value and its drivers read as a clear two-tier hierarchy.
 *
 * The value is passed as a node so callers keep full control of sign +
 * color (House-POV) and use AnimatedNumber directly. `chips`, when
 * present, render under the divider in a responsive grid.
 */
export function DashboardHeroBox({
  title,
  accent,
  caption,
  info,
  chip,
  value,
  chips,
  chipColumns = 2,
  footer,
  contentClassName,
}: {
  title: React.ReactNode;
  accent: BoxAccent;
  /** Small muted line under the title (date / period). */
  caption?: React.ReactNode;
  /** Optional info-popover node rendered inline after the title. */
  info?: React.ReactNode;
  /** Optional status chip on the right of the header (trend glyph / icon). */
  chip?: React.ReactNode;
  /** The hero value — caller owns sign + House-POV color. */
  value: React.ReactNode;
  /** Optional sub-chip row rendered under a hairline divider. */
  chips?: React.ReactNode;
  /** Column count for the sub-chip grid (2 or 3). */
  chipColumns?: 2 | 3;
  /**
   * Optional content rendered below the value INSTEAD of the chip grid
   * (e.g. an empty-state note when there are no chips to show). Ignored
   * when `chips` is present.
   */
  footer?: React.ReactNode;
  contentClassName?: string;
}) {
  const a = ACCENTS[accent];
  return (
    <Card className={cn("flex h-full flex-col", a.face, a.ring)}>
      <CardHeader className="flex flex-row items-start justify-between gap-2 pb-1.5">
        <div className="flex min-w-0 flex-col gap-0.5">
          <CardTitle className="text-card-title text-muted-foreground inline-flex items-center gap-1">
            {title}
            {info}
          </CardTitle>
          {caption && (
            <span className="text-tiny text-muted-foreground tabular-nums">
              {caption}
            </span>
          )}
        </div>
        {chip}
      </CardHeader>
      <CardContent className={cn("flex flex-1 flex-col gap-3", contentClassName)}>
        <div className="text-stat-value truncate leading-none">{value}</div>
        {chips ? (
          <div
            className={cn(
              "mt-auto grid gap-1.5 border-t border-border/50 pt-3",
              chipColumns === 3 ? "grid-cols-3" : "grid-cols-2",
            )}
          >
            {chips}
          </div>
        ) : (
          footer
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The status chip on the right of a hero box header — a tinted square
 * holding a trend glyph or category icon. Reads as a badge, not a loose
 * icon (the headline color cue for the whole tile).
 */
export function DashboardStatusChip({
  icon: Icon,
  accent,
}: {
  icon: LucideIcon;
  accent: BoxAccent;
}) {
  const a = ACCENTS[accent];
  return (
    <span
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-lg",
        a.chip,
      )}
    >
      <Icon className="size-4" />
    </span>
  );
}

// ─── DashboardFaceChip ────────────────────────────────────────────

/**
 * Small chip showing one sub-metric on a box face. Unifies the
 * Deposits/Withdrawals chips (P&L Today), the Packs/Battles/Upgrader
 * chips (Wager), and the two-loudest-line chips (cost tiles) into one
 * consistent chip. `tone` colors the value (House-POV or identity);
 * omit it for a neutral value.
 *
 * `valueNode` lets a chip render a composite value (e.g. the leaderboard
 * "full / our-cut" pair) instead of a single animated number.
 */
export function DashboardFaceChip({
  label,
  value,
  valueNode,
  tone,
  labelSuffix,
  title,
}: {
  label: string;
  value?: number;
  /** Composite value node — overrides `value` when present. */
  valueNode?: React.ReactNode;
  /** Value color. Omit for neutral foreground. */
  tone?: BoxAccent;
  /** Optional inline suffix after the label (e.g. "· 100% / ours"). */
  labelSuffix?: React.ReactNode;
  /** Optional native title tooltip on the value. */
  title?: string;
}) {
  const a = tone ? ACCENTS[tone] : null;
  return (
    <div
      className={cn(
        "min-w-0 rounded-lg border bg-background/40 px-2.5 py-2",
        a ? a.chipBorder : "border-border/60",
      )}
    >
      <p className="truncate text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
        {labelSuffix}
      </p>
      <p
        className={cn(
          "mt-0.5 truncate text-sm font-semibold tabular-nums",
          a ? a.text : "text-foreground",
        )}
        title={title}
      >
        {valueNode ?? (
          <AnimatedNumber value={value ?? 0} format="currency" />
        )}
      </p>
    </div>
  );
}

// ─── DashboardKpiBox ──────────────────────────────────────────────

/**
 * Compact secondary-strip KPI tile. Shares the box language (the
 * shadcn hairline ring + a tinted face) but reads LIGHTER than the hero
 * box: a single header row (icon chip + label), the value, and an
 * optional sub-label. This is the dashboard's replacement for the
 * shared <StatCard> in the all-time snapshot strip — kept here so the
 * shared StatCard (still used by /analytics) is unchanged.
 *
 * Pass `value` for a plain string, OR `animatedValue` + `format` for a
 * smooth transition (the format is a string-enum — RSC-safe).
 */
export function DashboardKpiBox({
  label,
  value,
  animatedValue,
  format,
  sub,
  icon: Icon,
  accent,
}: {
  label: string;
  value?: string | number;
  animatedValue?: number;
  format?: "currency" | "number" | "percent";
  sub?: React.ReactNode;
  icon: LucideIcon;
  accent: BoxAccent;
}) {
  const a = ACCENTS[accent];
  const useAnimated =
    typeof animatedValue === "number" && typeof format === "string";
  return (
    <Card className={cn("gap-0 py-3", a.face, a.ring)}>
      <CardHeader className="px-3 pb-1.5 sm:px-4">
        <div className="flex items-center gap-1.5 sm:gap-2">
          <span
            className={cn(
              "flex size-6 shrink-0 items-center justify-center rounded-md",
              a.chip,
            )}
          >
            <Icon className="size-3.5" />
          </span>
          <span className="truncate text-[10px] font-semibold uppercase tracking-wider text-muted-foreground sm:text-[11px]">
            {label}
          </span>
        </div>
      </CardHeader>
      <CardContent className="px-3 sm:px-4">
        <div
          className={cn(
            "truncate text-xl font-bold leading-tight tracking-tight tabular-nums sm:text-2xl",
            a.text,
          )}
        >
          {useAnimated ? (
            <AnimatedNumber value={animatedValue!} format={format!} />
          ) : (
            value
          )}
        </div>
        {sub && (
          <p className="mt-0.5 truncate text-[10px] text-muted-foreground sm:text-[11px]">
            {sub}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Info-popover shell ───────────────────────────────────────────

/**
 * Shared info-popover shell — the "i" trigger + PopoverContent used by
 * every dashboard box breakdown so they're visually identical (the
 * shape the P&L Today / GGR breakdown popovers already use). `accent`
 * tints the trigger's focus ring to match the box. Children are the
 * popover body (header + rows + total).
 */
export function DashboardInfoPopover({
  accent,
  label,
  children,
  contentClassName,
}: {
  accent: BoxAccent;
  /** aria-label / title for the trigger button. */
  label: string;
  children: React.ReactNode;
  contentClassName?: string;
}) {
  const a = ACCENTS[accent];
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={label}
            title={label}
            className={cn(
              "rounded text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2",
              a.focus,
            )}
          />
        }
      >
        <Info className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className={cn(
          "w-[340px] max-w-[calc(100vw-2rem)] space-y-2 p-3",
          contentClassName,
        )}
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}

/** Title + description block at the top of a breakdown popover. */
export function DashboardPopoverHeader({
  title,
  children,
}: {
  title: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </p>
      <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">
        {children}
      </p>
    </div>
  );
}

/**
 * One breakdown row inside a popover: a neutral icon chip, label,
 * optional sub-line, and a House-POV-colored amount on the right. The
 * amount color comes from `tone` (emerald/rose/neutral) and the sign is
 * derived from the displayed magnitude + an explicit `sign` so a
 * shrinking-liability "+" can sit on an emerald amount even when the raw
 * delta is negative (matching the analytics Period-P&L breakdown).
 */
export function DashboardBreakdownRow({
  icon: Icon,
  label,
  sub,
  amount,
  sign,
  tone,
}: {
  icon: LucideIcon;
  label: React.ReactNode;
  sub?: React.ReactNode;
  /** Magnitude to render (already absolute, or any number — we format it). */
  amount: number;
  /** Leading sign glyph. */
  sign: "+" | "−" | "";
  tone: "emerald" | "rose" | "neutral";
}) {
  const amountColor =
    tone === "emerald"
      ? "text-emerald-600 dark:text-emerald-400"
      : tone === "rose"
        ? "text-rose-600 dark:text-rose-400"
        : "text-muted-foreground";
  return (
    <li className="flex items-center justify-between gap-2 rounded px-1 py-0.5 text-[11px] hover:bg-muted/40">
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="flex size-5 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
          <Icon className="size-3" />
        </span>
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
      <span className={cn("shrink-0 font-semibold tabular-nums", amountColor)}>
        {sign}
        {formatCurrency(Math.abs(amount))}
      </span>
    </li>
  );
}

/**
 * The bottom "= total" math line of a breakdown popover, separated by a
 * hairline divider. `tone` colors the total (House-POV); `sign` is its
 * leading glyph. Optional `note` renders a muted callout under the line.
 */
export function DashboardBreakdownTotal({
  label,
  amount,
  sign,
  tone,
  note,
}: {
  label: React.ReactNode;
  amount: number;
  sign: "+" | "−" | "";
  tone: "emerald" | "rose";
  note?: React.ReactNode;
}) {
  const color = tone === "emerald" ? "text-emerald-400" : "text-rose-400";
  return (
    <div className="border-t border-border/60 pt-2">
      <div className="flex items-center justify-between text-xs">
        <span className="font-semibold uppercase tracking-wider">{label}</span>
        <span className={cn("font-bold tabular-nums", color)}>
          {sign}
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
