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

export function guideAccentClass(accent: GuideAccent = "muted"): string {
  return GUIDE_ACCENTS[accent];
}

// ─── GuidePage ────────────────────────────────────────────────────

/**
 * Editorial page frame. The title and summary share the header width on large
 * screens, then sections use the same label-column/content-column rhythm.
 * This keeps long operator guides readable without turning the whole page
 * into a narrow stack of cards surrounded by unused space.
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
    <div className="mx-auto w-full max-w-[1600px]">
      <PageHero className="grid gap-4 border-b border-border/60 pb-6 lg:grid-cols-[minmax(240px,0.7fr)_minmax(0,1.3fr)] lg:items-end lg:gap-10 xl:gap-16">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            {eyebrow}
          </p>
          <h1 className="mt-2 max-w-xl text-2xl font-semibold tracking-tight sm:text-3xl">
            {title}
          </h1>
        </div>
        <p className="max-w-4xl text-sm leading-6 text-muted-foreground sm:text-[15px] sm:leading-7">
          {intro}
        </p>
      </PageHero>
      <div className="divide-y divide-border/60">{children}</div>
    </div>
  );
}

// ─── GuideSection ─────────────────────────────────────────────────

/**
 * One stable editorial row: section identity on the left, working content on
 * the right. A divider supplies structure without nesting every section in a
 * large rounded card.
 */
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
    <section className="grid gap-5 py-7 first:pt-6 sm:py-8 lg:grid-cols-[minmax(220px,0.7fr)_minmax(0,1.3fr)] lg:gap-10 xl:gap-16">
      <header className="min-w-0 lg:sticky lg:top-5 lg:self-start">
        <SectionHeading icon={icon} title={title} />
        {description && (
          <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">
            {description}
          </p>
        )}
      </header>
      <div className="min-w-0 space-y-4">{children}</div>
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
    <div className="border-t border-border/50 pt-4 first:border-t-0 first:pt-0">
      <h3 className="text-sm font-semibold tracking-tight sm:text-[15px]">{title}</h3>
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
 * Ordered stages. The numbered grid uses the available width on desktop and
 * remains a real `<ol>`, so the workflow order survives every viewport and
 * assistive technology.
 */
export function GuideSteps({
  steps,
  accent = "cyan",
}: {
  steps: readonly GuideStep[];
  accent?: GuideAccent;
}) {
  return (
    <ol className="grid gap-px overflow-hidden rounded-xl border border-border/60 bg-border/60 sm:grid-cols-2">
      {steps.map((step, index) => (
        <li key={step.title} className="min-w-0 bg-card p-4 sm:p-5">
          <span
            aria-hidden
            className={cn(
              "flex size-7 items-center justify-center rounded-full border border-border/60 text-xs font-bold tabular-nums",
              guideAccentClass(accent),
            )}
          >
            {index + 1}
          </span>
          <p className="mt-3 text-sm font-semibold leading-5">{step.title}</p>
          <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
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
    <div className="overflow-hidden rounded-xl border border-border/60 bg-card">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] border-collapse text-left text-sm">
          {caption && (
            <caption className="border-b border-border/60 px-4 py-3 text-left text-xs text-muted-foreground">
              {caption}
            </caption>
          )}
          <thead>
            <tr className="border-b border-border/60 bg-muted/30">
              {columns.map((column) => (
                <th
                  key={column}
                  scope="col"
                  className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground"
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
                className="border-b border-border/40 odd:bg-muted/10 last:border-b-0"
              >
                {row.cells.map((cell, i) => (
                  <td
                    key={i}
                    className={cn(
                      "px-4 py-3 align-top text-sm leading-6",
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
 * Editorial margin callout. The tone is carried by the icon glyph and label;
 * a single rule separates it from the surrounding reference content.
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
    <aside className="flex gap-3 border-l-2 border-border pl-3.5 py-1">
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
    </aside>
  );
}

// ─── GuideDefList ─────────────────────────────────────────────────

export type GuideDefItem = {
  term: React.ReactNode;
  detail: React.ReactNode;
};

/** Term → meaning pairs in one coherent reference block, not a tile cloud. */
export function GuideDefList({ items }: { items: readonly GuideDefItem[] }) {
  return (
    <dl className="overflow-hidden rounded-xl border border-border/60 bg-card">
      {items.map((item, i) => (
        <div
          key={i}
          className="grid gap-1 border-b border-border/50 px-4 py-3.5 last:border-b-0 sm:grid-cols-[minmax(160px,0.7fr)_minmax(0,1.3fr)] sm:gap-5"
        >
          <dt className="text-sm font-semibold leading-5">{item.term}</dt>
          <dd className="text-sm leading-6 text-muted-foreground">
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
    <div className="grid gap-px overflow-hidden rounded-xl border border-border/60 bg-border/60 sm:grid-cols-2 xl:grid-cols-4">
      {facts.map((fact) => {
        const Icon = fact.icon;
        const accent = guideAccentClass(fact.accent ?? "cyan");
        return (
          <div
            key={fact.label}
            className="min-w-0 bg-card p-4"
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
    <ul className="grid gap-x-8 gap-y-2 xl:grid-cols-2">
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
 * guide shape instead: split title block, then two-column editorial rows.
 */
export function GuideLoading({ panels = 4 }: { panels?: number }) {
  return (
    <div className="mx-auto w-full max-w-[1600px]">
      <div className="grid gap-4 border-b border-border/60 pb-6 lg:grid-cols-[minmax(240px,0.7fr)_minmax(0,1.3fr)] lg:items-end lg:gap-10 xl:gap-16">
        <div className="space-y-2">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-8 w-72 max-w-full" />
        </div>
        <div className="space-y-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-4/5" />
        </div>
      </div>
      <div className="divide-y divide-border/60">
        {Array.from({ length: panels }).map((_, i) => (
          <div
            key={i}
            className="grid gap-5 py-8 lg:grid-cols-[minmax(220px,0.7fr)_minmax(0,1.3fr)] lg:gap-10 xl:gap-16"
          >
            <div className="space-y-2">
              <Skeleton className="h-5 w-44" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
            </div>
            <Skeleton className="h-40 w-full rounded-xl" />
          </div>
        ))}
      </div>
    </div>
  );
}
