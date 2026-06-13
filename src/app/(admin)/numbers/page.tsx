import {
  Hash,
  Mail,
  MessageCircle,
  Globe,
  Gamepad2,
  Users,
  type LucideIcon,
} from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import { getSignupMethodStats, type SignupMethodKey } from "@/lib/queries/signup-methods";
import { getPackMaxWinStats } from "@/lib/queries/pack-max-wins";
import { PackMaxWinsSection } from "./pack-max-wins-section";
import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
  KpiTile,
  type AccentColor,
} from "@/components/modern-panels";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatNumber } from "@/lib/utils/format";
import { cn } from "@/lib/utils";

export const metadata = { title: "Numbers" };

const PRIMARY_METHODS: SignupMethodKey[] = [
  "email",
  "discord",
  "google",
  "steam",
];

const METHOD_ACCENTS: Record<SignupMethodKey, AccentColor> = {
  email: "blue",
  discord: "purple",
  google: "amber",
  steam: "cyan",
  unknown: "orange",
  other: "pink",
};

const METHOD_ICONS: Record<SignupMethodKey, LucideIcon> = {
  email: Mail,
  discord: MessageCircle,
  google: Globe,
  steam: Gamepad2,
  unknown: Users,
  other: Users,
};

function formatShare(share: number): string {
  return `${(share * 100).toFixed(1)}%`;
}

export default async function NumbersPage() {
  await requirePageAccess("/numbers");
  const [stats, packMaxWins] = await Promise.all([
    getSignupMethodStats(),
    getPackMaxWinStats(),
  ]);
  const primaryRows = stats.methods.filter((row) =>
    PRIMARY_METHODS.includes(row.key),
  );
  const tailRows = stats.methods.filter(
    (row) => !PRIMARY_METHODS.includes(row.key) && row.count > 0,
  );

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Hash}
          title="Numbers"
          subtitle="Signup methods and pack max-win multipliers — quick catalog stats without leaving Overview."
        />
      </PageHero>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <KpiTile
          label="Total Users"
          value={formatNumber(stats.totalUsers)}
          icon={Users}
          accent="emerald"
        />
        {primaryRows.map((row) => (
          <KpiTile
            key={row.key}
            label={row.label}
            value={formatNumber(row.count)}
            sub={formatShare(row.share)}
            icon={METHOD_ICONS[row.key]}
            accent={METHOD_ACCENTS[row.key]}
          />
        ))}
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-2">
        <section className="space-y-4">
          <SectionHeading icon={Hash} title="Signup method breakdown" />
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">
                All-time distribution
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {stats.methods
                .filter((row) => row.count > 0)
                .map((row) => (
                  <div key={row.key} className="space-y-1.5">
                    <div className="flex items-center justify-between gap-3 text-sm">
                      <div className="flex min-w-0 items-center gap-2 font-medium">
                        {(() => {
                          const Icon = METHOD_ICONS[row.key];
                          return (
                            <Icon className="size-4 shrink-0 text-muted-foreground" />
                          );
                        })()}
                        <span className="truncate">{row.label}</span>
                      </div>
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        {formatNumber(row.count)} · {formatShare(row.share)}
                      </span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-muted">
                      <div
                        className={cn(
                          "h-full rounded-full transition-all",
                          row.key === "email" && "bg-blue-500",
                          row.key === "discord" && "bg-purple-500",
                          row.key === "google" && "bg-amber-500",
                          row.key === "steam" && "bg-cyan-500",
                          row.key === "unknown" && "bg-orange-500",
                          row.key === "other" && "bg-pink-500",
                        )}
                        style={{ width: `${Math.max(row.share * 100, row.count > 0 ? 2 : 0)}%` }}
                      />
                    </div>
                  </div>
                ))}
            </CardContent>
          </Card>

          {tailRows.length > 0 && (
            <div className="space-y-3">
              <SectionHeading icon={Users} title="Other buckets" />
              <div className="grid gap-3 sm:grid-cols-2">
                {tailRows.map((row) => (
                  <KpiTile
                    key={row.key}
                    label={row.label}
                    value={formatNumber(row.count)}
                    sub={formatShare(row.share)}
                    icon={METHOD_ICONS[row.key]}
                    accent={METHOD_ACCENTS[row.key]}
                  />
                ))}
              </div>
            </div>
          )}

          {stats.otherBreakdown.length > 0 && (
            <div className="space-y-3">
              <SectionHeading icon={Hash} title="Other provider IDs" />
              <Card>
                <CardContent className="pt-6">
                  <div className="divide-y">
                    {stats.otherBreakdown.map((row) => (
                      <div
                        key={row.provider}
                        className="flex items-center justify-between py-3 text-sm"
                      >
                        <span className="font-mono">{row.provider}</span>
                        <span className="tabular-nums text-muted-foreground">
                          {formatNumber(row.count)}
                        </span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </div>
          )}
        </section>

        <PackMaxWinsSection stats={packMaxWins} />
      </div>
    </div>
  );
}
