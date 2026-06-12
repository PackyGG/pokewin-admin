"use client";

import * as React from "react";
import { Gift } from "lucide-react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/utils/format";

/**
 * RewardSpendPanel — the owner's "Reward spend" box.
 *
 * One panel, two homes:
 *   • /insights hub (full size): per-program LIFETIME $ spent + the edge
 *     reduction next to it (spend ÷ hub wager, in percentage points).
 *   • Edge Plan 2.0 hero (compact): the SAME box fed from the live
 *     projection — planned $ per program, moving with every lever.
 *
 * A dropdown selects the program ("All programs" lists every row, biggest
 * spend first). All props are plain serializable data, so the hub's server
 * page can render it directly (no function props across the RSC boundary).
 *
 * House-POV colors (strict): program spend = the house pays → rose with a
 * minus sign; a negative amount (e.g. crediting-matrix savings in the
 * planner mirror) = the house keeps → emerald with a plus. The edge-
 * reduction chip follows the same rule. Rows whose cost is not itemizable
 * in the window's model carry `amountUsd: null` and render an honest
 * "not itemized here" instead of a fabricated $0.
 */

export type RewardSpendRow = {
  /** Stable program key (also the dropdown value). */
  key: string;
  label: string;
  /**
   * Window $ spent (or planned $). Null = the program's cost is not
   * itemizable in this window's model — rendered honestly, never as $0.
   */
  amountUsd: number | null;
  /** spend ÷ wager × 100 — the program's edge reduction in % points. */
  edgeReductionPp: number | null;
  /** One-line plain-words explanation, shown when the row is selected. */
  note?: string;
};

/** "0.42%" with a third decimal only for sub-0.01pp dust. */
function formatPp(pp: number): string {
  const abs = Math.abs(pp);
  return `${abs.toFixed(abs > 0 && abs < 0.01 ? 3 : 2)}%`;
}

const ROSE = "text-rose-600 dark:text-rose-400";
const EMERALD = "text-emerald-600 dark:text-emerald-400";

/** Signed house-POV $ for one program: cost → "−$x" rose, savings → "+$x" emerald. */
function SpendAmount({
  amountUsd,
  className,
}: {
  amountUsd: number;
  className?: string;
}) {
  const isCost = amountUsd > 0.005;
  const isSaving = amountUsd < -0.005;
  return (
    <span
      className={cn(
        "font-semibold tabular-nums",
        isCost ? ROSE : isSaving ? EMERALD : "text-muted-foreground",
        className,
      )}
    >
      {isCost ? "−" : isSaving ? "+" : ""}
      {formatCurrency(Math.abs(amountUsd))}
    </span>
  );
}

/** The edge-reduction chip: "−0.42% edge" (rose) / "+0.10% edge" (emerald savings). */
function EdgeReductionChip({
  pp,
  className,
}: {
  pp: number | null;
  className?: string;
}) {
  if (pp == null) {
    return (
      <span
        className={cn(
          "rounded-full border bg-background px-2 py-0.5 text-[10px] tabular-nums text-muted-foreground",
          className,
        )}
      >
        — edge
      </span>
    );
  }
  const isCost = pp > 0.0005;
  const isSaving = pp < -0.0005;
  return (
    <span
      title="Spend ÷ hub wager — percentage points of edge this program eats"
      className={cn(
        "rounded-full border bg-background px-2 py-0.5 text-[10px] font-semibold tabular-nums",
        isCost ? ROSE : isSaving ? EMERALD : "text-muted-foreground",
        className,
      )}
    >
      {isCost ? "−" : isSaving ? "+" : ""}
      {formatPp(pp)} edge
    </span>
  );
}

