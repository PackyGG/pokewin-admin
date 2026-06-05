import * as React from "react";
import { type LucideIcon } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
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

// Panel + icon tints — same token set + same opacities as the dashboard
// `PANEL_TINT` / `ICON_TINT`, so a /creators panel is visually identical to
// a dashboard KPI box. Restricted to the accents the /creators strip uses.
const PANEL_TINT = {
  cyan: "bg-cyan-500/10",
  purple: "bg-purple-500/10",
  emerald: "bg-emerald-500/10",
  pink: "bg-pink-500/10",
  blue: "bg-blue-500/10",
  rose: "bg-rose-500/10",
} as const;

export type CreatorsPanelTint = keyof typeof PANEL_TINT;

const ICON_TINT: Record<CreatorsPanelTint, string> = {
  cyan: "text-cyan-400",
  purple: "text-purple-400",
  emerald: "text-emerald-400",
  pink: "text-pink-400",
  blue: "text-blue-400",
  rose: "text-rose-400",
};

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
    <Card className={PANEL_TINT[tint]}>
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
      <span className={isProfit ? "text-emerald-400" : "text-rose-400"}>
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
  const border =
    tone === "emerald"
      ? "border-emerald-500/15"
      : tone === "rose"
        ? "border-rose-500/15"
        : "border-border/60";
  const valueColor =
    tone === "emerald"
      ? "text-emerald-600 dark:text-emerald-400"
      : tone === "rose"
        ? "text-rose-600 dark:text-rose-400"
        : "text-foreground";
  return (
    <div
      className={cn(
        "rounded-md border bg-background/40 px-2 py-1.5 min-w-0",
        border,
      )}
    >
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
