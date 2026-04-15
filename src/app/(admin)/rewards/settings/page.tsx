import Link from "next/link";
import { requirePageAccess } from "@/lib/dal";
import { getRakebackConfigs } from "@/lib/queries/rewards";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export const metadata = { title: "Rewards Settings" };

export default async function RewardsSettingsPage() {
  await requirePageAccess("/rewards/settings");
  const configs = await getRakebackConfigs();

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Rewards Settings</h1>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-sm font-medium">Rakeback Configuration</CardTitle>
          <Button variant="outline" size="sm" render={<Link href="/rewards/rakeback" />}>
            Manage
          </Button>
        </CardHeader>
        <CardContent>
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
                        ? "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30"
                        : "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30"
                    }
                  >
                    {config.enabled ? "Enabled" : "Disabled"}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
