import { UserPlus, Clock, TrendingUp, UserMinus, Users } from "lucide-react";
import { formatNumber } from "@/lib/utils/format";
import { getSignupAnalytics } from "@/lib/queries/rewards-category-analytics";
import { getSignupExtras } from "@/lib/queries/rewards-category-extras";
import { type RewardsPeriod } from "@/lib/queries/rewards-analytics";
import {
  CategoryDeepStatsPanel,
  baseDeepStatsTiles,
  type DeepStatsTile,
} from "./category-deep-stats";

/**
 * Sign Up tab on /rewards/analytics.
 *
 * Investigated ledger types: the platform has no dedicated
 * `signup_bonus` ledger transaction type (see `prisma/schema.prisma`
 * `ledger_transaction_type` enum, line 1221). All signup-pack /
 * welcome reward claims land under `balance_reward_claim` — the
 * generic reward-claim ledger row that also carries daily / weekly
 * one-time rewards. This tab therefore scans `balance_reward_claim`
 * for its volume / count / chart stats, same source as the existing
 * "Signup / Balance Rewards" category in `rewards-analytics.ts`.
 *
 * Category-specific cohort lens (extras) for the window:
 *   - First-time claimants (cohort = users whose signup AND first
 *     claim both fall in the window).
 *   - Median time-to-claim from signup for that cohort, in hours.
 *   - Share of cohort claimed within 24h / 7d.
 *   - Drop-off share — fraction of in-window signups who never
 *     claimed at all.
 *
 * House-POV: balance reward claims are money the house GIVES users
 * → rose.
 */
export async function SignupTab({
  period,
  periodLabel,
}: {
  period: RewardsPeriod;
  periodLabel: string;
}) {
  const [data, extras] = await Promise.all([
    getSignupAnalytics(period),
    getSignupExtras(period),
  ]);
  const base = baseDeepStatsTiles(data, periodLabel, {
    countSub: "Reward claims",
  });
  // Cohort lens tiles — these answer "did the cohort actually
  // engage?", which is the question this tab exists for. They sit at
  // the FRONT so admins read cohort engagement before raw payouts.
  const extraTiles: DeepStatsTile[] = [
    {
      label: "Cohort signups",
      value: formatNumber(extras.cohortSignups),
      sub: `${formatNumber(extras.newClaimants)} claimed`,
      icon: Users,
    },
    {
      label: "Median time-to-claim",
      value: formatHours(extras.medianHoursToClaim),
      sub: "From signup",
      icon: Clock,
    },
    {
      label: "Claimed in 24h",
      value: `${(extras.shareClaimWithin24h * 100).toFixed(1)}%`,
      sub: "Of claiming cohort",
      icon: TrendingUp,
    },
    {
      label: "Claimed in 7d",
      value: `${(extras.shareClaimWithin7d * 100).toFixed(1)}%`,
      sub: "Of claiming cohort",
      icon: TrendingUp,
    },
    {
      label: "Drop-off",
      value: `${(extras.dropOffShare * 100).toFixed(1)}%`,
      sub: "Signed up, never claimed",
      icon: UserMinus,
    },
  ];
  const tiles: DeepStatsTile[] = [...extraTiles, ...base];
  return (
    <CategoryDeepStatsPanel
      data={data}
      periodLabel={periodLabel}
      headerIcon={UserPlus}
      headerTitle="Sign Up"
      tiles={tiles}
      unitLabel="claims"
      emptyTitle="No signup reward claims in this window"
      emptyDescription={`No signup / balance reward claims were filed in the ${periodLabel.toLowerCase()} period. Try a longer period.`}
    />
  );
}

/**
 * Pretty-print an hours-since duration. Sub-hour → minutes, sub-day
 * → hours, then days. Defensive against NaN / negative values which
 * would imply clock skew in the cohort sweep.
 */
function formatHours(hours: number): string {
  if (!Number.isFinite(hours) || hours <= 0) return "—";
  if (hours < 1) {
    const mins = Math.round(hours * 60);
    return `${mins}m`;
  }
  if (hours < 24) {
    return `${hours.toFixed(1)}h`;
  }
  const days = hours / 24;
  return `${days.toFixed(1)}d`;
}
