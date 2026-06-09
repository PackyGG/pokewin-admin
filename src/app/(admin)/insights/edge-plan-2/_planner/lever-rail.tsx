"use client";

import * as React from "react";
import {
  Banknote,
  Boxes,
  Gauge,
  Gift,
  Ticket,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import {
  combinedLeverEdgeDragPct,
  EdgeDragBadge,
  leverEdgeDragPct,
} from "./components/reward-edge-drag";
import {
  type EdgeAfterRewardsContext,
  type EdgePlanV2Projection,
} from "../_model-v2";

/**
 * The five lever workspaces of the Edge Plan 2.0 planner.
 *
 * This is the single source of truth for the group ids — `planner-shell`
 * (workspace switch) and `planner-nav` (mobile pills) both consume
 * `LEVER_GROUPS` / `LeverGroupId` so the navigation never drifts out of
 * sync with the rail.
 *
 * Shards + Future-levers (Ideas) were removed in the 2.0 rework; Raffles
 * was restored as a real cost workspace.
 */
export type LeverGroupId =
  | "gaming"
  | "rewards"
  | "raffles"
  | "withdrawals"
  | "packs";

export interface LeverGroup {
  id: LeverGroupId;
  /** Full label used on the wide rail. */
  label: string;
  /** Compact label used on the below-`lg` scroll-pill row. */
  short: string;
  icon: LucideIcon;
  /** One-line description shown under the label on the wide rail. */
  hint: string;
}

export const LEVER_GROUPS: LeverGroup[] = [
  {
    id: "gaming",
    label: "House edge",
    short: "Edge",
    icon: Gauge,
    hint: "Packs & upgrader margin",
  },
  {
    id: "rewards",
    label: "Rewards",
    short: "Rewards",
    icon: Gift,
    hint: "Rakeback · affiliate · bonuses · races",
  },
  {
    id: "raffles",
    label: "Raffles",
    short: "Raffles",
    icon: Ticket,
    hint: "Prize pool · frequency · ticket cost",
  },
  {
    id: "withdrawals",
    label: "Withdrawals",
    short: "Cash out",
    icon: Banknote,
    hint: "Volume · balance split · wager req",
  },
  {
    id: "packs",
    label: "Packs & signup",
    short: "Packs",
    icon: Boxes,
    hint: "Daily packs · signup · rain · motha",
  },
];

/**
 * Lever-projection row keys aggregated into each group's live edge-drag
 * badge. `gaming` carries no reward-cost row (it moves the gross edge, not
 * a reward cost) and `withdrawals` has no $ projection after the 2.0
 * rework (the fabricated friction adjustment was removed), so neither
 * shows a drag badge.
 *
 * The actual key strings are owned by the model (`projectEdgePlanV2`); this
 * map is the rail's view of which rows belong where so the parent can fold
 * them with the reused `combinedLeverEdgeDragPct` helper.
 */
export const LEVER_GROUP_DRAG_KEYS: Record<LeverGroupId, string[]> = {
  gaming: [],
  rewards: ["rakeback", "affiliate", "leaderboard", "deposit-bonus", "races"],
  raffles: ["raffles"],
  withdrawals: [],
  packs: ["daily-packs", "signup-packs", "rain", "motha", "other"],
};

/**
 * Live edge-drag for a group, reusing the canonical helpers. The affiliate
 * commission row needs the worst-case tier context, so when a group folds
 * in `affiliate` we add its drag via `leverEdgeDragPct(..., ctx)` on top of
 * the remaining keys (which are plain wager-proportional rows).
 */
export function leverGroupDragPct(
  projection: EdgePlanV2Projection,
  groupId: LeverGroupId,
  ctx?: EdgeAfterRewardsContext,
): number {
  const keys = LEVER_GROUP_DRAG_KEYS[groupId];
  if (keys.length === 0) return 0;
  if (keys.includes("affiliate")) {
    const affiliate = leverEdgeDragPct(projection, "affiliate", ctx);
    const rest = combinedLeverEdgeDragPct(
      projection,
      keys.filter((k) => k !== "affiliate"),
    );
    return affiliate + rest;
  }
  return combinedLeverEdgeDragPct(projection, keys);
}

function RailItem({
  group,
  active,
  dragPct,
  onSelect,
}: {
  group: LeverGroup;
  active: boolean;
  dragPct: number;
  onSelect: (id: LeverGroupId) => void;
}) {
  const Icon = group.icon;
  return (
    <button
      type="button"
      onClick={() => onSelect(group.id)}
      aria-current={active ? "true" : undefined}
      className={cn(
        "group/rail flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors",
        active
          ? "bg-background shadow-sm"
          : "text-muted-foreground hover:bg-background/60 hover:text-foreground",
      )}
    >
      <span
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-md border transition-colors",
          active
            ? "border-primary/30 bg-primary/10 text-primary"
            : "border-transparent bg-muted/50 text-muted-foreground group-hover/rail:text-foreground",
        )}
      >
        <Icon className="size-4" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-1.5">
          <span
            className={cn(
              "truncate text-sm font-medium",
              active ? "text-foreground" : undefined,
            )}
          >
            {group.label}
          </span>
          <EdgeDragBadge dragPct={dragPct} />
        </span>
        <span className="truncate text-[11px] text-muted-foreground">
          {group.hint}
        </span>
      </span>
    </button>
  );
}

