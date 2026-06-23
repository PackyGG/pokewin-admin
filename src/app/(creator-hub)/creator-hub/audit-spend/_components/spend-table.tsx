import Link from "next/link";
import {
  Trophy,
  Wallet,
  Sparkles,
  ReceiptText,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { formatCurrency, formatDateTime } from "@/lib/utils/format";
import { TileErrorFallback } from "@/components/tile-error-fallback";

import {
  spendBucketLabel,
  spendTypeLabel,
  type SpendBucketKey,
  type SpendEventRow,
  type SpendEventsPage,
} from "../_queries/spend-events";
import { SpendPagination } from "./spend-pagination";

const BUCKET_BADGE: Record<
  Exclude<SpendBucketKey, "all">,
  { icon: LucideIcon; classes: string }
> = {
  leaderboard: {
    icon: Trophy,
    classes:
      "bg-rose-500/15 text-rose-600 dark:text-rose-300 border-rose-500/30",
  },
  fill: {
    icon: Wallet,
    classes:
      "bg-rose-500/15 text-rose-600 dark:text-rose-300 border-rose-500/30",
  },
  multiplier: {
    icon: Sparkles,
    classes:
      "bg-rose-500/15 text-rose-600 dark:text-rose-300 border-rose-500/30",
  },
  expense: {
    icon: ReceiptText,
    classes:
      "bg-rose-500/15 text-rose-600 dark:text-rose-300 border-rose-500/30",
  },
};

function BucketBadge({
  bucket,
}: {
  bucket: Exclude<SpendBucketKey, "all">;
}) {
  const cfg = BUCKET_BADGE[bucket];
  const Icon = cfg.icon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
        cfg.classes,
      )}
    >
      <Icon className="size-3" />
      {spendBucketLabel(bucket)}
    </span>
  );
}

function UserCell({ row }: { row: SpendEventRow }) {
  if (!row.user) {
    return (
      <span className="text-xs text-muted-foreground">House / system</span>
    );
  }
  const initial = (row.user.username ?? "?").slice(0, 1).toUpperCase();
  return (
    <Link
      href={`/creator-hub/creators/${row.user.id}`}
      className="group inline-flex min-w-0 items-center gap-2 hover:underline"
    >
      <Avatar className="size-7 shrink-0">
        <AvatarImage
          src={row.user.image ?? undefined}
          alt={row.user.username ?? ""}
        />
        <AvatarFallback className="text-[10px]">{initial}</AvatarFallback>
      </Avatar>
      <span className="min-w-0 truncate text-sm font-medium">
        {row.user.username ?? "Unknown"}
      </span>
    </Link>
  );
}

function RowAmount({ amount }: { amount: number }) {
  // House POV — every cost on this page = the house paid out = rose.
  return (
    <span className="tabular-nums text-sm font-semibold text-rose-600 dark:text-rose-400">
      −{formatCurrency(amount)}
    </span>
  );
}

function SpendRow({ row }: { row: SpendEventRow }) {
  const dateStr = formatDateTime(new Date(row.occurredAt));
  const typeLabel = spendTypeLabel(row.rawType);
  const RowWrap = ({ children }: { children: React.ReactNode }) =>
    row.href ? (
      <Link
        href={row.href}
        className="group flex flex-col gap-2 rounded-2xl border border-border/60 bg-background/40 p-3 transition-colors hover:border-rose-500/40 hover:bg-rose-500/[0.04] sm:flex-row sm:items-center sm:gap-3"
      >
        {children}
      </Link>
    ) : (
      <div className="flex flex-col gap-2 rounded-2xl border border-border/60 bg-background/40 p-3 sm:flex-row sm:items-center sm:gap-3">
        {children}
      </div>
    );

  return (
    <RowWrap>
      {/* Left — date + bucket */}
      <div className="flex shrink-0 flex-col gap-1 sm:w-[170px]">
        <div className="text-xs font-medium text-foreground/90">{dateStr}</div>
        <div>
          <BucketBadge bucket={row.bucket} />
        </div>
      </div>

      {/* Middle — type + context + user */}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="text-sm font-semibold text-foreground">
          {typeLabel}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {row.context}
        </div>
        <div className="mt-0.5">
          <UserCell row={row} />
        </div>
      </div>

      {/* Right — amount + source */}
      <div className="flex shrink-0 items-center justify-between gap-3 sm:flex-col sm:items-end sm:justify-center sm:gap-1">
        <RowAmount amount={row.amountUsd} />
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground/70">
          {row.source === "ledger" ? "Ledger" : "Admin expense"}
        </span>
      </div>
    </RowWrap>
  );
}

/**
 * Audit-spend table — one row per house-paid creator-cost event,
 * lifetime DESC. Server-component-rendered with full URL-driven
 * pagination at the bottom.
 */
export function SpendTable({
  bucket,
  data,
  error,
  kind,
}: {
  bucket: SpendBucketKey;
  data: SpendEventsPage;
  error: string | null;
  kind: "timeout" | "error" | null;
}) {
  // Hard-failure path — the whole leg degraded. Show the standard error
  // tile so the rest of the page still renders.
  if (error && data.rows.length === 0 && data.total === 0) {
    return (
      <div className="space-y-3">
        <TileErrorFallback
          label="Spend events"
          kind={kind ?? "error"}
          size="panel"
          hint="Refresh to retry — the underlying query may still complete on its own."
        />
      </div>
    );
  }

  if (data.rows.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border/70 bg-background/40 p-10 text-center">
        <p className="text-sm font-medium text-foreground/80">
          No spend events for this filter.
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Try a different event-type chip above.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        {data.rows.map((row) => (
          <SpendRow key={row.key} row={row} />
        ))}
      </div>
      <SpendPagination
        bucket={bucket}
        page={data.page}
        totalPages={data.totalPages}
        total={data.total}
        perPage={data.perPage}
        degraded={Boolean(error) || data.countDegraded}
      />
    </div>
  );
}
