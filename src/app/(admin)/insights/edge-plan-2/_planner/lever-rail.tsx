"use client";

import * as React from "react";
import {
  Banknote,
  Boxes,
  Gauge,
  Gem,
  Gift,
  Grid3x3,
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
 * The seven lever workspaces of the Edge Plan 2.0 planner (v2.1 overhaul):
 * gaming · rewards · giveaways & budgets · shards · packs & signup ·
 * deposits & withdrawals (cashflow) · crediting matrix.
 *
 * This is the single source of truth for the group ids — `planner-shell`
 * (workspace switch) and `planner-nav` (active-group panel wrapper) both
 * consume `LEVER_GROUPS` / `LeverGroupId` so the navigation never drifts
 * out of sync with the rail.
 */
export type LeverGroupId =
  | "gaming"
  | "rewards"
  | "giveaways"
  | "shards"
  | "packs"
  | "cashflow"
  | "matrix";

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
    hint: "Packs & upgrader · raw vs weighted",
  },
  {
    id: "rewards",
    label: "Rewards core",
    short: "Rewards",
    icon: Gift,
    hint: "Rakeback · affiliate · deposit bonus",
  },
  {
    id: "giveaways",
    label: "Giveaways & budgets",
    short: "Giveaways",
    icon: Ticket,
    hint: "Raffles · races · rain · motha · adjustments",
  },
  {
    id: "shards",
    label: "Shards",
    short: "Shards",
    icon: Gem,
    hint: "Earn rate · EV per shard · giveback target",
  },
  {
    id: "packs",
    label: "Packs & signup",
    short: "Packs",
    icon: Boxes,
    hint: "Daily packs · levels · re-lock · signup",
  },
  {
    id: "cashflow",
    label: "Deposits & withdrawals",
    short: "Cashflow",
    icon: Banknote,
    hint: "Deposit fee · withdrawal wager rules",
  },
  {
    id: "matrix",
    label: "Crediting matrix",
    short: "Matrix",
    icon: Grid3x3,
    hint: "Reward-source crediting · savings",
  },
];

/**
 * Lever-projection row keys aggregated into each group's live edge-drag
 * badge. `gaming` carries no reward-cost row (it moves the gross edge, not
 * a reward cost). `cashflow` is special-cased in {@link leverGroupDragPct}:
 * its only $ line is the deposit-fee REVENUE channel, surfaced as a
 * negative drag so the shared badge renders its emerald "+x% edge"
 * revenue variant. `matrix` folds the `credit-matrix` row, whose planned
 * cost is ≤ 0 (a cost REDUCTION) — also emerald via sign.
 *
 * The actual key strings are owned by the model (`projectEdgePlanV2`); this
 * map is the rail's view of which rows belong where so the parent can fold
 * them with the reused `combinedLeverEdgeDragPct` helper.
 */
export const LEVER_GROUP_DRAG_KEYS: Record<LeverGroupId, string[]> = {
  gaming: [],
  rewards: ["rakeback", "affiliate", "leaderboard", "deposit-bonus"],
  giveaways: [
    "races",
    "raffles",
    "rain",
    "motha",
    "gift-cards",
    "promo-codes",
    "adjustments",
    "other",
  ],
  shards: ["shards"],
  packs: ["daily-packs", "signup-packs"],
  cashflow: [],
  matrix: ["credit-matrix"],
};

/**
 * Live edge-drag for a group, reusing the canonical helpers. The affiliate
 * commission row needs the worst-case tier context, so when a group folds
 * in `affiliate` we add its drag via `leverEdgeDragPct(..., ctx)` on top of
 * the remaining keys (which are plain wager-proportional rows).
 *
 * `cashflow` has no cost rows — its badge is the deposit-fee REVENUE as a
 * negative drag (house income per wager $), which the shared badge renders
 * emerald ("+x% edge").
 */
export function leverGroupDragPct(
  projection: EdgePlanV2Projection,
  groupId: LeverGroupId,
  ctx?: EdgeAfterRewardsContext,
): number {
  if (groupId === "cashflow") {
    const wager = Math.max(
      0,
      projection.plannedWager ?? projection.currentWager ?? 0,
    );
    if (wager <= 0) return 0;
    const revenue = projection.revenueLevers.reduce(
      (s, r) => s + Math.max(0, r.plannedUsd),
      0,
    );
    return revenue > 0 ? -(revenue / wager) : 0;
  }
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
 *   at a glance without opening it. Revenue/savings groups (cashflow,
 *   matrix) show the emerald "+x% edge" variant instead.
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
