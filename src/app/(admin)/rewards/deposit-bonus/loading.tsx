import { Coins } from "lucide-react";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { DEPOSIT_BONUS_RATE_PCT } from "@/lib/queries/rewards/deposit-bonus-tracker";

export default function Loading() {
  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Coins}
          accent="rose"
          title="Deposit Bonus"
          subtitle={`${DEPOSIT_BONUS_RATE_PCT}% of every deposit, capped per rolling window. Live spend plus savings vs the old system.`}
        />
      </PageHero>

      <div className="space-y-6">
        <div className="flex flex-wrap gap-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-6 w-40 rounded-full bg-muted animate-pulse" />
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3 xl:grid-cols-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-24 rounded-xl border bg-muted/20 animate-pulse" />
          ))}
        </div>
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="h-44 rounded-2xl border bg-muted/20 animate-pulse lg:col-span-2" />
          <div className="h-44 rounded-2xl border bg-muted/20 animate-pulse" />
        </div>
        <div className="h-[320px] rounded-2xl border bg-muted/20 animate-pulse" />
      </div>
    </div>
  );
}
