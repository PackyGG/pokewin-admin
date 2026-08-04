import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  ShieldAlert,
  ShieldCheck,
  UserRoundSearch,
} from "lucide-react";

import { HostLink } from "@/components/host-link";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Shared primitives for the antifraud list pages (fiat deposits and reviews).
// Everything here is server-safe and presentational — no client hooks. The
// two list pages used to carry byte-identical private copies of all of this;
// keep additions generic so the remaining sibling pages (signups, networks,
// creator-fraud) can migrate onto the same set.
// ---------------------------------------------------------------------------

/** Clamp a raw `?page=` param to a positive integer with an upper cap. */
export function parsePageParam(raw: string | undefined, max = 10_000): number {
  const value = Number(raw ?? "1");
  return Number.isInteger(value) && value > 0 ? Math.min(value, max) : 1;
}

/**
 * Merge a filter selection into the current list state: `null` clears a
 * dimension, a value selects it, `undefined` keeps the current one. Every
 * selection resets pagination to page 1. Page-specific fields (search,
 * includeKycRequired, …) are carried through untouched.
 */
export function mergeFilterSelection<
  S extends {
    page: number;
    status?: string;
    verdict?: string;
    reviewStatus?: string;
  },
>(
  state: S,
  selection: {
    status?: string | null;
    verdict?: S["verdict"] | null;
    reviewStatus?: S["reviewStatus"] | null;
  },
): S {
  return {
    ...state,
    page: 1,
    status:
      selection.status === null
        ? undefined
        : selection.status ?? state.status,
    verdict:
      selection.verdict === null
        ? undefined
        : selection.verdict ?? state.verdict,
    reviewStatus:
      selection.reviewStatus === null
        ? undefined
        : selection.reviewStatus ?? state.reviewStatus,
  } as S;
}

export function FilterGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <div className="inline-flex flex-wrap items-center gap-0.5 rounded-lg border border-border/60 bg-muted/30 p-0.5">
        {children}
      </div>
    </div>
  );
}

export function FilterButton({
  label,
  active,
  href,
}: {
  label: string;
  active: boolean;
  href: string;
}) {
  return (
    <HostLink
      href={href}
      aria-current={active ? "true" : undefined}
      className={cn(
        "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
        active
          ? "border border-border/70 bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </HostLink>
  );
}

export type ListVerdict = "good" | "review" | "bad";

export function verdictStyle(verdict: ListVerdict): {
  icon: typeof ShieldCheck;
  text: string;
  box: string;
} {
  if (verdict === "good") {
    return {
      icon: ShieldCheck,
      text: "text-emerald-600 dark:text-emerald-400",
      box: "border-emerald-500/25 bg-emerald-500/5",
    };
  }
  if (verdict === "bad") {
    return {
      icon: ShieldAlert,
      text: "text-rose-600 dark:text-rose-400",
      box: "border-rose-500/25 bg-rose-500/5",
    };
  }
  return {
    icon: AlertTriangle,
    text: "text-amber-600 dark:text-amber-400",
    box: "border-amber-500/25 bg-amber-500/5",
  };
}

/** Inline label/value fact used inside assessment row footers. */
export function Fact({
  label,
  value,
  alert = false,
}: {
  label: string;
  value: string;
  alert?: boolean;
}) {
  return (
    <span className="inline-flex max-w-72 items-baseline gap-1.5">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span
        className={cn(
          "truncate font-medium tabular-nums",
          alert && "text-amber-600 dark:text-amber-400",
        )}
      >
        {value}
      </span>
    </span>
  );
}

/** Boxed label/value fact for grid layouts. */
export function FactCell({
  label,
  value,
  alert = false,
}: {
  label: string;
  value: string;
  alert?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border border-border/60 bg-muted/20 p-2.5",
        alert && "border-amber-500/30",
      )}
    >
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p
        className={cn(
          "mt-0.5 truncate text-xs font-medium tabular-nums",
          alert && "text-amber-600 dark:text-amber-400",
        )}
        title={value}
      >
        {value}
      </p>
    </div>
  );
}

export function EmptyState({
  text,
  icon: Icon = UserRoundSearch,
}: {
  text: string;
  icon?: React.ElementType;
}) {
  return (
    <div className="rounded-xl border border-dashed border-border/70 bg-card/40 px-4 py-14 text-center">
      <Icon className="mx-auto mb-3 size-6 text-muted-foreground" />
      <p className="text-sm text-muted-foreground">{text}</p>
    </div>
  );
}

export function ListPagination({
  page,
  pages,
  total,
  unitLabel,
  previousHref,
  nextHref,
}: {
  page: number;
  pages: number;
  total: number;
  unitLabel: string;
  previousHref?: string;
  nextHref?: string;
}) {
  return (
    <div className="flex items-center justify-between text-xs text-muted-foreground">
      <span>
        Page {page} of {pages} · {total} {unitLabel}
      </span>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={!previousHref}
          render={previousHref ? <HostLink href={previousHref} /> : undefined}
        >
          <ChevronLeft className="size-3.5" />
          Previous
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!nextHref}
          render={nextHref ? <HostLink href={nextHref} /> : undefined}
        >
          Next
          <ChevronRight className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

export function ListPageSkeleton({
  tiles = 4,
  tileGridClassName = "grid gap-3 sm:grid-cols-2 xl:grid-cols-4",
  tileClassName = "h-24 rounded-xl",
  rows = 4,
}: {
  tiles?: number;
  tileGridClassName?: string;
  tileClassName?: string;
  rows?: number;
}) {
  return (
    <div className="space-y-4">
      <div className={tileGridClassName}>
        {Array.from({ length: tiles }).map((_, index) => (
          <Skeleton key={index} className={tileClassName} />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, index) => (
        <Skeleton key={index} className="h-36 rounded-xl" />
      ))}
    </div>
  );
}
