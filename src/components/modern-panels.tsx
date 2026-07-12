import * as React from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { pressable } from "@/components/ux/motion";

/**
 * Shared modern UI primitives. Extracted so every admin page can apply
 * the same hero + tile aesthetic introduced on the user detail modern
 * view.
 *
 * Primitives:
 *   - TILE_COLORS         — accent color tokens (blue / emerald / rose / …)
 *   - PageHero            — de-boxed page-top slot (renders its children in a
 *                           plain container; the old gradient/glow title box
 *                           was dropped per owner direction)
 *   - PageHeroIdentity    — controls-only page-top row (back on the left,
 *                           action on the right); the generic icon-chip +
 *                           title + subtitle block it used to render was
 *                           removed as useless chrome
 *   - SectionHeading      — icon chip + title, used to open a section
 *   - KpiTile             — compact flat stat tile; accent tints icon + value only
 *   - StatPanel           — larger flat stat card (solid bg-card + soft shadow)
 *   - MetricTile          — medium tile used in-tab (between KpiTile and StatPanel)
 *
 * Flat direction (matches the users/[id] pilot): the tiles + panels render
 * on a solid `bg-card` surface with a hairline border. The per-hue colored
 * FILL, the diagonal white sheen, and the blurred corner-glow blobs were the
 * layered noise that read as "not clean" — dropped. TILE_COLORS now drives
 * ONLY the icon + the value number (and the small StatPanel icon chip), never
 * the tile background. PageHero itself was later de-boxed too: the owner found
 * the generic page-title header box (gradient + corner glows + sparkle) to be
 * useless chrome, so PageHero now renders its children in a plain container and
 * PageHeroIdentity renders only the page controls (back + action).
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
 * De-boxed page-top slot.
 *
 * Historically this was a rounded gradient container with blurred corner
 * glows + a sparkle texture — the "hero box" at the top of every admin page.
 * The owner found that generic title box to be useless chrome, so the whole
 * decorative treatment (gradient, three `blur-3xl` glows, `SparkleField`,
 * `surface-sheen`/`surface-raise`, border, `rounded-2xl/3xl`, the heavy
 * `p-5 sm:p-6` padding, and the top hairline highlight) was dropped.
 *
 * PageHero now renders its children in a plain container with no visual
 * chrome. Vertical separation from the section below is owned by the parent
 * page's `space-y-*` stack (every call site wraps the page in one), exactly
 * as before — the old box carried no margin of its own either. The
 * `className` passthrough is preserved so a caller can still tweak the slot.
 *
 * Paired with `PageHeroIdentity` (below), which now renders only the page
 * controls (back + action) instead of the icon-chip + title + subtitle block.
 */
