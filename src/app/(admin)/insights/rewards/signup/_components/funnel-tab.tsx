import {
  Filter,
  UserPlus,
  Sparkles,
  Wallet,
  Gamepad2,
  RotateCw,
} from "lucide-react";
import { SectionHeading } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { EmptyState } from "@/components/empty-state";
import { formatNumber } from "@/lib/utils/format";
import {
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import { getSignupFunnel } from "@/lib/queries/insights-rewards/signup/funnel";
import { safeQuery } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";

/**
 * Funnel tab — 5-stage signup → repeat-deposit conversion funnel for
 * /insights/rewards/signup.
 *
 * Each stage's bar width is the stage count / signup count (i.e. %
 * share of the original cohort) so drop-off compounds visually
 * left-to-right. A delta annotation between stages prints the
 * stage-over-stage drop-off %.
 *
 * House-POV: every bar is rose because the cohort is reward-related
 * (signup-cohort drop-off is a NEUTRAL fact and the page family is
 * rose-tinted). Drop-off labels are uncoloured to stay neutral.
 */
export async function FunnelTab({
  period,
}: {
  period: InsightsRewardsPeriod;
}) {
  const { data: funnel, error } = await safeQuery(
    () => getSignupFunnel(period),
    null,
    "insights-rewards-signup.funnel",
  );
  if (error || !funnel) {
    return (
      <TileErrorFallback
        label="Signup — Funnel"
        hint="The funnel query failed. Server logs hold the digest."
        size="panel"
      />
    );
  }
  const label = insightsRewardsPeriodLabel(period);

  if (funnel.signups === 0) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <EmptyState
          icon={Filter}
          title={`No signups in ${label.toLowerCase()}`}
          description="No users signed up in this window so there's no funnel to render."
          compact
        />
      </div>
    );
  }

  const stages = [
    { label: "Signups", icon: UserPlus, count: funnel.signups },
    { label: "Claimed bonus", icon: Sparkles, count: funnel.claimed },
    { label: "First deposit", icon: Wallet, count: funnel.firstDeposit },
    { label: "First wager", icon: Gamepad2, count: funnel.firstWager },
    { label: "Repeat deposit", icon: RotateCw, count: funnel.repeatDeposit },
  ];

  return (
    <div className="space-y-6">
      <FadeIn>
        <SectionHeading
          icon={Filter}
          title={`Conversion funnel — ${label}`}
        />
      </FadeIn>

      <FadeIn>
        <div className="surface-sheen relative overflow-hidden rounded-2xl border bg-card p-4 sm:p-5">
          <p className="text-[11px] text-muted-foreground">
            Drop-off from signup through repeat deposit. Each bar is %
            of the signup cohort. The stage-over-stage delta prints
            beside each step beyond the first.
          </p>
          <div className="mt-3 space-y-2">
            {stages.map((s, i) => {
              const Icon = s.icon;
              const share =
                funnel.signups > 0 ? (s.count / funnel.signups) * 100 : 0;
              const dropFromPrev =
                i > 0 && stages[i - 1].count > 0
                  ? ((stages[i - 1].count - s.count) /
                      stages[i - 1].count) *
                    100
                  : 0;
              return (
                <div
                  key={s.label}
                  className="rounded-lg border bg-muted/20 p-3"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <Icon className="size-4 shrink-0 text-rose-500" />
                      <span className="truncate text-sm font-medium">
                        {s.label}
                      </span>
                      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                        {formatNumber(s.count)} users
                      </span>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      {i > 0 && (
                        <span className="text-[10px] tabular-nums text-muted-foreground">
                          −{dropFromPrev.toFixed(1)}% vs prev
                        </span>
                      )}
                      <span className="text-sm font-medium tabular-nums text-rose-600 dark:text-rose-400">
                        {share.toFixed(1)}%
                      </span>
                    </div>
                  </div>
                  <div className="mt-2 h-2 overflow-hidden rounded-sm bg-muted">
                    <div
                      className="h-full rounded-sm bg-rose-500/60 transition-all"
                      style={{ width: `${share}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </FadeIn>
    </div>
  );
}
