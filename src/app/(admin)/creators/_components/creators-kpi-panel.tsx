import * as React from "react";
import { type LucideIcon } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { houseAmountTextClass } from "@/lib/house-pov";
import {
  AnimatedNumber,
  type AnimatedNumberFormat,
} from "@/components/animated-number";

/**
 * /creators KPI-strip panel primitives.
 *
 * These mirror the dashboard's reskinned KPI boxes
 * (`dashboard/dashboard-kpi-section.tsx` → `KpiPanel` / `PanelChip` /
 * `SignedHero` / `PlainHero`): a tinted `Card` with a header (title +
 * optional inline adornment + a right-aligned slot + an accent icon), a
 * hero value, and an optional chip-grid / subtitle body. Extracted to its
 * own module so the /creators server strip can compose the SAME panel look
 * as the dashboard "P&L Today"-style cards without pulling the dashboard's
 * client-only window-toggle machinery in.
 *
 * Server-safe by construction: every primitive takes only serializable
 * props + `React.ReactNode` slots (the popovers / hints the page already
 * builds are passed in as nodes), so the strip keeps rendering directly
 * from the Server Component — no function props cross the RSC boundary.
 * `AnimatedNumber` is a `"use client"` leaf but accepts serializable props,
 * so it's safe to render from here (it gives the hero the same period-swap
 * count-up the dashboard uses).
 *
 * House-POV colors are the caller's responsibility (the page picks the
 * accent + the signed/plain hero per CLAUDE.md's house-POV rule), exactly
 * as the dashboard section does.
 */

// Icon accent tints — the ONLY place a panel's accent color survives after
// the flat pass. Same token set the dashboard KPI boxes use for the glyph,
// but the per-hue Card FILL (the old `PANEL_TINT` `bg-<hue>-500/10`) was the
// layered noise the flat direction removes: every /creators panel now renders
// on a solid `bg-card` surface with a hairline ring (a plain <Card>), and the
// accent lives ONLY on the header icon + the hero value number. Restricted to
// the accents the /creators strip uses.
const ICON_TINT = {
  cyan: "text-cyan-600 dark:text-cyan-400",
  purple: "text-purple-600 dark:text-purple-400",
  emerald: "text-emerald-600 dark:text-emerald-400",
  pink: "text-pink-600 dark:text-pink-400",
  blue: "text-blue-600 dark:text-blue-400",
  rose: "text-rose-600 dark:text-rose-400",
} as const;

export type CreatorsPanelTint = keyof typeof ICON_TINT;

/**
 * Generic panel shell shared by every /creators KPI box — a tinted `Card`
 * with a header (title + optional inline adornment + a right-aligned slot +
 * an accent icon) and a body. Matches the dashboard `KpiPanel`.
 */
export function CreatorsKpiPanel({
  title,
  titleAdornment,
  headerRight,
  icon: Icon,
  tint,
  children,
}: {
  title: string;
  /** Rendered inline after the title (e.g. an ⓘ Info hint). */
  titleAdornment?: React.ReactNode;
  /**
   * Rendered at the right of the header, before the icon — used for the
   * drill-in popover triggers (Net GGR breakdown, per-creator PnL) + the
   * "backend unavailable" affordance the page already builds.
   */
  headerRight?: React.ReactNode;
  icon: LucideIcon;
  tint: CreatorsPanelTint;
  children: React.ReactNode;
}) {
  return (
    // Flat surface: a plain <Card> is already `bg-card` + a hairline ring, so
    // the panel reads on a solid neutral surface — no per-hue fill. The accent
    // survives only on the header icon (ICON_TINT) + the hero value inside.
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
        <CardTitle className="text-card-title text-muted-foreground inline-flex min-w-0 items-center gap-1">
          <span className="truncate">{title}</span>
          {titleAdornment}
        </CardTitle>
        <div className="flex shrink-0 items-center gap-1.5">
          {headerRight}
          <Icon className={cn("size-4 shrink-0", ICON_TINT[tint])} />
        </div>
      </CardHeader>
      <CardContent className="space-y-3">{children}</CardContent>
    </Card>
  );
}

/**
 * House-POV signed currency hero — `+`/`−` prefix + emerald/rose color,
 * matching the dashboard `SignedHero`. Pass the raw signed value; the sign
 * + color are derived here. A `null` value renders the dashed placeholder
 * (the tile's "couldn't load" / "no data" state) in a neutral tone.
 */
export function CreatorsSignedHero({ value }: { value: number | null }) {
  if (value == null) {
    return <div className="text-stat-value truncate text-muted-foreground">—</div>;
  }
  const isProfit = value >= 0;
  return (
    <div className="text-stat-value truncate">
      <span className={houseAmountTextClass(value)}>
        {isProfit ? "+" : "−"}
        <AnimatedNumber value={Math.abs(value)} format="currency" />
      </span>
    </div>
  );
}

/**
 * Plain hero value (no house-POV sign) in a caller-chosen tint — for
 * throughput / identity figures (count, converted total, leaderboard /
 * tips spend). Mirrors the dashboard `PlainHero` but lets the caller tint
 * the number (the dashboard's plain hero is always foreground; here the
 * rose spend heroes want their accent color on the number). `null` →
 * dashed placeholder.
 */
export function CreatorsPlainHero({
  value,
  format,
  className,
}: {
  value: number | null;
  format: AnimatedNumberFormat;
  /** Tailwind color class for the number (e.g. the rose spend tint). */
  className?: string;
}) {
  if (value == null) {
    return <div className="text-stat-value truncate text-muted-foreground">—</div>;
  }
  return (
    <div className={cn("text-stat-value truncate tabular-nums", className)}>
      <AnimatedNumber value={value} format={format} />
    </div>
  );
}

/**
 * Small labelled chip used in the panel breakdown grids — same chrome as
 * the dashboard `PanelChip` (tinted border by tone, animated value). Tone
 * picks the border + value color per house-POV. A `null` value renders a
 * dashed placeholder so a failed sub-figure reads as "—" not "$0".
 */
export function CreatorsPanelChip({
  label,
  value,
  format = "currency",
  tone = "neutral",
}: {
  label: string;
  value: number | null;
  format?: AnimatedNumberFormat;
  tone?: "neutral" | "emerald" | "rose";
}) {
  // Flat chip: a fixed hairline border + a neutral inset surface. The
  // per-tone COLORED border (the old `border-<hue>-500/15`) was dropped in the
  // flat pass — the accent survives only on the value number below (House-POV
  // emerald/rose), never on the chip's border or surface.
  const valueColor =
    tone === "emerald"
      ? "text-emerald-600 dark:text-emerald-400"
      : tone === "rose"
        ? "text-rose-600 dark:text-rose-400"
        : "text-foreground";
  return (
    <div className="rounded-md border border-border/60 bg-background/40 px-2 py-1.5 min-w-0">
      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground truncate">
        {label}
      </p>
      <p className={cn("text-xs font-semibold tabular-nums truncate", valueColor)}>
        {value == null ? "—" : <AnimatedNumber value={value} format={format} />}
      </p>
    </div>
  );
}

/** Plain muted subtitle line under a hero (matches `text-stat-label`). */
export function CreatorsPanelSub({ children }: { children: React.ReactNode }) {
  return <p className="text-stat-label truncate">{children}</p>;
}
