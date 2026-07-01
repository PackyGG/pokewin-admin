import { Suspense } from "react";
import Link from "next/link";
import { Settings, Percent } from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import { getRakebackConfigs } from "@/lib/queries/rewards";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { EmptyState } from "@/components/empty-state";
import { TileErrorFallback } from "@/components/tile-error-fallback";

export const metadata = { title: "Rewards Settings" };

// Streamed in its own Suspense boundary so the PageHero + section heading
// paint instantly instead of waiting on the rakeback-config read. The read
// is wrapped in safeQuery so a slow/failed fetch degrades to a calm fallback
// tile rather than tearing down the whole /rewards route via the segment
// error boundary.
async function RakebackConfigContent() {
  const { data: configs, error } = await safeQuery<
    Awaited<ReturnType<typeof getRakebackConfigs>>
  >(
    () => getRakebackConfigs(),
    [],
    "rewards.settings.rakeback-configs",
    REWARD_QUERY_TIMEOUT_MS,
  );

  if (error) {
    return (
      <TileErrorFallback
        label="Rakeback configuration"
        hint="The read failed or timed out — no data was changed. Refresh to retry."
        size="panel"
      />
    );
  }

  return (
    <FadeIn>
      <div className="rounded-2xl border bg-card/60">
        {configs.length === 0 ? (
          <EmptyState
            icon={Percent}
            title="No rakeback configs found"
            description="Rakeback tiers will appear here once they are configured."
            compact
          />
        ) : (
          <div className="space-y-3 p-5">
            {configs.map((config) => (
              <div key={config.id} className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Badge variant="outline">{config.displayName}</Badge>
                  <span className="text-sm text-muted-foreground">
                    {(config.percentage * 100).toFixed(2)}% &middot; {config.expirationDays}d expiry
                  </span>
                </div>
                <Badge
                  variant="outline"
                  className={
                    config.enabled
                      ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30"
                      : "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30"
                  }
                >
                  {config.enabled ? "Enabled" : "Disabled"}
                </Badge>
              </div>
            ))}
          </div>
        )}
      </div>
    </FadeIn>
  );
}

export default async function RewardsSettingsPage() {
  await requirePageAccess("/rewards/settings");

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Settings}
          title="Rewards Settings"
          subtitle="Global switches and rakeback configuration."
        />
      </PageHero>

      <div className="space-y-3">
        <SectionHeading
          icon={Percent}
          title="Rakeback Configuration"
          action={
            <Button variant="outline" size="sm" nativeButton={false} render={<Link href="/rewards?tab=rakeback" />}>
              Manage
            </Button>
          }
        />
        <Suspense
          fallback={
            <div className="h-40 animate-pulse rounded-2xl border bg-muted/30" />
          }
        >
          <RakebackConfigContent />
        </Suspense>
      </div>
    </div>
  );
}
