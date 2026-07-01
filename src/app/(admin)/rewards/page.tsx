import { Suspense } from "react";
import Link from "next/link";
import { CloudRain, Target } from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import {
  TableSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";
import { cn } from "@/lib/utils";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { LinkPendingShell } from "@/components/ux";
import { RainTab } from "./rain-tab";
import { ChallengesTab } from "./challenges-tab";

export const metadata = { title: "Rewards" };

const TABS = [
  { value: "rain", label: "Rain", icon: CloudRain },
  { value: "challenges", label: "Challenges", icon: Target },
] as const;

type TabValue = (typeof TABS)[number]["value"];

export default async function RewardsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/rewards");
  const params = await searchParams;
  const tab: TabValue = (TABS.find((t) => t.value === params.tab) ?? TABS[0])
    .value;

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={CloudRain}
          accent="blue"
          title="Rewards"
          subtitle="Community rain instances and game challenges."
        />
      </PageHero>

      <div className="space-y-4">
        <div className="-mx-1 overflow-x-auto px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <div className="inline-flex gap-1 rounded-lg bg-muted p-1">
            {TABS.map((t) => (
              <Link
                key={t.value}
                href={`/rewards?tab=${t.value}`}
                className={cn(
                  "inline-flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                  tab === t.value
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <t.icon className="size-4" aria-hidden />
                <LinkPendingShell spinnerSize={13}>
                  {t.label}
                </LinkPendingShell>
              </Link>
            ))}
          </div>
        </div>

        {/* Active-tab-only: only the selected tab's data component is rendered
            and awaited. Switching tabs is a `?tab=` navigation that swaps the
            child under a keyed Suspense boundary — the hidden tab never fires
            its queries on first paint (CLAUDE.md Active-Timeframe-Only). */}
        <Suspense
          key={tab}
          fallback={
            <>
              <TableSkeleton rows={12} columns={tab === "rain" ? 9 : 7} />
              <PaginationSkeleton />
            </>
          }
        >
          {tab === "rain" && <RainTab params={params} />}
          {tab === "challenges" && <ChallengesTab params={params} />}
        </Suspense>
      </div>
    </div>
  );
}