export function RewardSpendPanel({
  title,
  windowLabel,
  rows,
  totalUsd,
  totalPp,
  totalLabel = "All programs",
  footnote,
  compact = false,
  className,
}: {
  title: string;
  /** LOUD window label — scopes are never mixed silently. */
  windowLabel: string;
  /** Program rows in the owner's dropdown order. */
  rows: RewardSpendRow[];
  /** Total on-site spend for the window (the "All programs" figure). */
  totalUsd: number;
  /** totalUsd ÷ wager × 100 (% points), or null when the wager is unknown. */
  totalPp: number | null;
  totalLabel?: string;
  /** Honest footnote (creator-cost exclusion, item-cost programs, …). */
  footnote?: string;
  /** Tighter paddings/text for the Edge Plan hero mirror. */
  compact?: boolean;
  className?: string;
}) {
  const [selected, setSelected] = React.useState<string>("all");
  const selectedRow =
    selected === "all" ? null : (rows.find((r) => r.key === selected) ?? null);

  // "All programs" list: biggest spend first, non-itemized (null) rows last.
  const sortedRows = React.useMemo(() => {
    return rows
      .slice()
      .sort((a, b) => (b.amountUsd ?? -Infinity) - (a.amountUsd ?? -Infinity));
  }, [rows]);

  return (
    <div
      className={cn(
        "rounded-xl border bg-card",
        compact ? "px-3 py-2.5 sm:px-4 sm:py-3" : "p-4 sm:p-5",
        className,
      )}
    >
      {/* Header: title + LOUD window chip + program dropdown */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <Gift
            aria-hidden
            className={cn("shrink-0 text-rose-500", compact ? "size-3.5" : "size-4")}
          />
          <p
            className={cn(
              "truncate font-semibold uppercase tracking-wider text-muted-foreground",
              compact ? "text-[11px]" : "text-xs",
            )}
          >
            {title}
          </p>
          <span className="shrink-0 rounded-full border bg-background px-2 py-0.5 text-[10px] font-semibold text-foreground">
            {windowLabel}
          </span>
        </div>
        <Select value={selected} onValueChange={(v) => v && setSelected(String(v))}>
          <SelectTrigger
            size="sm"
            aria-label="Reward program"
            className="max-w-[14rem]"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All programs</SelectItem>
            {rows.map((r) => (
              <SelectItem key={r.key} value={r.key}>
                {r.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {selectedRow == null ? (
        <>
          {/* Total strip — what ALL programs ate together. */}
          <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <SpendAmount
              amountUsd={totalUsd}
              className={compact ? "text-lg" : "text-2xl"}
            />
            <EdgeReductionChip pp={totalPp} />
            <span className="text-[10px] text-muted-foreground">{totalLabel}</span>
          </div>

          {/* Per-program rows, biggest spend first. */}
          <div className={cn("mt-2 divide-y", compact && "max-h-56 overflow-y-auto pr-1")}>
            {sortedRows.map((r) => (
              <div
                key={r.key}
                className="flex items-center justify-between gap-2 py-1.5"
              >
                <span
                  className={cn(
                    "min-w-0 truncate text-muted-foreground",
                    compact ? "text-[11px]" : "text-xs",
                  )}
                >
                  {r.label}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  {r.amountUsd == null ? (
                    <span className="text-[10px] italic text-muted-foreground">
                      not itemized here — see Edge Plan 2.0
                    </span>
                  ) : (
                    <>
                      <SpendAmount
                        amountUsd={r.amountUsd}
                        className={compact ? "text-[11px]" : "text-xs"}
                      />
                      <EdgeReductionChip pp={r.edgeReductionPp} />
                    </>
                  )}
                </span>
              </div>
            ))}
          </div>
        </>
      ) : (
        /* One selected program — its window spend + edge reduction, big. */
        <div className="mt-2">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            {selectedRow.amountUsd == null ? (
              <p className="text-sm font-medium text-muted-foreground">
                Not itemized in this window&apos;s model
              </p>
            ) : (
              <>
                <SpendAmount
                  amountUsd={selectedRow.amountUsd}
                  className={compact ? "text-xl" : "text-3xl"}
                />
                <EdgeReductionChip pp={selectedRow.edgeReductionPp} />
              </>
            )}
            <span className="text-[10px] text-muted-foreground">
              {selectedRow.label} · {windowLabel}
            </span>
          </div>
          {selectedRow.note && (
            <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">
              {selectedRow.note}
            </p>
          )}
        </div>
      )}

      {footnote && (
        <p className="mt-2 border-t pt-2 text-[10px] leading-snug text-muted-foreground">
          {footnote}
        </p>
      )}
    </div>
  );
}
