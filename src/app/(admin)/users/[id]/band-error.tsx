"use client";

/**
 * Page-local error primitives for /users/[id] — deliberately NOT in a shared
 * folder (no hotspot edit). Two surfaces:
 *
 *   • `ErrorPill`  — a tiny amber pill for spots where a full InlineError
 *     would dwarf the slot (the hero risk badge). Reads as "this signal is
 *     unavailable", NEVER as a neutral all-clear (a failed risk scan must
 *     not render as "Risk 0").
 *
 *   • `BandError`  — thin re-wrap of the house `InlineError` (compact) for
 *     KPI/panel bands fed by a failed query. Same amber visual family as
 *     TileErrorFallback; copy stays generic (safeQuery SECURITY note: never
 *     echo a raw error message into the DOM).
 *
 * Both pair with the page's `SafeQueryResult` promises: a band `use()`s the
 * promise and renders data, an explicit empty state, or one of these —
 * three distinguishable states, never a silent empty.
 */

import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { InlineError } from "@/components/entity-surface/inline-error";

/** Compact amber "unavailable" pill — hero badge slots. */
export function ErrorPill({
  label,
  title,
  className,
}: {
  label: string;
  /** Tooltip with safe, generic context. Never a raw error message. */
  title?: string;
  className?: string;
}) {
  return (
    <span
      role="status"
      title={title}
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/15 px-2 text-[10px] font-medium text-amber-600 dark:text-amber-400",
        className,
      )}
    >
      <AlertTriangle aria-hidden className="size-2.5" />
      {label}
    </span>
  );
}

/** Compact InlineError re-wrap for failed KPI/panel/table bands. */
export function BandError({
  title,
  hint,
  className,
}: {
  title: string;
  /** Safe, non-sensitive guidance. Never a raw error message. */
  hint?: string;
  className?: string;
}) {
  return <InlineError compact title={title} hint={hint} className={className} />;
}
