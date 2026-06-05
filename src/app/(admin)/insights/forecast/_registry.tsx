import type { ComponentType } from "react";
import {
  Coins,
  Percent,
  Trophy,
  Users2,
  UserPlus,
  Ticket,
  Gift,
  type LucideIcon,
} from "lucide-react";

import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";
import type { AccentColor } from "../_forecast-engine";
import { ForecastTab as DepositBonusForecastTab } from "../rewards/deposit-bonus/_components/forecast-tab";
import { ForecastTab as RakebackForecastTab } from "../rewards/rakeback/_components/forecast-tab";
import { AffiliateForecastTab } from "../rewards/affiliate/_components/forecast-tab";
import { ForecastTab as RaceForecastTab } from "../rewards/race/_components/forecast-tab";
import { ForecastTab as SignupForecastTab } from "../rewards/signup/_components/forecast-tab";
import { ForecastTab as RaffleForecastTab } from "../rewards/raffle/_components/forecast-tab";
import { ForecastTab as MothaForecastTab } from "../rewards/motha/_components/forecast-tab";

/**
 * The unified-forecast-hub REWARD REGISTRY.
 *
 * Each entry binds a `?reward=` key to:
 *   • display metadata (label, hero icon, accent), and
 *   • a SERVER tab component that fetches the reward's REAL baseline and renders
 *     the reward's client forecast island (the same component the reward's own
 *     `/insights/rewards/<reward>?tab=forecast` page uses — so the hub and the
 *     standalone tab stay in lock-step).
 *
 * Adding a reward to the hub = add ONE entry here pointing at its `ForecastTab`.
 * No other hub change is required (the picker, lazy Suspense mounting, and
 * active-timeframe-only loading all derive from this list).
 *
 * ── Active-timeframe-only ───────────────────────────────────────────────────
 * The hub mounts ONLY the selected reward's `component` inside a
 * `<Suspense key={`${reward}:${period}`}>`, so ONLY that reward's baseline query
 * fires on the initial render — switching reward/period swaps the boundary and
 * fetches the newly-selected reward lazily. No reward is eager-loaded.
 */

export type ForecastTabComponent = ComponentType<{ period: InsightsRewardsPeriod }>;

export type ForecastRewardEntry = {
  /** Stable `?reward=` key. */
  key: string;
  /** Display label in the picker + hero. */
  label: string;
  /** One-line description under the picker. */
  blurb: string;
  /** Picker / hero icon. */
  icon: LucideIcon;
  /** House-POV accent for the picker chip. */
  accent: AccentColor;
  /** The reward's SERVER forecast tab (fetches baseline → renders the island). */
  component: ForecastTabComponent;
};

/**
 * Registered rewards, in picker order. Deposit bonus is the reference (and the
 * only fully-built forecast today); the fan-out wave appends rakeback / race /
 * affiliate / signup entries here as each reward's `_forecast/` + `ForecastTab`
 * land.
 */
export const FORECAST_REWARDS: ForecastRewardEntry[] = [
  {
    key: "deposit-bonus",
    label: "Deposit bonus",
    blurb: "Cap-policy scenarios — fixed / spaced / pooled / decay / per-segment.",
    icon: Coins,
    accent: "rose",
    component: DepositBonusForecastTab,
  },
  {
    key: "rakeback",
    label: "Rakeback",
    blurb: "Rate-policy scenarios — flat / tiered / cadence-gated / expiry / taper.",
    icon: Percent,
    accent: "rose",
    component: RakebackForecastTab,
  },
  {
    key: "affiliate",
    label: "Affiliate",
    blurb: "Commission-rate scenarios — flat trims / per-tier rebalance / qualification.",
    icon: Users2,
    accent: "rose",
    component: AffiliateForecastTab,
  },
  {
    key: "race",
    label: "Races",
    blurb: "Prize-pool scenarios — pool size / tier steepness / cadence / reduction.",
    icon: Trophy,
    accent: "amber",
    component: RaceForecastTab,
  },
  {
    key: "signup",
    label: "Signup bonus",
    blurb: "Grant-policy scenarios — flat / deposit-gated / tiered / dynamic-segment.",
    icon: UserPlus,
    accent: "rose",
    component: SignupForecastTab,
  },
  {
    key: "raffle",
    label: "Raffles",
    blurb: "Prize scenarios — pool size / frequency / ticket-rate / anti-farming.",
    icon: Ticket,
    accent: "amber",
    component: RaffleForecastTab,
  },
  {
    key: "motha",
    label: "Motha giveaways",
    blurb: "Spend-reduction scenarios — tips / rain / sponsored-battle channels.",
    icon: Gift,
    accent: "rose",
    component: MothaForecastTab,
  },
];

/** The default reward the hub opens on (first registered). */
export const DEFAULT_FORECAST_REWARD = FORECAST_REWARDS[0]?.key ?? "deposit-bonus";

/** Resolve a `?reward=` value to a registered entry, falling back to the default. */
export function resolveForecastReward(value: string | undefined): ForecastRewardEntry {
  const match = FORECAST_REWARDS.find((r) => r.key === value);
  return match ?? FORECAST_REWARDS[0];
}
