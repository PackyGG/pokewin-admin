import * as React from "react";
import type { LucideIcon } from "lucide-react";

import { PageHero, SectionHeading } from "@/components/modern-panels";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * Shared building blocks for the Antifraud operator guide.
 *
 * WHY: every guide page used to hand-roll its own section/card markup with
 * inline per-hue background classes — tinted section headers and whole-card
 * hue fills. That both drifted page-to-page and violated the app-wide flat
 * direction documented in `modern-panels.tsx` — tiles render on a solid
 * `bg-card` surface with a hairline border, and the accent hue lives on the
 * ICON and the NUMBER only, never on the surface.
 *
 * These primitives are the single place that styling now lives, so all six
 * guide pages are literally the same component tree with different data.
 *
 * Server-only by design (no "use client"): the guide is static prose, so
 * every page stays a Server Component and `LucideIcon` refs can be passed as
 * props freely — that is a server→server boundary, not the server→client
 * function-prop crash Next 15 raises.
 */

// ─── Accent ───────────────────────────────────────────────────────
// Deliberately a subset of `AccentColor` from modern-panels: the guide only
// ever needs "neutral / informational / caution / stop / good". Each entry is
// the ICON + NUMBER color pairing (`-600` light, `-400` dark) required by the
// house dark-mode rule; there is no `bg` member because guide surfaces never
// take a hue fill.
const GUIDE_ACCENTS = {
  cyan: "text-cyan-600 dark:text-cyan-400",
  blue: "text-blue-600 dark:text-blue-400",
  emerald: "text-emerald-600 dark:text-emerald-400",
  amber: "text-amber-600 dark:text-amber-400",
  orange: "text-orange-600 dark:text-orange-400",
  rose: "text-rose-600 dark:text-rose-400",
  purple: "text-purple-600 dark:text-purple-400",
  slate: "text-slate-600 dark:text-slate-400",
  muted: "text-muted-foreground",
} as const;

export type GuideAccent = keyof typeof GUIDE_ACCENTS;

function guideAccentClass(accent: GuideAccent = "muted"): string {
  return GUIDE_ACCENTS[accent];
}

// ─── GuidePage ────────────────────────────────────────────────────

/**
 * Page frame: `PageHero` first (house rule), the page's own visible title
 * inside it, then the content stack at the house-majority `space-y-4`.
 */
export function GuidePage({
  eyebrow,
  title,
  intro,
  children,
}: {
  eyebrow: string;
  title: string;
  intro: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-4">
      <PageHero>
        <div className="max-w-3xl">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            {eyebrow}
          </p>
          <h1 className="mt-1.5 text-2xl font-semibold tracking-tight">
            {title}
          </h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            {intro}
          </p>
        </div>
      </PageHero>
      {children}
    </div>
  );
}

// ─── GuideSection ─────────────────────────────────────────────────

/** Flat panel: hairline border, solid card surface, no hue fill, no glow. */
export function GuideSection({
  icon,
  title,
  description,
  children,
}: {
  icon: LucideIcon;
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border/60 bg-card p-4 sm:p-5">
      <SectionHeading icon={icon} title={title} />
      {description && (
        <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
          {description}
        </p>
      )}
      <div className="mt-4 space-y-3">{children}</div>
    </section>
  );
}

