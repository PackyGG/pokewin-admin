import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Creator Hub dashboard KPI box — the mockup's overview tile rendered with
 * house-POV accents. A tinted card with a left accent bar, a soft corner
 * glow, an icon + label header, a big value, and a sub-line.
 *
 * Accent → house-POV meaning (see CLAUDE.md):
 *   • emerald → house gain (affiliate wager, deposits)
 *   • rose    → house cost (creator cost / payouts)
 *   • blue    → neutral count (creators, signups, FTDs, live)
 *
 * Serializable props only (icon is a component ref, value is a
 * pre-formatted string) so this renders cleanly from a Server Component.
 *
 * Placeholder mode: when a figure has no real windowed query yet, pass
 * `placeholder` — the box renders an em-dash with a small "no data yet"
 * note instead of fabricating a number. This is the honest state the
 * dashboard uses for 24h creator cost / sign-ups / FTDs / deposits until
 * their windowed queries exist.
 */

type Accent = "emerald" | "rose" | "blue";

const ACCENT: Record<
  Accent,
  { bar: string; glow: string; text: string; icon: string }
> = {
  emerald: {
    bar: "bg-emerald-500",
    glow: "bg-emerald-500/20",
    text: "text-emerald-600 dark:text-emerald-400",
    icon: "text-emerald-500",
  },
  rose: {
    bar: "bg-rose-500",
    glow: "bg-rose-500/20",
    text: "text-rose-600 dark:text-rose-400",
    icon: "text-rose-500",
  },
  blue: {
    bar: "bg-blue-500",
    glow: "bg-blue-500/20",
    text: "text-blue-600 dark:text-blue-400",
    icon: "text-blue-500",
  },
};

export function HubKpiBox({
  label,
  value,
  sub,
  icon: Icon,
  accent,
  live,
  placeholder,
  placeholderNote,
  info,
}: {
  label: string;
  /** Pre-formatted value string (ignored when `placeholder`). */
  value: string;
  sub?: string;
  icon: React.ElementType;
  accent: Accent;
  /** Renders a pulsing live dot before the value (the "Live Now" box). */
  live?: boolean;
  /** Renders the em-dash "no real data yet" state instead of `value`. */
  placeholder?: boolean;
  /** Short note shown under the em-dash in placeholder mode. */
  placeholderNote?: string;
  /** Optional (i) breakdown popover — client component, serializable props. */
  info?: React.ReactNode;
}) {
  const colors = ACCENT[accent];
  return (
    <div className="relative overflow-hidden rounded-2xl border bg-card p-4 sm:p-5">
      {/* Left accent bar */}
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-y-0 left-0 w-[3px] rounded-r",
          placeholder ? "bg-border" : colors.bar,
        )}
      />
      {/* Corner glow — suppressed for placeholders (no signal to celebrate). */}
      {!placeholder && (
        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute -right-8 -top-10 size-28 rounded-full blur-3xl opacity-60 motion-reduce:opacity-30",
            colors.glow,
          )}
        />
      )}
      <div className="relative flex items-center gap-2">
        <Icon
          className={cn(
            "size-4 shrink-0",
            placeholder ? "text-muted-foreground" : colors.icon,
          )}
        />
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        {info ? <span className="ml-auto shrink-0">{info}</span> : null}
      </div>

      {placeholder ? (
        <>
          <p className="relative mt-2 text-2xl font-bold tracking-tight text-muted-foreground/60">
            —
          </p>
          <p className="relative mt-0.5 truncate text-[11px] text-muted-foreground/80">
            {placeholderNote ?? "No data yet"}
          </p>
        </>
      ) : (
        <>
          <p
            className={cn(
              "relative mt-2 flex items-center gap-2 text-2xl font-bold tracking-tight tabular-nums",
              colors.text,
            )}
          >
            {live && (
              <span
                aria-hidden
                className="inline-block size-2.5 shrink-0 rounded-full bg-emerald-500 shadow-[0_0_0_3px_rgba(52,211,153,0.25)] motion-safe:animate-pulse"
              />
            )}
            <span className="truncate">{value}</span>
          </p>
          {sub && (
            <p className="relative mt-0.5 truncate text-[11px] text-muted-foreground">
              {sub}
            </p>
          )}
        </>
      )}
    </div>
  );
}
