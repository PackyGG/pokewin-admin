import { Suspense } from "react";
import Link from "next/link";
import { Percent } from "lucide-react";
import { getRakebackConfigs } from "@/lib/queries/rewards";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SectionHeading } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { EmptyState } from "@/components/empty-state";
import { TileErrorFallback } from "@/components/tile-error-fallback";

/**
 * Settings tab of the merged /rewards page (was /rewards/settings) — global
 * switches + rakeback configuration read-out. Streamed behind its own
 * Suspense so the hub shell paints instantly; the read is safeQuery-wrapped.
 */
export function SettingsTab() {
  return (
    <div className="space-y-3">
      <SectionHeading
        icon={Percent}
        title="Rakeback Configuration"
        action={
          <Button
            variant="outline"
            size="sm"
            nativeButton={false}
            render={<Link href="/rewards?tab=rakeback" />}
          >
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
  );
}

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
                    {(config.percentage * 100).toFixed(2)}% &middot;{" "}
                    {config.expirationDays}d expiry
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