/** Sub-heading inside a section, for pages that need one more level. */
export function GuideSubHeading({
  title,
  hint,
}: {
  title: string;
  hint?: React.ReactNode;
}) {
  return (
    <div className="pt-1">
      <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
      {hint && (
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}

// ─── GuideSteps ───────────────────────────────────────────────────

export type GuideStep = {
  title: string;
  detail: React.ReactNode;
};

/**
 * Ordered stages. Rendered as a real `<ol>` with a hairline rail so the order
 * survives screen readers and narrow viewports (the old arrow-between-cards
 * grid lost its ordering entirely below `md`).
 */
export function GuideSteps({
  steps,
  accent = "cyan",
}: {
  steps: readonly GuideStep[];
  accent?: GuideAccent;
}) {
  return (
    <ol className="relative space-y-3 border-l border-border/60 pl-5">
      {steps.map((step, index) => (
        <li key={step.title} className="relative">
          <span
            aria-hidden
            className={cn(
              "absolute -left-[27px] flex size-5 items-center justify-center rounded-full border border-border/60 bg-card text-[10px] font-bold tabular-nums",
              guideAccentClass(accent),
            )}
          >
            {index + 1}
          </span>
          <p className="text-sm font-semibold leading-5">{step.title}</p>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            {step.detail}
          </p>
        </li>
      ))}
    </ol>
  );
}

// ─── GuideTable ───────────────────────────────────────────────────

export type GuideTableRow = {
  key: string;
  cells: readonly React.ReactNode[];
};

/**
 * Compact reference table. Wide content scrolls inside its own container so
 * the page body never scrolls sideways on a phone.
 */
export function GuideTable({
  columns,
  rows,
  caption,
}: {
  columns: readonly string[];
  rows: readonly GuideTableRow[];
  caption?: React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-border/60">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] border-collapse text-left text-sm">
          {caption && (
            <caption className="border-b border-border/60 bg-muted/20 px-3 py-2 text-left text-xs text-muted-foreground">
              {caption}
            </caption>
          )}
          <thead>
            <tr className="border-b border-border/60 bg-muted/20">
              {columns.map((column) => (
                <th
                  key={column}
                  scope="col"
                  className="px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground"
                >
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.key}
                className="border-b border-border/40 last:border-b-0"
              >
                {row.cells.map((cell, i) => (
                  <td
                    key={i}
                    className={cn(
                      "px-3 py-2.5 align-top text-sm leading-6",
                      i === 0
                        ? "font-medium text-foreground"
                        : "text-muted-foreground",
                    )}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── GuideCallout ─────────────────────────────────────────────────

const CALLOUT_TONES: Record<
  "note" | "warning" | "danger",
  { accent: GuideAccent; label: string }
> = {
  note: { accent: "blue", label: "Note" },
  warning: { accent: "amber", label: "Careful" },
  danger: { accent: "rose", label: "Irreversible" },
};

/**
 * Flat callout. The tone is carried by the icon glyph and the label only —
 * the surface stays `bg-card`, matching every other tile in the app.
 */
export function GuideCallout({
  tone = "note",
  icon: Icon,
  title,
  children,
}: {
  tone?: "note" | "warning" | "danger";
  icon: LucideIcon;
  title?: string;
  children: React.ReactNode;
}) {
  const { accent, label } = CALLOUT_TONES[tone];
  return (
    <div className="flex gap-3 rounded-lg border border-border/60 bg-card p-3.5">
      <Icon
        className={cn("mt-0.5 size-4 shrink-0", guideAccentClass(accent))}
        aria-hidden
      />
      <div className="min-w-0">
        <p
          className={cn(
            "text-[11px] font-semibold uppercase tracking-[0.14em]",
            guideAccentClass(accent),
          )}
        >
          {title ?? label}
        </p>
        <div className="mt-1 text-sm leading-6 text-muted-foreground">
          {children}
        </div>
      </div>
    </div>
  );
}

// ─── GuideDefList ─────────────────────────────────────────────────

export type GuideDefItem = {
  term: React.ReactNode;
  detail: React.ReactNode;
};

/** Term → meaning pairs. Stacks on phones, two columns from `sm`. */
export function GuideDefList({ items }: { items: readonly GuideDefItem[] }) {
  return (
    <dl className="grid gap-2 sm:grid-cols-2">
      {items.map((item, i) => (
        <div
          key={i}
          className="rounded-lg border border-border/60 bg-card p-3"
        >
          <dt className="text-sm font-semibold leading-5">{item.term}</dt>
          <dd className="mt-1 text-sm leading-6 text-muted-foreground">
            {item.detail}
          </dd>
        </div>
      ))}
    </dl>
  );
}

// ─── GuideFacts ───────────────────────────────────────────────────

export type GuideFact = {
  icon: LucideIcon;
  label: string;
  value: string;
  detail: React.ReactNode;
  accent?: GuideAccent;
};

/**
 * Small fact tiles. Flat neutral surface; the accent tints the icon and the
 * value only — the same contract `KpiTile` follows.
 */
export function GuideFacts({ facts }: { facts: readonly GuideFact[] }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
      {facts.map((fact) => {
        const Icon = fact.icon;
        const accent = guideAccentClass(fact.accent ?? "cyan");
        return (
          <div
            key={fact.label}
            className="rounded-lg border border-border/60 bg-card p-3"
          >
            <div className="flex items-center gap-2">
              <Icon className={cn("size-4 shrink-0", accent)} aria-hidden />
              <span className="text-xs font-medium text-muted-foreground">
                {fact.label}
              </span>
            </div>
            <p
              className={cn(
                "mt-2 text-base font-semibold tabular-nums",
                accent,
              )}
            >
              {fact.value}
            </p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {fact.detail}
            </p>
          </div>
        );
      })}
    </div>
  );
}

// ─── GuideBullets ─────────────────────────────────────────────────

/** Plain checklist. Used where a table would be overkill. */
export function GuideBullets({
  items,
  accent = "muted",
}: {
  items: readonly React.ReactNode[];
  accent?: GuideAccent;
}) {
  return (
    <ul className="space-y-1.5">
      {items.map((item, i) => (
        <li key={i} className="flex gap-2.5 text-sm leading-6">
          <span
            aria-hidden
            className={cn(
              "mt-[9px] size-1.5 shrink-0 rounded-full bg-current",
              guideAccentClass(accent),
            )}
          />
          <span className="min-w-0 text-muted-foreground">{item}</span>
        </li>
      ))}
    </ul>
  );
}

// ─── GuideBadge ───────────────────────────────────────────────────

/**
 * Inline literal — a UI label, status key, button name or threshold quoted
 * from the product. Keeps operator-facing strings visually distinct from the
 * surrounding prose.
 */
export function GuideBadge({
  children,
  accent = "slate",
}: {
  children: React.ReactNode;
  accent?: GuideAccent;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border border-border/60 bg-muted/30 px-1.5 py-0.5 text-[11px] font-semibold",
        guideAccentClass(accent),
      )}
    >
      {children}
    </span>
  );
}

// ─── GuideLoading ─────────────────────────────────────────────────

/**
 * Shared `loading.tsx` body for every guide route.
 *
 * WHY: without a route-local `loading.tsx` the guide inherits the Antifraud
 * DASHBOARD skeleton (queue tiles + six KPI cards + two 30-day charts), so a
 * prose page flashes a chart grid before it renders. This mirrors the real
 * guide shape instead: title block, then stacked prose panels.
 */
export function GuideLoading({ panels = 4 }: { panels?: number }) {
  return (
    <div className="space-y-4">
      <div className="max-w-3xl space-y-2">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-7 w-72 max-w-full" />
        <Skeleton className="h-4 w-full" />
      </div>
      {Array.from({ length: panels }).map((_, i) => (
        <Skeleton key={i} className="h-44 w-full rounded-xl" />
      ))}
    </div>
  );
}
