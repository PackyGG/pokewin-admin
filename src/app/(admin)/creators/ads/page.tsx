import Link from "next/link";
import {
  ArrowDownToLine,
  Coins,
  Megaphone,
  MousePointerClick,
  Percent,
  UserPlus,
  Users,
} from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import { KpiTile, PageHero } from "@/components/modern-panels";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import {
  SETTINGS_KEYS,
  getAdminSetting,
} from "@/lib/admin-settings";
import {
  getAdCodes,
  getAdCodesAggregate,
  getHouseUserInfo,
} from "@/lib/queries/ads";
import { AdsList, CreateAdCodeButton } from "./ads-list";
import { HouseAccountSetup } from "./house-setup";

export const metadata = { title: "Ads" };

export default async function AdsPage() {
  await requirePageAccess("/creators/ads");

  const houseUserId = await getAdminSetting(SETTINGS_KEYS.HOUSE_AFFILIATE_USER_ID);

  if (!houseUserId) {
    return <HouseAccountSetup />;
  }

  // Fetch house user info alongside the list + aggregate so we can
  // either render the dashboard or, if the configured user was deleted,
  // drop back to the setup view with a warning.
  const [houseUser, codes, aggregate] = await Promise.all([
    getHouseUserInfo(houseUserId),
    getAdCodes(houseUserId),
    getAdCodesAggregate(houseUserId),
  ]);

  if (!houseUser) {
    return (
      <div className="space-y-6">
        <HouseAccountSetup />
      </div>
    );
  }

  const conversion =
    aggregate.totalClicks > 0
      ? aggregate.totalSignups / aggregate.totalClicks
      : 0;

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10">
              <Megaphone className="size-5 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-bold leading-tight">Ads</h1>
              <p className="text-sm text-muted-foreground">
                Campaign tracking codes. Clicks, signups and deposits roll up
                through the{" "}
                <Link
                  href={`/users/${houseUser.id}`}
                  className="font-medium text-foreground hover:underline"
                >
                  {houseUser.username ?? houseUser.email ?? "house user"}
                </Link>{" "}
                account.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge
              variant="outline"
              className="bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30"
            >
              House: {houseUser.username ?? houseUser.email ?? houseUser.id.slice(0, 8)}
            </Badge>
            <CreateAdCodeButton />
          </div>
        </div>
      </PageHero>

      {/* Aggregate KPI strip */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <KpiTile
          label="Codes"
          value={formatNumber(aggregate.totalCodes)}
          icon={Megaphone}
          accent="purple"
        />
        <KpiTile
          label="Total Clicks"
          value={formatNumber(aggregate.totalClicks)}
          icon={MousePointerClick}
          accent="blue"
        />
        <KpiTile
          label="Signups"
          value={formatNumber(aggregate.totalSignups)}
          icon={UserPlus}
          accent="cyan"
        />
        <KpiTile
          label="Depositors"
          value={formatNumber(aggregate.totalDepositors)}
          icon={Users}
          accent="emerald"
        />
        <KpiTile
          label="Deposits"
          value={formatCurrency(aggregate.totalDepositVolumeUsd)}
          icon={ArrowDownToLine}
          accent="amber"
        />
        <KpiTile
          label="Wagers"
          value={formatCurrency(aggregate.totalWagerVolumeUsd)}
          icon={Coins}
          accent="pink"
        />
      </div>

      {/* Secondary stat — conversion summary */}
      <div className="rounded-2xl border bg-card/60 px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex size-8 items-center justify-center rounded-lg bg-primary/10">
              <Percent className="size-4 text-primary" />
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Click → Signup Conversion
              </p>
              <p className="mt-0.5 text-lg font-bold tabular-nums">
                {aggregate.totalClicks > 0
                  ? `${(conversion * 100).toFixed(2)}%`
                  : "—"}
              </p>
            </div>
          </div>
          <p className="text-xs text-muted-foreground max-w-md text-right">
            Of{" "}
            <span className="font-medium text-foreground">
              {formatNumber(aggregate.totalClicks)}
            </span>{" "}
            tracked clicks,{" "}
            <span className="font-medium text-foreground">
              {formatNumber(aggregate.totalSignups)}
            </span>{" "}
            finished signup and{" "}
            <span className="font-medium text-foreground">
              {formatNumber(aggregate.totalDepositors)}
            </span>{" "}
            went on to deposit.
          </p>
        </div>
      </div>

      <AdsList codes={codes} />
    </div>
  );
}
