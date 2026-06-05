"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { cn } from "@/lib/utils";
import { Spinner } from "./spinner";
import { transition } from "./motion";

/**
 * ──────────────────────────────────────────────────────────────────────────
 *  PeriodChips / TabChips — reusable URL-driven chip selector
 *  pokewin-admin · src/components/ux
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Distilled from the gold-standard `/dashboard` period selector
 * (src/app/(admin)/dashboard/dashboard-period-selector.tsx). It is the canonical
 * pattern for "flip a URL query param without losing scroll or blanking the
 * page" across the admin:
 *
 *   - reads the current value from `useSearchParams()` (URL is the source of
 *     truth → deep-linkable, refresh-safe, back-button friendly);
 *   - writes via `router.replace(..., { scroll: false })` inside
 *     `useTransition` so the click feels instant (the chip flips active right
 *     away) while the server re-render streams in behind a small in-chip
 *     spinner — and the page does NOT jump to the top while you switch
 *     (the `[data-admin-scroll]` reset deliberately ignores param-only nav);
 *   - dims the NON-active chips during a pending transition so the loading
 *     state is legible without blanking any content;
 *   - eases the colour swap with the central motion system's
 *     `transition("colors")` (reduced-motion users land on the final state
 *     instantly, no tween).
 *
 * Serializable props only — `items` is plain data and there are NO function
 * props, so this is safe to render directly from a Server Component (it carries
 * its own "use client" boundary).
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *
 *   // period chips, "30d" is the clean default (param removed when selected)
 *   <PeriodChips
 *     items={[
 *       { value: "today", label: "Today" },
 *       { value: "7d", label: "7d" },
 *       { value: "30d", label: "30d" },
 *       { value: "all", label: "All" },
 *     ]}
 *     current={period}            // already-validated current value (string)
 *     paramKey="period"
 *     defaultValue="30d"          // optional: selecting this deletes ?period=
 *   />
 *
 *   // tab chips (thin alias — same behaviour, different param)
 *   <TabChips items={tabs} current={tab} paramKey="tab" />
 *
 * The parent server page reads the param (`searchParams.period` / `.tab`),
 * validates it against its own allow-list, and renders the matching slice.
 * This component does not validate — pass it the already-resolved `current`.
 */

export type ChipItem = {
  /** The value written to the URL param. */
  value: string;
  /** Human label shown on the chip. */
  label: string;
};

export function PeriodChips({
  items,
  current,
  paramKey,
  defaultValue,
  className,
  /** Accessible noun for labels, e.g. "period" → "Switch period to 7d". */
  ariaNoun = "view",
  spinnerSize = 14,
}: {
  items: readonly ChipItem[];
  current: string;
  paramKey: string;
  /**
   * Optional value treated as the clean default: selecting it DELETES the
   * param from the URL (so the canonical view has a bare URL) instead of
   * writing `?paramKey=defaultValue`.
   */
  defaultValue?: string;
  className?: string;
  ariaNoun?: string;
  spinnerSize?: number;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  function pick(next: string) {
    if (next === current) return;
    const params = new URLSearchParams(searchParams.toString());
    if (defaultValue !== undefined && next === defaultValue) {
      params.delete(paramKey);
    } else {
      params.set(paramKey, next);
    }
    const qs = params.toString();
    startTransition(() => {
      // `scroll: false` keeps the viewport put; the layout's scroll-to-top
      // island ignores param-only navigations, so the page stays where it is.
      router.replace(qs ? `?${qs}` : "?", { scroll: false });
    });
  }

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-0.5 rounded-lg border bg-muted/50 p-1",
        className,
      )}
    >
      {items.map(({ value, label }) => {
        const active = value === current;
        return (
          <button
            key={value}
            type="button"
            onClick={() => pick(value)}
            disabled={active || isPending}
            aria-pressed={active}
            aria-label={
              active
                ? `${ariaNoun} ${label}, currently selected`
                : `Switch ${ariaNoun} to ${label}`
            }
            className={cn(
              "inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-sm font-medium",
              // Centralized motion: reduced-motion-safe colour transition so the
              // active-chip swap eases consistently with the rest of the app
              // (and lands instantly under prefers-reduced-motion).
              transition("colors", "fast"),
              active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
              // During a refetch the content stays mounted (useTransition keeps
              // the prior render); we only dim the OTHER chips + spin the active
              // one so the pending state is legible without blanking anything.
              isPending && !active && "opacity-50",
            )}
            title={`Switch ${ariaNoun} to ${label}`}
          >
            {active && isPending && (
              <Spinner size={spinnerSize} label={`Loading ${label}`} />
            )}
            {label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Thin alias of {@link PeriodChips} for tab-style selectors that live in the
 * URL (`?tab=`). Identical behaviour; exists so call-sites read intentfully
 * (`<TabChips paramKey="tab" …>`). Defaults `ariaNoun` to "tab".
 */
export function TabChips(
  props: Omit<React.ComponentProps<typeof PeriodChips>, "ariaNoun"> & {
    ariaNoun?: string;
  },
) {
  return <PeriodChips ariaNoun="tab" {...props} />;
}
