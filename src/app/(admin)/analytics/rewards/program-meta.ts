import {
  Coins,
  RotateCcw,
  PackageOpen,
  LifeBuoy,
  Trophy,
  Flag,
  HandCoins,
  Layers,
  type LucideIcon,
} from "lucide-react";
import type { AccentColor } from "@/components/modern-panels";
import type { RewardProgramKey } from "@/lib/queries/insights-rewards/program-spend";

/**
 * Presentation metadata for the seven reward programs (+ the residual).
 *
 * Client-safe on purpose — the trend chart is a client component and needs
 * the same hues the server-rendered cards use, so the mapping lives here
 * instead of being duplicated on both sides of the RSC boundary.
 *
 * COLOUR RULE (house flat-design standard): the per-program hue lives on the
 * ICON only, so the seven programs stay distinguishable at a glance. Every
 * MONEY figure stays rose regardless of program — these are all payouts the
 * house funds, and House-POV says money going to players is rose. The chart
 * is the one exception: a stacked series needs distinguishable fills, so it
 * uses the same per-program hue for the area.
 */
export type ProgramMeta = {
  icon: LucideIcon;
  accent: AccentColor;
  /** Raw hex for recharts, which can't read Tailwind classes. */
  chartColor: string;
};

export const PROGRAM_META: Record<RewardProgramKey, ProgramMeta> = {
  depositBonus: { icon: Coins, accent: "cyan", chartColor: "#06b6d4" },
  rakeback: { icon: RotateCcw, accent: "purple", chartColor: "#a855f7" },
  dailyPacks: { icon: PackageOpen, accent: "amber", chartColor: "#f59e0b" },
  lossback: { icon: LifeBuoy, accent: "orange", chartColor: "#f97316" },
  leaderboards: { icon: Trophy, accent: "blue", chartColor: "#3b82f6" },
  races: { icon: Flag, accent: "pink", chartColor: "#ec4899" },
  creatorTips: { icon: HandCoins, accent: "rose", chartColor: "#f43f5e" },
  other: { icon: Layers, accent: "blue", chartColor: "#94a3b8" },
};

/** House-POV: reward money leaving the house is always rose. */
export const MONEY_OUT = "text-rose-600 dark:text-rose-400";