function PillItem({
  group,
  active,
  dragPct,
  onSelect,
}: {
  group: LeverGroup;
  active: boolean;
  dragPct: number;
  onSelect: (id: LeverGroupId) => void;
}) {
  const Icon = group.icon;
  return (
    <button
      type="button"
      onClick={() => onSelect(group.id)}
      title={group.label}
      aria-current={active ? "true" : undefined}
      className={cn(
        "flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
        active
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:bg-background/60 hover:text-foreground",
      )}
    >
      <Icon className={cn("size-4", active && "text-primary")} />
      <span>{group.short}</span>
      <EdgeDragBadge dragPct={dragPct} />
    </button>
  );
}

/**
 * Left nav rail for the planner workspace.
 *
 * - `lg` and up: a vertical rail. The active group reads as a lifted card
 *   (`bg-background shadow-sm`) with its icon tinted violet; each row shows
 *   a live edge-drag badge so the cost impact of every workspace is legible
 *   at a glance without opening it.
 * - Below `lg`: degrades to a single horizontal scroll-pill row (the same
 *   markup family as `planner-nav.tsx`), since a vertical rail wastes the
 *   full width on a phone.
 *
 * `dragByGroup` is computed by the parent (which owns the projection +
 * affiliate context) via `leverGroupDragPct`, keeping this component a pure
 * presentational nav with no model coupling.
 */
export function LeverRail({
  active,
  onSelect,
  dragByGroup,
  className,
}: {
  active: LeverGroupId;
  onSelect: (id: LeverGroupId) => void;
  dragByGroup: Record<LeverGroupId, number>;
  className?: string;
}) {
  return (
    <>
      {/* Below lg: horizontal scroll-pills (mirrors planner-nav markup). */}
      <nav
        aria-label="Edge Plan 2.0 workspaces"
        className={cn(
          "flex gap-1 overflow-x-auto rounded-xl border bg-muted/40 p-1 lg:hidden [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
          className,
        )}
      >
        {LEVER_GROUPS.map((g) => (
          <PillItem
            key={g.id}
            group={g}
            active={g.id === active}
            dragPct={dragByGroup[g.id] ?? 0}
            onSelect={onSelect}
          />
        ))}
      </nav>

      {/* lg and up: vertical rail. */}
      <nav
        aria-label="Edge Plan 2.0 workspaces"
        className={cn(
          "hidden gap-1 rounded-xl border bg-muted/40 p-1.5 lg:flex lg:flex-col",
          className,
        )}
      >
        {LEVER_GROUPS.map((g) => (
          <RailItem
            key={g.id}
            group={g}
            active={g.id === active}
            dragPct={dragByGroup[g.id] ?? 0}
            onSelect={onSelect}
          />
        ))}
      </nav>
    </>
  );
}
