import { BarChart3, CircleDollarSign, Coins, ShieldAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type {
  EosTestOverview,
  EosTestOverviewPeriod,
} from "@/lib/antifraud/eos-test-config-api";
import { cn } from "@/lib/utils";

const PERIOD_LABELS: Record<EosTestOverviewPeriod["period"], string> = {
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
};

function formatAmount(value: number, currency: EosTestOverviewPeriod["currency"]) {
  const normalized = Object.is(value, -0) ? 0 : value;
  const amount = new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
    signDisplay: "exceptZero",
  }).format(normalized);
  return `${amount} ${currency === "real" ? "real" : "coin"}`;
}

function formatRate(part: number, total: number) {
  if (total === 0) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(part / total);
}

function PeriodCard({ data }: { data: EosTestOverviewPeriod | undefined }) {
  if (!data) return null;
  const impact = data.estimatedCreatorProfitReduction;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>{PERIOD_LABELS[data.period]}</CardTitle>
          <Badge variant="outline">{data.steeredBattles} controlled</Badge>
        </div>
        <CardDescription>Compared with the original random block</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-xl border bg-muted/35 p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Estimated control impact
          </p>
          <p className={cn(
            "mt-1 text-2xl font-bold tabular-nums",
            impact > 0 && "text-emerald-600 dark:text-emerald-400",
            impact < 0 && "text-destructive",
          )}>
            {formatAmount(impact, data.currency)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Creator P&amp;L reduction; positive means the selected result paid the creator less.
          </p>
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
          <div>
            <dt className="text-xs text-muted-foreground">Creator wins avoided</dt>
            <dd className="font-semibold tabular-nums">{data.creatorWinsAvoided}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Selected loss rate</dt>
            <dd className="font-semibold tabular-nums">
              {formatRate(data.selectedLosses, data.steeredBattles)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Matched controls</dt>
            <dd className="font-semibold tabular-nums">{data.matchedBattles}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Fallback rate</dt>
            <dd className="font-semibold tabular-nums">
              {formatRate(data.fallbackBattles, data.steeredBattles)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Force-loss battles</dt>
            <dd className="font-semibold tabular-nums">{data.forceLossBattles}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">All audited battles</dt>
            <dd className="font-semibold tabular-nums">{data.battleCount}</dd>
          </div>
        </dl>

        <div className="space-y-2 border-t pt-3 text-xs">
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">Random baseline creator P&amp;L</span>
            <span className="font-medium tabular-nums">
              {formatAmount(data.randomBaselineCreatorProfitLoss, data.currency)}
            </span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">Selected creator P&amp;L</span>
            <span className="font-medium tabular-nums">
              {formatAmount(data.selectedCreatorProfitLoss, data.currency)}
            </span>
          </div>
          {data.fallbackBattles > 0 && (
            <div className="flex justify-between gap-3 text-amber-700 dark:text-amber-400">
              <span>Unavailable fallbacks</span>
              <span className="font-medium tabular-nums">
                Outcome {data.targetUnavailableBattles} · Range {data.rangeUnavailableBattles}
              </span>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function CurrencyOverview({
  overview,
  currency,
}: {
  overview: EosTestOverview;
  currency: EosTestOverviewPeriod["currency"];
}) {
  const periods = overview.periods.filter((period) => period.currency === currency);
  if (periods.every((period) => period.steeredBattles === 0)) {
    return (
      <Card>
        <CardContent className="flex min-h-48 flex-col items-center justify-center gap-2 text-center">
          <BarChart3 className="size-8 text-muted-foreground" />
          <p className="font-medium">No controlled {currency} battles tracked yet</p>
          <p className="max-w-md text-sm text-muted-foreground">
            This overview fills automatically when an enabled EOS global or per-user control
            selects a battle result.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid gap-4 xl:grid-cols-3">
      {(["24h", "7d", "30d"] as const).map((period) => (
        <PeriodCard
          key={period}
          data={periods.find((entry) => entry.period === period)}
        />
      ))}
    </div>
  );
}

export function EosOverview({ overview }: { overview: EosTestOverview | null }) {
  if (!overview) {
    return (
      <Card>
        <CardContent className="flex min-h-48 flex-col items-center justify-center gap-2 text-center">
          <ShieldAlert className="size-8 text-amber-600 dark:text-amber-400" />
          <p className="font-medium">Overview is temporarily unavailable</p>
          <p className="max-w-md text-sm text-muted-foreground">
            Global and per-user controls are still connected. Reload this page to retry the
            impact report.
          </p>
        </CardContent>
      </Card>
    );
  }

  const trackingDate = overview.trackingStartedAt
    ? new Intl.DateTimeFormat("en-GB", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Europe/Berlin",
    }).format(new Date(overview.trackingStartedAt))
    : null;

  return (
    <div className="space-y-4">
      <div className="flex gap-3 rounded-xl border border-amber-500/25 bg-amber-500/5 p-4 text-sm">
        <ShieldAlert className="mt-0.5 size-5 shrink-0 text-amber-600 dark:text-amber-400" />
        <div>
          <p className="font-medium">Creator-side estimate, not booked revenue</p>
          <p className="mt-1 text-muted-foreground">
            Impact compares the selected creator P&amp;L with the exact original random EOS block.
            It is not canonical house GGR and does not include opponent transfers or refunds.
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {trackingDate ? `Data available since ${trackingDate} (Berlin time)` : "Waiting for the first audited battle"}
            {" · "}30-day audit retention
          </p>
        </div>
      </div>

      <Tabs defaultValue="real" className="gap-4">
        <TabsList>
          <TabsTrigger value="real">
            <CircleDollarSign className="size-4" />Real balance
          </TabsTrigger>
          <TabsTrigger value="coin">
            <Coins className="size-4" />Coins
          </TabsTrigger>
        </TabsList>
        <TabsContent value="real">
          <CurrencyOverview overview={overview} currency="real" />
        </TabsContent>
        <TabsContent value="coin">
          <CurrencyOverview overview={overview} currency="coin" />
        </TabsContent>
      </Tabs>
    </div>
  );
}
