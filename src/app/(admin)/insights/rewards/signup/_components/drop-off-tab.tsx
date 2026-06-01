import {
  UserMinus,
  Sparkles,
  Moon,
  Wallet,
  Gamepad2,
  Ban,
  HelpCircle,
} from "lucide-react";
import { SectionHeading, KpiTile } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { EmptyState } from "@/components/empty-state";
import { formatNumber } from "@/lib/utils/format";
import {
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import { getSignupDropOff } from "@/lib/queries/insights-rewards/signup/drop-off";
import { safeQuery } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";

/**
 * Drop-off tab — explains the non-claimer share of the signup cohort
 * by 5 mutually-exclusive buckets:
 *   - dormant          (never made any post-signup activity)
 *   - depositedNoClaim (deposited but didn't claim)
 *   - wageredNoClaim   (wagered but didn't deposit or claim)
 *   - bannedOrLocked   (account flagged)
 *   - other            (some activity but none of the above)
 *
 * Plus the claimers count for comparison so the page reads "100% of
 * cohort decomposed".
 */
export async function DropOffTab({
  period,
}: {
  period: InsightsRewardsPeriod;
}) {
  const { data, error } = await safeQuery(
    () => getSignupDropOff(period),
    null,
    "insights-rewards-signup.drop-off",
  );
  if (error || !data) {
    return (
      <TileErrorFallback
        label="Signup — Drop-off"
        hint="The drop-off query failed. Server logs hold the digest."
        size="panel"
      />
    );
  }
  const label = insightsRewardsPeriodLabel(period);
  if (data.cohortSize === 0) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <EmptyState
          icon={UserMinus}
          title={`No signups in ${label.toLowerCase()}`}
          description="No cohort to decompose. Try a longer period."
          compact
        />
      </div>
    );
  }

  const pct = (n: number) =>
    data.cohortSize > 0 ? ((n / data.cohortSize) * 100).toFixed(1) : "0.0";

  const buckets = [
    {
      key: "claimers",
      label: "Claimed bonus",
      icon: Sparkles,
      count: data.claimers,
      tone: "blue" as const,
      hint: "Made ≥1 balance_reward_claim",
    },
    {
      key: "dormant",
      label: "Dormant",
      icon: Moon,
      count: data.dormant,
      tone: "rose" as const,
      hint: "Signed up, made no ledger row",
    },
    {
      key: "depositedNoClaim",
      label: "Deposited, no claim",
      icon: Wallet,
      count: data.depositedNoClaim,
      tone: "rose" as const,
      hint: "Deposited but never claimed",
    },
    {
      key: "wageredNoClaim",
      label: "Wagered, no claim",
      icon: Gamepad2,
      count: data.wageredNoClaim,
      tone: "rose" as const,
      hint: "Wagered without deposit or claim (rare)",
    },
    {
      key: "bannedOrLocked",
      label: "Banned / locked",
      icon: Ban,
      count: data.bannedOrLocked,
      tone: "rose" as const,
      hint: "is_banned or is_locked flag",
    },
    {
      key: "other",
      label: "Other",
      icon: HelpCircle,
      count: data.other,
      tone: "rose" as const,
      hint: "Some activity, none of the above",
    },
  ];

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {buckets.map((b) => (
            <KpiTile
              key={b.key}
              label={b.label}
              value={`${formatNumber(b.count)} · ${pct(b.count)}%`}
              sub={b.hint}
              icon={b.icon}
              accent={b.tone}
            />
          ))}
        </div>
      </FadeIn>

      <FadeIn>
        <div className="space-y-3">
          <SectionHeading icon={UserMinus} title={`Cohort decomposition — ${label}`} />
          <div className="surface-sheen relative overflow-hidden rounded-2xl border bg-card p-4 sm:p-5">
            <p className="text-[11px] text-muted-foreground">
              {formatNumber(data.cohortSize)} signups split into 6
              mutually-exclusive buckets. Priority: ban/lock first, then
              dormant, then deposit/wager activity. Sums to the
              cohort total.
            </p>
            <div className="mt-3 space-y-2">
              {buckets.map((b) => {
                const share =
                  data.cohortSize > 0
                    ? (b.count / data.cohortSize) * 100
                    : 0;
                const Icon = b.icon;
                return (
                  <div
                    key={b.key}
                    className="rounded-lg border bg-muted/20 p-3"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-2">
                        <Icon
                          className={
                            b.tone === "blue"
                              ? "size-4 shrink-0 text-blue-500"
                              : "size-4 shrink-0 text-rose-500"
                          }
                        />
                        <span className="truncate text-sm font-medium">
                          {b.label}
                        </span>
                        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                          {formatNumber(b.count)} users
                        </span>
                      </div>
                      <span
                        className={
                          b.tone === "blue"
                            ? "shrink-0 text-sm font-medium tabular-nums text-blue-600 dark:text-blue-400"
                            : "shrink-0 text-sm font-medium tabular-nums text-rose-600 dark:text-rose-400"
                        }
                      >
                        {share.toFixed(1)}%
                      </span>
                    </div>
                    <div className="mt-2 h-2 overflow-hidden rounded-sm bg-muted">
                      <div
                        className={
                          b.tone === "blue"
                            ? "h-full rounded-sm bg-blue-500/60 transition-all"
                            : "h-full rounded-sm bg-rose-500/60 transition-all"
                        }
                        style={{ width: `${share}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </FadeIn>
    </div>
  );
}
