import { Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/utils/format";
import { cn } from "@/lib/utils";

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

// Keep these as props even though two of them are no longer rendered here —
// callers still pass them through; typed so future tweaks stay safe.
type OverviewProps = {
  deals: Deal[];
  socials: { platform: string; followerCount: number | null }[];
  availableUsd: number;
  totalPaidOutUsd: number;
};

// Chip = one compact label/value pair, rendered inline on the secondary
// meta row. Hides itself when value is empty so the row stays tight.
function Chip({ label, value, tone = "default" }: {
  label: string;
  value: string | null;
  tone?: "default" | "warn";
}) {
  if (!value) return null;
  return (
    <span className="inline-flex items-baseline gap-1 whitespace-nowrap">
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span
        className={cn(
          "text-sm font-medium tabular-nums",
          tone === "warn" && "text-orange-500",
        )}
      >
        {value}
      </span>
    </span>
  );
}

export function OverviewCard({ deals }: OverviewProps) {
  const activeDeal = deals[0] ?? null;

  return (
    <div>
      {activeDeal ? (
          <div className="flex items-start gap-3 min-w-0">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10">
              <Sparkles className="size-4 text-primary" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Active deal
              </p>
              <div className="flex items-center gap-2 flex-wrap mt-0.5">
                <span className="truncate text-base font-semibold">
                  {activeDeal.dealName ?? "Unnamed deal"}
                </span>
                <Badge variant="outline" className="text-[10px] font-medium">
                  {activeDeal.dealType}
                </Badge>
                {activeDeal.dailyFillEnabled ? (
                  <Badge
                    variant="outline"
                    className="text-[10px] font-medium bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30"
                  >
                    Auto-fill on
                  </Badge>
                ) : activeDeal.dailyFillAmount != null ? (
                  <Badge
                    variant="outline"
                    className="text-[10px] font-medium bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30"
                  >
                    Auto-fill off
                  </Badge>
                ) : null}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1.5">
                <Chip
                  label="Daily"
                  value={
                    activeDeal.dailyFillAmount != null &&
                    activeDeal.dailyFillAmount > 0
                      ? `${formatCurrency(activeDeal.dailyFillAmount)}/d`
                      : null
                  }
                />
                <Chip
                  label="Keep"
                  value={
                    activeDeal.keepPercentage != null
                      ? `${(activeDeal.keepPercentage * 100).toFixed(0)}%`
                      : null
                  }
                />
                <Chip
                  label="Cashout"
                  value={
                    activeDeal.currencyLimitAmount != null
                      ? `${formatCurrency(activeDeal.currencyLimitAmount)}${
                          activeDeal.currencyLimitResetDays
                            ? ` / ${activeDeal.currencyLimitResetDays}d`
                            : ""
                        }`
                      : null
                  }
                />
                <Chip
                  label="Tip"
                  value={
                    activeDeal.tipLimit != null
                      ? formatCurrency(activeDeal.tipLimit)
                      : null
                  }
                />
                <Chip
                  label="Exposure"
                  value={
                    activeDeal.maxFinancialExposure != null
                      ? `${formatCurrency(activeDeal.maxFinancialExposure)}/mo`
                      : null
                  }
                  tone="warn"
                />
              </div>
            </div>
          </div>
        ) : (
        <div className="flex items-center gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
            <Sparkles className="size-4 text-muted-foreground" />
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Active deal
            </p>
            <p className="text-sm text-muted-foreground">
              No active deal configured.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
