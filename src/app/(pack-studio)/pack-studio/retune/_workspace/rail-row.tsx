"use client";

import * as React from "react";
import { Check, TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { formatCurrency } from "@/lib/utils/format";
import { cn } from "@/lib/utils";

import type { RetuneRailRow } from "../_queries/rail";
import { tagBadgeLabel } from "./plan-copy";
import type { PackVerdict } from "./plan-state";

/**
 * ONE memoized rail row (§6 row anatomy, 2 lines). 183 rows re-render on
 * every selection change otherwise — memoization keeps a rail click at two
 * row renders. Roving tabindex + `aria-selected` for keyboard users.
 *
 * Line 1: [checkbox] name … tag badge
 * Line 2: price · tier chip · edge dot (emerald ≥ own target, rose below,
 *         title shows Δpp) · amber triangle when offTagLive · verdict mark
 *         (rose dot infeasible-when-visited · amber dot staged-unpushed
 *         edits · emerald Check pushed).
 */

/** Tier badge tint — copied from `doctor-table.tsx` (escalates cool → rose). */
const TIER_COLORS: Record<string, string> = {
  T1: "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400 border-cyan-500/30",
  T2: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  T3: "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30",
  T4: "bg-orange-500/15 text-orange-600 dark:text-orange-400 border-orange-500/30",
  T5: "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30",
};

export type RailRowProps = {
  row: RetuneRailRow;
  selected: boolean;
  checked: boolean;
  /** Staged (unpushed) edits exist for this pack — amber dot. */
  staged: boolean;
  /** Pushed this session — emerald check. */
  pushed: boolean;
  /**
   * Already tuned via the workspace (persistent server set ∪ this session's
   * pushes) — the Done-tab members. Shows the subtle emerald check even for
   * packs tuned in a prior session, so the Done list reads consistently.
   */
  done: boolean;
  /** Verdict once visited (rose dot when infeasible / error / refused). */
  verdict: PackVerdict | undefined;
  onSelect: (packId: string) => void;
  onCheck: (packId: string, shiftKey: boolean) => void;
};

function RailRowInner({
  row,
  selected,
  checked,
  staged,
  pushed,
  done,
  verdict,
  onSelect,
  onCheck,
}: RailRowProps) {
  const belowTarget = row.edge < row.targetEdge - 1e-9;
  const edgeDeltaPp = ((row.edge - row.targetEdge) * 100).toFixed(2);
  // A non-ok plan verdict from THIS session (infeasible / error / refused)
  // wins over the emerald "done" check: a pack tuned in a PRIOR session
  // (`done`, but not `pushed` this session) that the operator re-edits into an
  // infeasible plan must still show the rose warning — not a misleading green
  // check. A this-session push always forces the verdict to "ok", so a
  // genuinely-pushed pack is never flagged and still shows the check.
  const flagged = verdict !== undefined && verdict !== "ok" && !pushed;
  return (
    <div
      role="option"
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      data-rail-row={row.packId}
      onClick={() => onSelect(row.packId)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(row.packId);
        }
      }}
      className={cn(
        "w-full cursor-pointer border-b px-2.5 py-2 text-left outline-none last:border-b-0",
        "motion-safe:transition-colors hover:bg-muted/40 focus-visible:bg-muted/40",
        selected && "bg-primary/[0.07] hover:bg-primary/[0.09]",
      )}
    >
      <div className="flex items-center gap-2">
        <span
          onClick={(e) => {
            e.stopPropagation();
            onCheck(row.packId, e.shiftKey);
          }}
          className="flex shrink-0 items-center"
        >
          <Checkbox
            checked={checked}
            aria-label={`Select ${row.name} for bulk`}
            className="size-3.5"
          />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {row.name}
        </span>
        {row.tag !== null && (
          <Badge
            variant="outline"
            className="h-4 shrink-0 px-1 text-[10px] tabular-nums"
          >
            {tagBadgeLabel(row.tag)}
          </Badge>
        )}
      </div>
      <div className="mt-0.5 flex items-center gap-1.5 pl-[22px] text-xs text-muted-foreground">
        <span className="tabular-nums">{formatCurrency(row.price)}</span>
        <Badge
          variant="outline"
          className={cn(
            "h-4 px-1 text-[10px]",
            TIER_COLORS[row.tier] ?? "",
          )}
        >
          {row.tier}
        </Badge>
        <span
          aria-hidden
          title={`edge ${(row.edge * 100).toFixed(2)}% vs target ${(row.targetEdge * 100).toFixed(2)}% (${Number(edgeDeltaPp) >= 0 ? "+" : ""}${edgeDeltaPp}pp)`}
          className={cn(
            "inline-block size-1.5 shrink-0 rounded-full",
            belowTarget ? "bg-rose-500" : "bg-emerald-500",
          )}
        />
        {row.offTagLive && (
          <TriangleAlert
            className="size-3 shrink-0 text-amber-500"
            aria-label="Live pool is off its tag"
          />
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {staged && !pushed && (
            <span
              aria-label="Staged edits (not pushed)"
              title="Staged edits (not pushed)"
              className="inline-block size-1.5 rounded-full bg-amber-500"
            />
          )}
          {flagged && (
            <span
              aria-label="Plan infeasible / refused on last visit"
              title="Plan infeasible / refused on last visit"
              className="inline-block size-1.5 rounded-full bg-rose-500"
            />
          )}
          {!flagged && (pushed || done) && (
            <Check
              className="size-3 text-emerald-500"
              aria-label={pushed ? "Pushed this session" : "Tuned via the workspace"}
            />
          )}
        </span>
      </div>
    </div>
  );
}

/** Memoized — only re-renders when its own facts change. */
export const RailRow = React.memo(RailRowInner);
