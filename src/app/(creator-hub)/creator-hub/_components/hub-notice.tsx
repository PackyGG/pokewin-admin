import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";

/**
 * HubNotice — the ONE notice/banner primitive for the Creator Hub.
 *
 * Replaces the five ad-hoc treatments that grew across the sub-app (amber
 * degraded bands, rose error cards, dashed amber chip rows, the alt-tab
 * NoticeBanner, assorted `rounded-*` one-offs) with a single flat surface:
 * `rounded-lg border` + a tinted `/5` fill, matching the flat-tile standard
 * (no glow, no gradient, no sheen).
 *
 * Tones (House semantics):
 *   amber — degraded / partial data ("couldn't load", "timed out")
 *   rose  — hard failure / destructive context
 *   blue  — informational
 *   muted — neutral empty-ish notes
 *
 * `dashed` renders the border dashed — the house idiom for empty states.
 * Server-safe (no client hooks); usable from RSC and client components.
 */

const TONES = {
  amber: "border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-300",
  rose: "border-rose-500/30 bg-rose-500/5 text-rose-700 dark:text-rose-300",
  blue: "border-blue-500/30 bg-blue-500/5 text-blue-700 dark:text-blue-300",
  muted: "border-border bg-muted/30 text-muted-foreground",
} as const;

export type HubNoticeTone = keyof typeof TONES;

export function HubNotice({
  tone = "muted",
  icon: Icon,
  title,
  children,
  dashed = false,
  className,
}: {
  tone?: HubNoticeTone;
  icon?: LucideIcon;
  title?: React.ReactNode;
  children?: React.ReactNode;
  /** Dashed border — the house idiom for empty states. */
  dashed?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border p-3 text-xs",
        dashed && "border-dashed",
        TONES[tone],
        className,
      )}
    >
      <div className="flex items-start gap-2">
        {Icon && <Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden />}
        <div className="min-w-0 space-y-0.5">
          {title && <p className="font-semibold">{title}</p>}
          {children && (
            <div className={cn(title && "text-muted-foreground")}>
              {children}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * HubEmptyState — dashed empty box used by lists/queues when there is
 * genuinely nothing to show (distinct from a degraded HubNotice).
 */
export function HubEmptyState({
  icon: Icon,
  title,
  sub,
  className,
}: {
  icon: LucideIcon;
  title: React.ReactNode;
  sub?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-6 py-12 text-center",
        className,
      )}
    >
      <Icon className="size-6 text-muted-foreground/70" aria-hidden />
      <p className="text-sm font-medium">{title}</p>
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}
