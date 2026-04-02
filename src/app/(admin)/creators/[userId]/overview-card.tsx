import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatNumber } from "@/lib/utils/format";

type Deal = {
  id: string;
  dealName: string | null;
  dealType: string;
  status: string;
  dailyFillAmount: number | null;
  dailyFillEnabled: boolean;
  keepPercentage: number | null;
  currencyLimitAmount: number | null;
  currencyLimitResetDays: number | null;
  percentageLimit: number | null;
  tipLimit: number | null;
  tipLimitResetDays: number | null;
  maxFinancialExposure: number | null;
};

type Social = {
  platform: string;
  followerCount: number | null;
};

type OverviewProps = {
  deals: Deal[];
  socials: Social[];
  availableUsd: number;
  totalPaidOutUsd: number;
};

const PLATFORM_LABELS: Record<string, string> = {
  twitter: "X",
  youtube: "YT",
  kick: "Kick",
  discord: "DC",
  instagram: "IG",
};

export function OverviewCard({ deals, socials, availableUsd, totalPaidOutUsd }: OverviewProps) {
  const activeDeal = deals[0] ?? null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-card-title">Creator Overview</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {/* Active Deal */}
          <div>
            <p className="text-stat-label">Active Deal</p>
            {activeDeal ? (
              <>
                <p className="text-sm font-semibold">{activeDeal.dealName ?? activeDeal.dealType}</p>
                {activeDeal.dailyFillAmount != null && activeDeal.dailyFillAmount > 0 && (
                  <p className="text-stat-label">
                    {formatCurrency(activeDeal.dailyFillAmount)}/day
                    {activeDeal.keepPercentage != null && ` · ${(activeDeal.keepPercentage * 100).toFixed(0)}% keep`}
                  </p>
                )}
              </>
            ) : (
              <p className="text-sm text-muted-foreground">No active deal</p>
            )}
          </div>

          {/* Fill Status */}
          <div>
            <p className="text-stat-label">Daily Fill</p>
            {activeDeal?.dailyFillEnabled ? (
              <Badge variant="outline" className="mt-1 bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30">
                Active — {formatCurrency(activeDeal.dailyFillAmount ?? 0)}/day
              </Badge>
            ) : activeDeal?.dailyFillAmount != null ? (
              <Badge variant="outline" className="mt-1 bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30">
                Configured but disabled
              </Badge>
            ) : (
              <p className="text-sm text-muted-foreground">Not configured</p>
            )}
          </div>

          {/* Financial Exposure */}
          <div>
            <p className="text-stat-label">Max Exposure / Month</p>
            {activeDeal?.maxFinancialExposure != null ? (
              <p className="text-stat-value text-orange-500">
                {formatCurrency(activeDeal.maxFinancialExposure)}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">—</p>
            )}
          </div>

          {/* Cashout Limits */}
          <div>
            <p className="text-stat-label">Withdrawal Limits</p>
            {activeDeal?.currencyLimitAmount != null ? (
              <div className="text-sm">
                <p>{formatCurrency(activeDeal.currencyLimitAmount)}{activeDeal.currencyLimitResetDays ? ` / ${activeDeal.currencyLimitResetDays}d` : ""}</p>
                {activeDeal.percentageLimit != null && (
                  <p>{(activeDeal.percentageLimit * 100).toFixed(2)}%</p>
                )}
                {activeDeal.tipLimit != null && (
                  <p>Tip: {formatCurrency(activeDeal.tipLimit)}</p>
                )}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No limits set</p>
            )}
          </div>

          {/* Balance */}
          <div>
            <p className="text-stat-label">Available Balance</p>
            <p className="text-stat-value">{formatCurrency(availableUsd)}</p>
          </div>

          {/* Total Paid Out */}
          <div>
            <p className="text-stat-label">Total Paid Out</p>
            <p className="text-stat-value">{formatCurrency(totalPaidOutUsd)}</p>
          </div>

          {/* Socials Summary */}
          <div className="sm:col-span-2">
            <p className="text-stat-label">Social Reach</p>
            {socials.length > 0 ? (
              <div className="mt-1 flex flex-wrap gap-2">
                {socials.map((s) => (
                  <Badge key={s.platform} variant="outline" className="text-xs">
                    {PLATFORM_LABELS[s.platform] ?? s.platform}
                    {s.followerCount != null && `: ${formatNumber(s.followerCount)}`}
                  </Badge>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No socials connected</p>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
