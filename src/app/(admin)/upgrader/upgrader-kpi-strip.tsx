/**
 * Upgrader KPI strip — the headline numbers an operator reads first.
 *
 * Server-iso (NO "use client"). The strip is presentational only: it renders
 * tiles whose hero value is a <AnimatedNumber> (itself a Client Component, but
 * embedded as a child inside the server tree, which is fine — children cross
 * the RSC boundary normally). Keeping the strip server-side means the LucideIcon
 * components handed in from the server page do NOT cross an RSC boundary as a
 * prop — passing a server-imported Lucide icon as a function-prop to a Client
 * Component is the exact pattern that white-screened the dashboard with prod
 * digest 1137743576 (89bd799, reverted in 13191cb). This file used to carry
 * `"use client"` for the same reason, so it had the same latent crash. Removing
 * the directive makes the tile a Server Component end-to-end and the icon prop
 * stays inside server code.
 *
 * Visual language matches modern-panels.tsx: left accent bar, glassy diagonal
 * sheen, surface-sheen lifted edge, and the same TILE_COLORS accents.
 *
 * House-POV coloring (CLAUDE.md, strict): the upgrader output pool is the
 * set of cards a player can *win*, so its monetary size is payout liability
 * — money the house may owe the user. Pool value / avg / max payout are
 * therefore ROSE (user gain), matching the dashboard Upgrader section where
 * payouts are rose. Plain counts of the pool (total / enabled / disabled)
 * are inventory metrics with no win/loss direction, so they keep neutral
 * informational accents (blue / emerald / muted).
 */

import * as React from "react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  AnimatedNumber,
  type AnimatedNumberFormat,
} from "@/components/animated-number";
import { TILE_COLORS, type AccentColor } from "@/components/modern-panels";

export type UpgraderKpi = {
  label: string;
  /** Raw numeric value — ramped via <AnimatedNumber>. */
  value: number;
  /** Serializable formatter selector. */
  format: AnimatedNumberFormat;
  sub?: string;
  icon: LucideIcon;
  accent: AccentColor;
};

export function UpgraderKpiStrip({ items }: { items: UpgraderKpi[] }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {items.map((kpi) => (
        <UpgraderKpiTile key={kpi.label} {...kpi} />
      ))}
    </div>
  );
}

function UpgraderKpiTile({
  label,
  value,
  format,
  sub,
  icon: Icon,
  accent,
}: UpgraderKpi) {
  const colors = TILE_COLORS[accent];
  return (
    <div
      className={cn(
        "hover-raise group surface-sheen relative overflow-hidden rounded-xl border px-3 py-2.5 sm:px-4 sm:py-3",
        colors.bg,
      )}
    >
      {/* Left accent bar — inherits the accent hue, brightens on hover.
          Neutral by construction: hue is caller-chosen (House-POV). */}
      <div
        aria-hidden
        className={cn(
          "tile-accent-bar pointer-events-none absolute inset-y-0 left-0 w-0.5 bg-current opacity-50 transition-opacity duration-200 group-hover:opacity-80",
          colors.icon,
        )}
      />
      {/* Faint diagonal sheen for a glassy finish — neutral white. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-gradient-to-br from-white/[0.04] to-transparent"
      />
      <div className="relative flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5 sm:gap-2">
          <Icon className={cn("size-3.5 shrink-0 sm:size-4", colors.icon)} />
          <span className="truncate text-[10px] font-semibold uppercase tracking-wider text-muted-foreground sm:text-[11px]">
            {label}
          </span>
        </div>
      </div>
      <AnimatedNumber
        value={value}
        format={format}
        className={cn(
          "relative mt-1 block truncate text-xl font-bold leading-tight tracking-tight tabular-nums sm:text-2xl",
          colors.text,
        )}
      />
      {sub && (
        <p className="relative mt-0.5 truncate text-[10px] text-muted-foreground sm:text-[11px]">
          {sub}
        </p>
      )}
    </div>
  );
}
