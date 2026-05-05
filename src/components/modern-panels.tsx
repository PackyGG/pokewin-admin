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
 *
 * Mobile-first responsive notes:
 *   - Padding scales from p-4 (16px) on phones to p-6 (24px) on tablets+.
 *     Less inner padding lets the hero breathe on narrow viewports
 *     instead of swallowing half the screen with chrome.
 *   - Corner glows shrink to size-48 (12rem) on phones — at 24rem the
 *     blur covers the entire hero on a 360px screen and bleeds the
 *     accent into surrounding content. Sized up to 18rem at sm and the
 *     original 18rem stays at md+.
 *   - Border-radius narrows on phones (rounded-xl → rounded-2xl) so the
 *     hero hugs the screen edges instead of leaving large empty corners.
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
        "relative overflow-hidden rounded-xl border bg-gradient-to-br from-card via-card to-card/60 sm:rounded-2xl",
        className,
      )}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute -right-24 -top-24 size-48 rounded-full bg-blue-500/[0.06] blur-3xl sm:size-72"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -left-24 -bottom-24 size-48 rounded-full bg-purple-500/[0.06] blur-3xl sm:size-72"
      />
      <div className="relative p-4 sm:p-5 md:p-6">{children}</div>
    </div>
  );
}

// ─── PageHeroIdentity ─────────────────────────────────────────────
// Optional helper that captures the dominant page-hero pattern across
// the codebase: icon-chip + title + subtitle, with a flex slot that
// stacks under the identity block on phones (instead of fighting it
// for horizontal space). Existing pages composing PageHero by hand
// keep working — this is purely opt-in.

export function PageHeroIdentity({
  icon: Icon,
  title,
  subtitle,
  action,
}: {
  icon: React.ElementType;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 sm:size-10">
          <Icon className="size-4 text-primary sm:size-5" />
        </div>
        <div className="min-w-0">
          <h1 className="text-xl font-bold leading-tight sm:text-2xl md:text-3xl">
            {title}
          </h1>
          {subtitle && (
            <p className="text-xs text-muted-foreground sm:text-sm">
              {subtitle}
            </p>
          )}
        </div>
      </div>
      {action && (
        <div className="flex shrink-0 items-center gap-2 sm:self-center">
          {action}
        </div>
      )}
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
  // Stack title + action vertically on phones — long action clusters
  // (filter chips, buttons, dropdowns) routinely push the title off-
  // screen at 360px. At sm+ the original side-by-side layout returns.
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-center gap-2">
        <div className="shrink-0 rounded-md bg-primary/10 p-1.5">
          <Icon className="size-4 text-primary" />
        </div>
        <h3 className="truncate text-sm font-semibold sm:text-base">{title}</h3>
      </div>
      {action && (
        <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap sm:shrink-0">
          {action}
        </div>
      )}
    </div>
  );
}

// ─── KpiTile ──────────────────────────────────────────────────────

/**
 * Compact stat tile used in hero KPI strips (6+ per row).
 *
 * Mobile-first sizing:
 *   - The old `min-w-[160px]` blew up grids on 360px viewports
 *     (forcing horizontal scroll); removed in favour of letting the
 *     parent grid drive width. Two tiles fit comfortably side-by-side
 *     on a phone with this change.
 *   - Padding shrinks on phones so 2 columns of tiles don't overflow.
 *   - Value typography drops a step on mobile to prevent clipping of
 *     long numbers like $12,345,678.
 */
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
        "group relative overflow-hidden rounded-xl border px-3 py-2.5 transition-all hover:shadow-md sm:px-4 sm:py-3",
        colors.bg,
      )}
    >
      <div className="flex items-center gap-1.5 sm:gap-2">
        <Icon className={cn("size-3.5 shrink-0 sm:size-4", colors.icon)} />
        <span className="truncate text-[10px] font-semibold uppercase tracking-wider text-muted-foreground sm:text-[11px]">
          {label}
        </span>
      </div>
      <p
        className={cn(
          "mt-1 truncate text-lg font-bold leading-tight tabular-nums sm:text-xl",
          colors.text,
        )}
      >
        {value}
      </p>
      {sub && (
        <p className="mt-0.5 truncate text-[10px] text-muted-foreground sm:text-[11px]">
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
    <div className={cn("rounded-xl border p-3 sm:p-4", colors.bg)}>
      <div className="flex items-center gap-1.5 sm:gap-2">
        <Icon className={cn("size-3.5 shrink-0 sm:size-4", colors.icon)} />
        <span className="truncate text-[10px] font-semibold uppercase tracking-wider text-muted-foreground sm:text-[11px]">
          {label}
        </span>
      </div>
      <p
        className={cn(
          "mt-1 truncate text-xl font-bold tabular-nums sm:text-2xl",
          colors.text,
        )}
      >
        {value}
      </p>
      {sub && (
        <p className="mt-0.5 truncate text-[10px] text-muted-foreground sm:text-[11px]">
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
 *
 * Mobile-first notes: padding scales (p-4 → p-5), corner radius softens
 * to rounded-xl on phones, and the title row wraps so an action cluster
 * never pushes the title off-screen.
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
    <div className="relative overflow-hidden rounded-xl border bg-gradient-to-br from-card via-card to-card/80 sm:rounded-2xl">
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute -right-12 -top-12 size-24 rounded-full blur-2xl opacity-40 sm:size-32",
          colors.bg,
        )}
      />
      <div className="relative p-4 sm:p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <div
              className={cn(
                "flex size-7 shrink-0 items-center justify-center rounded-lg",
                colors.bg,
              )}
            >
              <Icon className={cn("size-3.5", colors.icon)} />
            </div>
            <h3 className="truncate text-xs font-semibold uppercase tracking-wider text-muted-foreground">
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
  // gap-3 + min-w-0 on the label keep long labels from pushing the value
  // out of the row; the value stays tight to the right edge.
  return (
    <div className="flex items-center justify-between gap-3 py-1 text-sm">
      <span className="min-w-0 truncate text-muted-foreground">{label}</span>
      <span
        className={cn(
          "shrink-0 font-medium tabular-nums",
          valueClassName,
        )}
      >
        {value}
      </span>
    </div>
  );
}
