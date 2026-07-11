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
 * Visual language matches the flattened modern-panels.tsx KpiTile: one solid
 * bg-card surface with a hairline border, no colored fill / accent bar / sheen.
 * The TILE_COLORS accent survives ONLY on the icon glyph + the value number
 * (House-POV tinted where the value is money).
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
  // Flat tile — matches the flattened shared KpiTile in modern-panels.tsx: one
  // solid `bg-card` surface + a hairline border, uniform `rounded-lg`, static.
  // The per-hue colored FILL (`colors.bg`), the left accent bar, and the
  // diagonal white sheen are dropped; the accent now survives only on the icon
  // + the value number (House-POV tinted). The value stays an <AnimatedNumber>
  // so the ramp-on-mount behavior is unchanged — only the chrome was flattened.
  return (
    <div className="rounded-lg border bg-card px-3 py-2.5 sm:px-4 sm:py-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5 sm:gap-2">
          <Icon className={cn("size-3.5 shrink-0 sm:size-4", colors.icon)} />
          <span className="truncate text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            {label}
          </span>
        </div>
      </div>
      <AnimatedNumber
        value={value}
        format={format}
        className={cn(
          "mt-1.5 block truncate text-xl font-bold leading-tight tracking-tight tabular-nums sm:text-2xl",
          colors.text,
        )}
      />
      {sub && (
        <p className="mt-1 truncate text-xs text-muted-foreground">
          {sub}
        </p>
      )}
    </div>
  );
}
