import * as React from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { pressable } from "@/components/ux/motion";
import { SparkleField } from "@/components/decor";

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
        "surface-sheen surface-raise relative overflow-hidden rounded-2xl border bg-gradient-to-br from-card via-card to-card/50 sm:rounded-3xl",
        className,
      )}
    >
      {/* Corner glows — slightly richer than before (0.06 → 0.10) and a
          third subtle cyan wash at top-center for depth. Still soft and
          low-opacity so the hero reads premium, not gaudy. Purely
          decorative, so each glow hides under `prefers-reduced-motion`
          via `motion-reduce:opacity-0` / `motion-safe:opacity-100`. The
          base opacity stays at 100% for reduced-motion-unaware browsers
          and is explicitly held to 100% under `motion-safe` so the
          intent is symmetric and obvious in the markup. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -right-24 -top-24 size-56 rounded-full bg-blue-500/[0.10] blur-3xl motion-reduce:opacity-0 motion-safe:opacity-100 sm:size-80"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -left-24 -bottom-24 size-56 rounded-full bg-purple-500/[0.09] blur-3xl motion-reduce:opacity-0 motion-safe:opacity-100 sm:size-80"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 -top-32 size-64 -translate-x-1/2 rounded-full bg-cyan-500/[0.04] blur-3xl motion-reduce:opacity-0 motion-safe:opacity-100"
      />
      {/* Sparkle texture — the owner-supplied 4-point-star ornament,
          tucked into the top-right corner and fading out radially. Warm
          champagne at a whisper on dark; a faint primary tint on light.
          Pattern-based single <svg>, aria-hidden, pointer-events-none —
          pure texture, never behind dense data. */}
      <SparkleField className="inset-y-0 right-0 w-72 text-primary/[0.05] sm:w-96 dark:text-amber-100/[0.09]" />
      {/* Hairline top highlight — a crisp light catch along the very top
          edge that makes the panel feel lifted on the dark theme. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/15 to-transparent"
      />
      <div className="relative p-5 sm:p-6">{children}</div>
    </div>
  );
}

// ─── PageHeroIdentity ─────────────────────────────────────────────
// Optional helper that captures the dominant page-hero pattern across
// the codebase: icon-chip + title + subtitle, with a flex slot that
// stacks under the identity block on phones (instead of fighting it
// for horizontal space). Existing pages composing PageHero by hand
// keep working — this is purely opt-in.
//
// Optional, additive props (all default to the original behaviour when
// omitted, so existing call sites render identically):
//   - accent      — tints the icon chip with a TILE_COLORS token
//                   (rose / pink / amber / emerald / cyan / …). When
//                   omitted the chip stays on the neutral `primary`
//                   tint, exactly as before.
//   - backHref    — renders the standard leading ArrowLeft link (the
//                   detail-page "back to list" affordance). Markup
//                   matches the hand-rolled `<Link>` blocks it replaces.
//   - back        — escape hatch for a custom leading node (e.g. the
//                   <BackButton> client component that calls
//                   router.back()). Takes precedence over backHref.
//   - badges      — inline nodes rendered after the title (status /
//                   type badges on detail pages).
//   - titleClassName / subtitleClassName — extra classes appended to
//                   the title / subtitle (e.g. `font-mono` for code
//                   and id headers).

export function PageHeroIdentity({
  icon: Icon,
  title,
  subtitle,
  action,
  accent,
  backHref,
  back,
  badges,
  titleClassName,
  subtitleClassName,
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
  const colors = accent ? TILE_COLORS[accent] : null;
  // Leading back affordance: an explicit node wins, otherwise a
  // backHref renders the standard ArrowLeft link used across detail
  // pages. Nothing renders when neither is supplied.
  const backNode = back ?? (
    backHref ? (
      <Link
        href={backHref}
        aria-label="Back to previous list"
        className="inline-flex size-9 shrink-0 items-center justify-center rounded-md hover:bg-accent hover:text-accent-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden />
      </Link>
    ) : null
  );
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <div className="flex min-w-0 items-center gap-3">
        {backNode}
        <div
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-xl border shadow-sm ring-1 ring-inset ring-white/10 sm:size-10",
            colors ? colors.bg : "border-primary/20 bg-primary/10",
          )}
        >
          <Icon
            className={cn(
              "size-[18px] sm:size-5",
              colors ? colors.icon : "text-primary",
            )}
          />
        </div>
        <div className="min-w-0">
          {/* Wrap title + badges in a flex row only when badges are
              present; without them the h1 stays a plain block child so
              existing call sites render byte-for-byte the same. */}
          {badges ? (
            <div className="flex flex-wrap items-center gap-2">
              <h1
                className={cn(
                  "text-lg font-bold leading-tight tracking-tight sm:text-xl md:text-2xl",
                  titleClassName,
                )}
              >
                {title}
              </h1>
              {badges}
            </div>
          ) : (
            <h1
              className={cn(
                "text-lg font-bold leading-tight tracking-tight sm:text-xl md:text-2xl",
                titleClassName,
              )}
            >
              {title}
            </h1>
          )}
          {subtitle && (
            <p
              className={cn(
                "text-xs text-muted-foreground sm:text-sm",
                subtitleClassName,
              )}
            >
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
  title: React.ReactNode;
  action?: React.ReactNode;
}) {
  // Stack title + action vertically on phones — long action clusters
  // (filter chips, buttons, dropdowns) routinely push the title off-
  // screen at 360px. At sm+ the original side-by-side layout returns.
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="flex min-w-0 items-center gap-2.5">
        {/* Refined icon chip — gradient wash + slightly brighter inner
            hairline so the chip reads as a tiny glass tile in both themes. */}
        <div className="shrink-0 rounded-lg border border-primary/20 bg-gradient-to-br from-primary/15 to-primary/5 p-1.5 shadow-sm ring-1 ring-inset ring-white/10">
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
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn(
        "hover-raise group surface-sheen relative overflow-hidden rounded-xl border px-3 py-2.5 sm:px-4 sm:py-3",
        colors.bg,
        interactive && cn(pressable("scale"), "active:brightness-95"),
      )}
    >
      {/* Left accent bar — inherits the accent hue via text-color +
          bg-current. Brightens on hover (decorative — only animates
          under `motion-safe`, snaps under reduced motion). House-POV
          safe: the accent is chosen by the caller, same as the value tint. */}
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-y-0 left-0 w-0.5 bg-current opacity-50 motion-safe:transition-opacity motion-safe:duration-200 motion-safe:group-hover:opacity-80",
          colors.icon,
        )}
      />
      {/* Faint diagonal sheen for a glassy finish — neutral white so it
          never fights the House-POV accent. Decorative-only, so the
          gradient suppresses itself under `prefers-reduced-motion`. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-gradient-to-br from-white/[0.04] to-transparent motion-reduce:opacity-0 motion-safe:opacity-100"
      />
      <div className="relative flex items-start justify-between gap-2">
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
          "relative mt-1.5 truncate text-xl font-bold leading-tight tracking-tight tabular-nums sm:text-2xl",
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
        <p className="relative mt-1 truncate text-xs text-muted-foreground">
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
  return (
    <div
      className={cn(
        "hover-raise group surface-sheen relative overflow-hidden rounded-xl border p-3 sm:p-4",
        colors.bg,
        interactive && cn(pressable("scale"), "active:brightness-95"),
      )}
    >
      {/* Left accent bar + glassy sheen — matches KpiTile so a grid of
          mixed tiles reads as one family. House-POV safe (neutral sheen,
          caller-chosen accent). Hover lift + sheen are decorative so they
          only animate under `motion-safe`. */}
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-y-0 left-0 w-0.5 bg-current opacity-50 motion-safe:transition-opacity motion-safe:duration-200 motion-safe:group-hover:opacity-80",
          colors.icon,
        )}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-gradient-to-br from-white/[0.04] to-transparent motion-reduce:opacity-0 motion-safe:opacity-100"
      />
      <div className="relative flex items-center gap-1.5 sm:gap-2">
        <Icon className={cn("size-3.5 shrink-0 sm:size-4", colors.icon)} />
        {/* micro-caps eyebrow — matches KpiTile so mixed grids read as one family */}
        <span className="truncate text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          {label}
        </span>
      </div>
      <p
        className={cn(
          "relative mt-1.5 truncate text-2xl font-bold tracking-tight tabular-nums sm:text-3xl",
          colors.text,
        )}
      >
        {value}
      </p>
      {sub && (
        // Same readability bump as KpiTile — 11px → 12px (text-xs)
        // and a hair more space above so the sub line clears the
        // value baseline.
        <p className="relative mt-1 truncate text-xs text-muted-foreground">
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
  title: React.ReactNode;
  icon: React.ElementType;
  accent: AccentColor;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  const colors = TILE_COLORS[accent];
  return (
    <div className="surface-sheen surface-raise group relative overflow-hidden rounded-xl border bg-gradient-to-br from-card via-card to-card/70 sm:rounded-2xl">
      {/* Accent corner glow — a touch stronger (40% → 50%) and a hair
          larger so the panel feels alive. Still soft/low-opacity. The
          hover-driven opacity bump is decorative so it only animates
          under `motion-safe` (reduced-motion holds the base 50%). */}
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute -right-12 -top-12 size-28 rounded-full opacity-50 blur-2xl motion-safe:transition-opacity motion-safe:duration-200 motion-safe:group-hover:opacity-70 sm:size-36",
          colors.bg,
        )}
      />
      {/* Hairline top highlight for a crisp lifted edge on dark. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent"
      />
      <div className="relative p-4 sm:p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <div
              className={cn(
                "flex size-7 shrink-0 items-center justify-center rounded-lg border shadow-sm ring-1 ring-inset ring-white/10",
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
