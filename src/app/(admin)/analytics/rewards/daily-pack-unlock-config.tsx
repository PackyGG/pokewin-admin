import Link from "next/link";
import { ArrowRight, CalendarClock } from "lucide-react";

import { SectionHeading } from "@/components/modern-panels";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import { getDailyRewardUnlockConfigs } from "@/lib/queries/rewards";

export async function DailyPackUnlockConfig() {
  const { data: configs, error } = await safeQuery(
    () => getDailyRewardUnlockConfigs(),
    [],
    "analytics.rewards.dailyPackUnlockConfig",
    REWARD_QUERY_TIMEOUT_MS,
  );

  if (error || configs.length === 0) return null;

  return (
    <div className="rounded-2xl border bg-card p-4 sm:p-5">
      <SectionHeading
        icon={CalendarClock}
        title="Daily packs · 30-day re-unlock"
        action={
          <Link
            href="/rewards?tab=level-up"
            className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            Manage in Rewards
            <ArrowRight className="size-3" aria-hidden />
          </Link>
        }
      />
      <p className="mt-1 text-xs text-muted-foreground">
        After each 30-day period, players must re-earn this share of the
        level&apos;s wager requirement before opening the pack again.
      </p>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {configs.map((config) => {
          const threshold = config.dailyUnlockPercentage ?? 0.01;
          return (
            <div
              key={config.id}
              className="rounded-lg border bg-muted/20 px-3 py-2.5"
            >
              <p className="truncate text-xs text-muted-foreground">
                {config.name}
              </p>
              <p className="mt-1 text-lg font-semibold tabular-nums">
                {formatUnlockPercentage(threshold)}
              </p>
              {config.dailyUnlockPercentage == null && (
                <p className="text-[10px] text-muted-foreground">Default</p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function formatUnlockPercentage(value: number): string {
  const percent = Math.round(value * 10_000) / 100;
  return `${Number.isInteger(percent) ? percent.toFixed(0) : percent.toFixed(2)}%`;
}
