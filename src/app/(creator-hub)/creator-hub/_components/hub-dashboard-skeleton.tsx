import {
  ArrowDownToLine,
  Check,
  Coins,
  Sparkles,
  TrendingUp,
  UserPlus,
  type LucideIcon,
} from "lucide-react";

import { Skeleton } from "@/components/ui/skeleton";
import { SectionHeadingSkeleton } from "@/components/loading-skeletons";
import type { AccentColor } from "@/components/modern-panels";

/**
 * Creator Hub dashboard — ONE source of truth for the band structure.
 *
 * Exports:
 *   • `OVERVIEW_KPI_TILES` — the static definition (key/label/icon/accent)
 *     of the six Overview KPI tiles. The page maps this array to real
 *     `KpiTile`s; the skeletons below map the SAME array, so tile count and
 *     grid shape can never drift apart.
 *   • Band skeletons + the composed `HubDashboardSkeleton` used by BOTH
 *     `loading.tsx` and the page's in-page Suspense fallbacks.
 *
 * Server-safe (no client hooks).
 */

export type HubOverviewTileKey =
  | "wager"
  | "creatorCost"
  | "signups"
  | "ftds"
  | "deposits"
  | "netGgr";

export const OVERVIEW_KPI_TILES: ReadonlyArray<{
  key: HubOverviewTileKey;
  label: string;
  icon: LucideIcon;
  /** Default House-POV accent (netGgr flips to rose when negative). */
  accent: AccentColor;
}> = [
  { key: "wager", label: "Wager", icon: TrendingUp, accent: "emerald" },
  { key: "creatorCost", label: "Creator Cost", icon: Coins, accent: "rose" },
  { key: "signups", label: "Sign-ups", icon: UserPlus, accent: "blue" },
  { key: "ftds", label: "FTDs", icon: Check, accent: "blue" },
  {
    key: "deposits",
    label: "Deposits",
    icon: ArrowDownToLine,
    accent: "emerald",
  },
  { key: "netGgr", label: "Net Cohort GGR", icon: Sparkles, accent: "emerald" },
];

/** Grid classes shared by the real KPI strip and its skeleton. */
export const OVERVIEW_KPI_GRID_CLASS =
  "grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6";

/** Band a — six KPI tiles (count derived from the array) + cost chart. */
export function OverviewBandSkeleton() {
  return (
    <div className="space-y-4">
      <div className={OVERVIEW_KPI_GRID_CLASS}>
        {OVERVIEW_KPI_TILES.map((tile) => (
          <Skeleton key={tile.key} className="h-[92px] rounded-lg" />
        ))}
      </div>
      <CostChartSkeleton />
    </div>
  );
}

export function CostChartSkeleton() {
  return <Skeleton className="h-[360px] rounded-2xl" />;
}

/** Band b — uniform 3-up chart Card row (fixed 30 days). */
export function TrendsBandSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      {Array.from({ length: 3 }).map((_, i) => (
        <Skeleton key={i} className="h-[360px] rounded-2xl" />
      ))}
    </div>
  );
}

/** Top Creators list body (the Card shell renders statically). */
export function TopCreatorsListSkeleton() {
  return <Skeleton className="h-[240px] w-full rounded-lg" />;
}

/** Band c — four 4-week deal-performance tiles. */
export function FourWeekBandSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <Skeleton key={i} className="h-[92px] rounded-lg" />
      ))}
    </div>
  );
}

/**
 * Full-page composition mirroring the real band structure — used by
 * `loading.tsx`. The in-page Suspense fallbacks use the band pieces above.
 */
export function HubDashboardSkeleton() {
  return (
    <div className="space-y-6">
      {/* Overview · {window} — carries the period chips + add-creator. */}
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={140} action />
        <OverviewBandSkeleton />
      </div>

      {/* Trends · fixed 30 days */}
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={150} />
        <TrendsBandSkeleton />
      </div>

      {/* Top Creators card. */}
      <Skeleton className="h-[320px] rounded-2xl" />

      {/* Deal performance · last 4 weeks */}
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={200} action />
        <FourWeekBandSkeleton />
      </div>
    </div>
  );
}
