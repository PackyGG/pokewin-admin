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
import { Badge } from "@/components/ui/badge";
import { KpiTile, SectionHeading } from "@/components/modern-panels";
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
import { HubAdsList, HubCreateAdCodeButton } from "./hub-ads-list";
import { HubHouseAccountSetup } from "./hub-house-setup";

export async function AdsTabContent() {
  const houseUserId = await getAdminSetting(SETTINGS_KEYS.HOUSE_AFFILIATE_USER_ID);

  if (!houseUserId) {
    return <HubHouseAccountSetup />;
  }

  const [houseUser, codes, aggregate] = await Promise.all([
    getHouseUserInfo(houseUserId),
    getAdCodes(houseUserId),
    getAdCodesAggregate(houseUserId),
  ]);

  if (!houseUser) {
    return <HubHouseAccountSetup />;
  }

  const conversion =
    aggregate.totalClicks > 0
      ? aggregate.totalSignups / aggregate.totalClicks
      : 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Badge
          variant="outline"
          className="bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30"
        >
          House: {houseUser.username ?? houseUser.email ?? houseUser.id.slice(0, 8)}
        </Badge>
        <HubCreateAdCodeButton />
      </div>

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
          sub={`${formatNumber(aggregate.totalActiveReferrals)} active`}
          icon={UserPlus}
          accent="cyan"
        />
        <KpiTile
          label="Depositors"
          value={formatNumber(aggregate.totalDepositors)}
          sub={`${formatNumber(aggregate.totalDepositEventCount)} deposits`}
          icon={Users}
          accent="emerald"
        />
        <KpiTile
          label="Deposits"
          value={formatCurrency(aggregate.totalDepositVolumeUsd)}
          sub={`FTD ${formatCurrency(aggregate.totalFtdVolumeUsd)}`}
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
            Campaign codes roll up through the{" "}
            <Link
              href={`/users/${houseUser.id}`}
              className="font-medium text-foreground hover:underline"
            >
              {houseUser.username ?? houseUser.email ?? "house user"}
            </Link>{" "}
            account. Of{" "}
            <span className="font-medium text-foreground">
              {formatNumber(aggregate.totalClicks)}
            </span>{" "}
            tracked clicks,{" "}
            <span className="font-medium text-foreground">
              {formatNumber(aggregate.totalSignups)}
            </span>{" "}
            finished signup.
          </p>
        </div>
      </div>

      <div className="space-y-3">
        <SectionHeading icon={Megaphone} title="Campaign Codes" />
        <HubAdsList codes={codes} />
      </div>
    </div>
  );
}
