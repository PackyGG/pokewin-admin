import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Shared modern UI primitives. Extracted so every admin page can apply
 * the same hero + tile aesthetic introduced on the user detail modern
 * view.
 *
 * Primitives:
 *   - TILE_COLORS         — accent color tokens (blue / emerald / rose / …)
 *   - PageHero            — gradient hero block with soft corner glows
 *   - SectionHeading      — icon chip + title, used to open a section
 *   - KpiTile             — compact stat tile with accent color
 *   - StatPanel           — larger stat card with corner glow + hero number
 *   - MetricTile          — medium tile used in-tab (between KpiTile and StatPanel)
 */

export type AccentColor =
  | "blue"
  | "emerald"
  | "rose"
  | "cyan"
  | "amber"
  | "purple"
  | "orange"
  | "pink";

export const TILE_COLORS: Record<
  AccentColor,
  { bg: string; text: string; icon: string }
> = {
  blue: {
    bg: "bg-blue-500/10 border-blue-500/20",
    text: "text-blue-600 dark:text-blue-400",
    icon: "text-blue-500",
  },
  emerald: {
    bg: "bg-emerald-500/10 border-emerald-500/20",
    text: "text-emerald-600 dark:text-emerald-400",
    icon: "text-emerald-500",
  },
  rose: {
    bg: "bg-rose-500/10 border-rose-500/20",
    text: "text-rose-600 dark:text-rose-400",
    icon: "text-rose-500",
  },
  cyan: {
    bg: "bg-cyan-500/10 border-cyan-500/20",
    text: "text-cyan-600 dark:text-cyan-400",
    icon: "text-cyan-500",
  },
  amber: {
    bg: "bg-amber-500/10 border-amber-500/20",
    text: "text-amber-600 dark:text-amber-400",
    icon: "text-amber-500",
  },
  purple: {
    bg: "bg-purple-500/10 border-purple-500/20",
    text: "text-purple-600 dark:text-purple-400",
    icon: "text-purple-500",
  },
  orange: {
    bg: "bg-orange-500/10 border-orange-500/20",
    text: "text-orange-600 dark:text-orange-400",
    icon: "text-orange-500",
  },
  pink: {
    bg: "bg-pink-500/10 border-pink-500/20",
    text: "text-pink-600 dark:text-pink-400",
    icon: "text-pink-500",
  },
};

// ─── PageHero ─────────────────────────────────────────────────────

/**
 * Rounded gradient container with subtle blue/purple corner glows.
 * Use at the top of a page instead of a bare <h1>. Children go inside
 * the relative padded area.
 */
export function PageHero({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-2xl border bg-gradient-to-br from-card via-card to-card/60",
        className,
      )}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute -right-24 -top-24 size-72 rounded-full bg-blue-500/[0.06] blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -left-24 -bottom-24 size-72 rounded-full bg-purple-500/[0.06] blur-3xl"
      />
      <div className="relative p-5 md:p-6">{children}</div>
    </div>
  );
}

// ─── SectionHeading ───────────────────────────────────────────────

export function SectionHeading({
  icon: Icon,
  title,
  action,
}: {
  icon: React.ElementType;
  title: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        <div className="rounded-md bg-primary/10 p-1.5">
          <Icon className="size-4 text-primary" />
        </div>
        <h3 className="text-base font-semibold">{title}</h3>
      </div>
      {action}
    </div>
  );
}

// ─── KpiTile ──────────────────────────────────────────────────────

/** Compact stat tile used in hero KPI strips (6+ per row). */
export function KpiTile({
  label,
  value,
  sub,
  icon: Icon,
  accent = "blue",
}: {
  label: string;
  value: string;
  sub?: string;
  icon: React.ElementType;
  accent?: AccentColor;
}) {
  const colors = TILE_COLORS[accent];
  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-xl border px-4 py-3 transition-all hover:shadow-md min-w-[160px]",
        colors.bg,
      )}
    >
      <div className="flex items-center gap-2">
        <Icon className={cn("size-4", colors.icon)} />
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
      </div>
      <p
        className={cn(
          "mt-1 text-xl font-bold tabular-nums leading-tight",
          colors.text,
        )}
      >
        {value}
      </p>
      {sub && (
        <p className="mt-0.5 text-[11px] text-muted-foreground truncate">
          {sub}
        </p>
      )}
    </div>
  );
}

// ─── MetricTile ───────────────────────────────────────────────────

/** Medium stat tile — more prominent than KpiTile, less than StatPanel. */
export function MetricTile({
  label,
  value,
  sub,
  icon: Icon,
  accent = "blue",
}: {
  label: string;
  value: string;
  sub?: string;
  icon: React.ElementType;
  accent?: AccentColor;
}) {
  const colors = TILE_COLORS[accent];
  return (
    <div className={cn("rounded-xl border p-4", colors.bg)}>
      <div className="flex items-center gap-2">
        <Icon className={cn("size-4", colors.icon)} />
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
      </div>
      <p className={cn("mt-1 text-2xl font-bold tabular-nums", colors.text)}>
        {value}
      </p>
      {sub && (
        <p className="mt-0.5 text-[11px] text-muted-foreground truncate">
          {sub}
        </p>
      )}
    </div>
  );
}

// ─── StatPanel ────────────────────────────────────────────────────

/**
 * Full stat card with corner glow, hero number, and room for breakdown
 * rows. Pair with <PanelRow>.
 */
export function StatPanel({
  title,
  icon: Icon,
  accent,
  action,
  children,
}: {
  title: string;
  icon: React.ElementType;
  accent: AccentColor;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  const colors = TILE_COLORS[accent];
  return (
    <div className="relative overflow-hidden rounded-2xl border bg-gradient-to-br from-card via-card to-card/80">
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute -right-12 -top-12 size-32 rounded-full blur-2xl opacity-40",
          colors.bg,
        )}
      />
      <div className="relative p-5">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <div
              className={cn(
                "flex size-7 items-center justify-center rounded-lg",
                colors.bg,
              )}
            >
              <Icon className={cn("size-3.5", colors.icon)} />
            </div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {title}
            </h3>
          </div>
          {action}
        </div>
        {children}
      </div>
    </div>
  );
}

export function PanelRow({
  label,
  value,
  valueClassName,
}: {
  label: string;
  value: React.ReactNode;
  valueClassName?: string;
}) {
  return (
    <div className="flex items-center justify-between py-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("font-medium tabular-nums", valueClassName)}>
        {value}
      </span>
    </div>
  );
}
