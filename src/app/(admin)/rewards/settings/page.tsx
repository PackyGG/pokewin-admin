import Link from "next/link";
import { Settings, Percent } from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import { getRakebackConfigs } from "@/lib/queries/rewards";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHero, SectionHeading } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";

export const metadata = { title: "Rewards Settings" };

export default async function RewardsSettingsPage() {
  await requirePageAccess("/rewards/settings");
  const configs = await getRakebackConfigs();

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10">
            <Settings className="size-5 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold leading-tight">Rewards Settings</h1>
            <p className="text-sm text-muted-foreground">
              Global switches and rakeback configuration.
            </p>
          </div>
        </div>
      </PageHero>

      <div className="space-y-3">
        <SectionHeading
          icon={Percent}
          title="Rakeback Configuration"
          action={
            <Button variant="outline" size="sm" render={<Link href="/rewards/rakeback" />}>
              Manage
            </Button>
          }
        />
        <FadeIn>
          <div className="rounded-2xl border bg-card/60 p-5">
            {configs.length === 0 ? (
              <p className="text-sm text-muted-foreground">No rakeback configs found.</p>
            ) : (
              <div className="space-y-3">
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
      </div>
    </div>
  );
}
