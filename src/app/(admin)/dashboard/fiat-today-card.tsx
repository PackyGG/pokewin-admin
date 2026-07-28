"use client";

import {
  CreditCard,
  RotateCcw,
  ShieldAlert,
  CircleDollarSign,
} from "lucide-react";

import { AnimatedNumber } from "@/components/animated-number";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatNumber } from "@/lib/utils/format";

export type FiatTodayCardData = {
  grossCreditedUsd: number;
  refundCreditsUsd: number;
  netCreditedUsd: number;
  providerFeesUsd: number;
  paymentCount: number;
  refundCount: number;
  partialRefundCount: number;
  unresolvedPartialRefundCount: number;
  reviewCount: number;
  disputeCount: number;
};

export function FiatTodayCard({ data }: { data: FiatTodayCardData }) {
  const netPositive = data.netCreditedUsd >= 0;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
          <CardTitle className="inline-flex items-center gap-1 text-card-title text-muted-foreground">
            Fiat payments
          </CardTitle>
          <span className="text-tiny text-muted-foreground">Today</span>
        </div>
        <CreditCard className="size-4 shrink-0 text-blue-400" />
      </CardHeader>
      <CardContent className="space-y-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Net credited
          </p>
          <div
            className={
              netPositive
                ? "text-stat-value truncate text-emerald-400"
                : "text-stat-value truncate text-rose-400"
            }
          >
            {netPositive ? "+" : "−"}
            <AnimatedNumber
              value={Math.abs(data.netCreditedUsd)}
              format="currency"
            />
          </div>
          <p className="text-[11px] leading-snug text-muted-foreground">
            Gross credits minus refunds processed today.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-1.5 -mx-0.5">
          <FiatChip
            icon={CircleDollarSign}
            label="Paid"
            value={data.grossCreditedUsd}
            count={`${formatNumber(data.paymentCount)} payments`}
            tone="emerald"
          />
          <FiatChip
            icon={RotateCcw}
            label="Refunded"
            value={data.refundCreditsUsd}
            count={`${formatNumber(data.refundCount)} refunds`}
            tone="rose"
          />
        </div>

        <div className="border-t border-border/50 pt-2">
          <div className="grid grid-cols-3 gap-2 text-[11px]">
            <Status label="Fees" value={`$${data.providerFeesUsd.toFixed(2)}`} />
            <Status label="Review" value={formatNumber(data.reviewCount)} />
            <Status label="Disputes" value={formatNumber(data.disputeCount)} />
          </div>
          {data.partialRefundCount > 0 && (
            <p className="mt-2 flex items-start gap-1 text-[11px] leading-snug text-muted-foreground">
              <ShieldAlert className="mt-0.5 size-3 shrink-0 text-amber-400" />
              {formatNumber(data.partialRefundCount)} partial refund
              {data.partialRefundCount === 1 ? "" : "s"}
              {data.unresolvedPartialRefundCount > 0
                ? ` · ${formatNumber(data.unresolvedPartialRefundCount)} missing an amount`
                : ""}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function FiatChip({
  icon: Icon,
  label,
  value,
  count,
  tone,
}: {
  icon: typeof CreditCard;
  label: string;
  value: number;
  count: string;
  tone: "emerald" | "rose";
}) {
  const color =
    tone === "emerald"
      ? "text-emerald-600 dark:text-emerald-400"
      : "text-rose-600 dark:text-rose-400";
  const border =
    tone === "emerald" ? "border-emerald-500/15" : "border-rose-500/15";

  return (
    <div className={`min-w-0 rounded-md border bg-background/40 px-2 py-1.5 ${border}`}>
      <p className="flex items-center gap-1 truncate text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        <Icon className={`size-3 shrink-0 ${color}`} />
        {label}
      </p>
      <p className={`truncate text-[13px] font-semibold tabular-nums ${color}`}>
        <AnimatedNumber value={value} format="currency" />
      </p>
      <p className="truncate text-[11px] text-muted-foreground">{count}</p>
    </div>
  );
}

function Status({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="truncate text-muted-foreground">{label}</p>
      <p className="truncate font-semibold tabular-nums text-foreground">
        {value}
      </p>
    </div>
  );
}