export function PageHero({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={cn(className)}>{children}</div>;
}

// ─── PageHeroIdentity ─────────────────────────────────────────────
// Controls-only page-top row.
//
// This used to render the dominant page-hero pattern (icon-chip + title +
// subtitle + optional status badges). The owner found that generic title
// block to be useless chrome, so it was removed. PageHeroIdentity now renders
// ONLY the page controls, in a slim horizontal row:
//   • the leading back affordance (`back` / `backHref`) on the LEFT, and
//   • the `action` slot (page buttons / filters / period selectors) on the
//     RIGHT.
//
// The full prop signature is intentionally kept intact. Every existing call
// site still passes `icon` / `title` / `subtitle` / `accent` / `badges` /
// `titleClassName` / `subtitleClassName`; those props are still ACCEPTED (so
// all call sites compile unchanged) but are no longer rendered. Only `action`,
// `backHref`, and `back` drive output.
//
// When a call site passes NEITHER a back affordance NOR an action, there is
// nothing to show and the component renders `null` (no empty chrome).

export function PageHeroIdentity({
  action,
  backHref,
  back,
}: {
  icon: React.ElementType;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  action?: React.ReactNode;
  accent?: AccentColor;
  backHref?: string;
  back?: React.ReactNode;
  badges?: React.ReactNode;
  titleClassName?: string;
  subtitleClassName?: string;
}) {
  // Leading back affordance: an explicit node wins, otherwise a backHref
  // renders the standard ArrowLeft link used across detail pages. Nothing
  // renders when neither is supplied.
  const backNode =
    back ??
    (backHref ? (
      <Link
        href={backHref}
        aria-label="Back to previous list"
        className="inline-flex size-9 shrink-0 items-center justify-center rounded-md hover:bg-accent hover:text-accent-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden />
      </Link>
    ) : null);

  // No back + no action → render nothing. The de-boxed hero has no title to
  // stand in for, so an empty row would just be dead space at the page top.
  if (!backNode && !action) return null;

  return (
    // Slim, compact controls row. Wraps on very narrow viewports so a wide
    // action cluster can drop below the back button instead of overflowing.
    // `mb-4 sm:mb-6` gives the content below breathing room (and collapses
    // harmlessly into the page's own `space-y-*` stack where one is used).
    <div className="mb-4 flex flex-wrap items-center justify-between gap-2 sm:mb-6 sm:gap-3">
      {/* Back on the left (own min-w-0 cell, so it anchors the row even when
          empty — keeps a lone action pinned to the right via justify-between). */}
      <div className="flex min-w-0 items-center gap-2">{backNode}</div>
      {/* Action on the right (page buttons / filters / period selectors). */}
      {action && (
        <div className="flex flex-wrap items-center justify-end gap-2">
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
  title: React.ReactNode;
  action?: React.ReactNode;
}) {
  // Stack title + action vertically on phones — long action clusters
  // (filter chips, buttons, dropdowns) routinely push the title off-
  // screen at 360px. At sm+ the original side-by-side layout returns.
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="flex min-w-0 items-center gap-2.5">
        {/* Flat icon chip — one solid `bg-primary/10` fill, no gradient /
            border / ring / shadow (matches the flat pilot's SectionHeading
            chip). The accent lives on the icon glyph only. */}
        <div className="shrink-0 rounded-lg bg-primary/10 p-1.5">
          <Icon className="size-4 text-primary" />
        </div>
        {/* Rendered as <h2> so the page ladder is h1 (PageHero) → h2
            (SectionHeading) → intra-panel divs. Visual styling unchanged. */}
        <h2 className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm font-semibold tracking-tight sm:text-base">
          {title}
        </h2>
      </div>
      {/* Hairline divider fills the gap between title and action on wide
          rows — gives the heading more structure without extra chrome.
          Hidden on phones (stacked layout) and when there's no action. */}
      {action && (
        <div
          aria-hidden
          className="hidden h-px flex-1 bg-gradient-to-r from-border/60 to-transparent sm:block"
        />
      )}
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
  action,
  interactive = false,
}: {
  label: string;
  value: string;
  sub?: string;
  icon: React.ElementType;
  accent?: AccentColor;
  /**
   * Optional slot rendered in the top-right corner of the tile. Used
   * for drill-in popover triggers (e.g. the Global PnL tile on
   * /creators surfaces a per-creator breakdown popover here).
   */
  action?: React.ReactNode;
  /**
   * Opt-in press feedback for tiles that are themselves clickable
   * (wrapped in a <Link> / <button> or rendered inside a clickable
   * parent). Adds a subtle `active:` press (scale + slightly deeper
   * accent tint) so a tap reads as physical. Defaults to `false` so the
   * house rule "data/KPI tiles stay COMPLETELY static on hover" is
   * preserved for the common non-interactive case — nothing changes
   * unless a caller opts in. Reduced-motion safe (the scale is
   * `motion-safe:`-gated via `pressable`; the tint is color-only).
   */
  interactive?: boolean;
}) {
  const colors = TILE_COLORS[accent];
  // Spoken label = "<label>: <value>" (with the optional sub appended)
  // so a screen reader announces the tile contents in one breath
  // instead of just the uppercase chip text. Visual layout unchanged.
  const ariaLabel = sub ? `${label}: ${value}, ${sub}` : `${label}: ${value}`;
  // Flat tile: one solid `bg-card` surface + a hairline border, uniform
  // `rounded-lg`, completely static. The per-hue colored FILL (`colors.bg`),
  // the diagonal white sheen overlay, and the left accent bar were the
  // layered noise the flat pilot removes — dropped. The accent now survives
  // only on the icon + the value number (House-POV tint where money). The
  // `interactive` opt-in still adds a subtle press (scale + active brightness)
  // for tiles wrapped in a Link/button — that's a tap affordance, not a hover
  // sheen, so it's preserved. Reduced-motion safe (scale is `motion-safe`).
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn(
        "rounded-lg border bg-card px-3 py-2.5 sm:px-4 sm:py-3",
        interactive && cn(pressable("scale"), "active:brightness-95"),
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5 sm:gap-2">
          <Icon className={cn("size-3.5 shrink-0 sm:size-4", colors.icon)} />
          {/* micro-caps eyebrow — the canonical 11px/0.14em label rhythm */}
          <span className="truncate text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            {label}
          </span>
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      <p
        className={cn(
          "mt-1.5 truncate text-xl font-bold leading-tight tracking-tight tabular-nums sm:text-2xl",
          colors.text,
        )}
      >
        {value}
      </p>
      {sub && (
        // Bumped 11px → 12px (text-xs) so the sub line is readable
        // without leaning in, and given a hair more breathing room
        // (mt-0.5 → mt-1) so it stops touching the value's baseline.
        // Still secondary (muted-foreground) so the hierarchy stays
        // value > label > sub.
        <p className="mt-1 truncate text-xs text-muted-foreground">
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
  interactive = false,
}: {
  label: string;
  value: string;
  sub?: string;
  icon: React.ElementType;
  accent?: AccentColor;
  /**
   * Opt-in press feedback for clickable tiles — see `KpiTile`'s
   * `interactive` prop. Defaults to `false` so non-interactive metric
   * tiles stay completely static.
   */
  interactive?: boolean;
}) {
  const colors = TILE_COLORS[accent];
  // Flat tile — matches KpiTile so a grid of mixed tiles reads as one family:
  // solid `bg-card` surface + hairline border, uniform `rounded-lg`, static.
  // The colored FILL, the left accent bar, and the diagonal sheen are gone;
  // the accent survives on the icon + value number only. `interactive` keeps
  // its opt-in press affordance (scale + active brightness), reduced-motion safe.
  return (
    <div
      className={cn(
        "rounded-lg border bg-card p-3 sm:p-4",
        interactive && cn(pressable("scale"), "active:brightness-95"),
      )}
    >
      <div className="flex items-center gap-1.5 sm:gap-2">
        <Icon className={cn("size-3.5 shrink-0 sm:size-4", colors.icon)} />
        {/* micro-caps eyebrow — matches KpiTile so mixed grids read as one family */}
        <span className="truncate text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          {label}
        </span>
      </div>
      <p
        className={cn(
          "mt-1.5 truncate text-2xl font-bold tracking-tight tabular-nums sm:text-3xl",
          colors.text,
        )}
      >
        {value}
      </p>
      {sub && (
        // Same readability bump as KpiTile — 11px → 12px (text-xs)
        // and a hair more space above so the sub line clears the
        // value baseline.
        <p className="mt-1 truncate text-xs text-muted-foreground">
          {sub}
        </p>
      )}
    </div>
  );
}

// ─── StatPanel ────────────────────────────────────────────────────

/**
 * Full stat card with a hero number + room for breakdown rows. Pair with
 * <PanelRow>.
 *
 * Flat surface (matches the users/[id] pilot): one solid `bg-card` + a
 * hairline border + a single soft `shadow-sm`. The `bg-gradient-to-br`
 * fill, the blurred colored corner-glow blob, and the hairline top-edge
 * highlight were the layered depth noise the flat direction removes — the
 * accent now lives ONLY on the small icon chip (`colors.bg`) + the hero
 * value inside `children` (House-POV tinted by the caller).
 *
 * Mobile-first notes: padding scales (p-4 → p-5) and the title row wraps
 * so an action cluster never pushes the title off-screen.
 */
export function StatPanel({
  title,
  icon: Icon,
  accent,
  action,
  children,
}: {
  title: React.ReactNode;
  icon: React.ElementType;
  accent: AccentColor;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  const colors = TILE_COLORS[accent];
  return (
    <div className="rounded-xl border bg-card p-4 shadow-sm sm:p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {/* Flat icon chip — one solid tinted fill (`colors.bg`), no
              border / ring / shadow. This is the only place the accent
              touches a surface; the panel body itself stays neutral. */}
          <div
            className={cn(
              "flex size-7 shrink-0 items-center justify-center rounded-lg",
              colors.bg,
            )}
          >
            <Icon className={cn("size-3.5", colors.icon)} />
          </div>
          {/* Intentionally a <div>, not a heading: a StatPanel lives
              inside a section already opened by a SectionHeading (h2),
              so this small uppercase label is intra-panel chrome — not
              another level in the document outline. Visual styling
              unchanged. */}
          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            {title}
          </div>
        </div>
        {action}
      </div>
      {children}
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
