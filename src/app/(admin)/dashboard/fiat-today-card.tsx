"use client";

import Link from "next/link";
import {
  AlertTriangle,
  CircleDollarSign,
  CreditCard,
  ShieldAlert,
  WalletCards,
} from "lucide-react";

import { AnimatedNumber } from "@/components/animated-number";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatNumber } from "@/lib/utils/format";
import type {
  DashboardFiatException,
  DashboardFiatMetrics,
} from "@/lib/queries/dashboard-fiat";

export type FiatTodayCardData = DashboardFiatMetrics;

export function FiatTodayCard({ data }: { data: FiatTodayCardData }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
          <CardTitle className="inline-flex items-center gap-1 text-card-title text-muted-foreground">
            Whop fiat payments
          </CardTitle>
          <span className="text-tiny text-muted-foreground">Today · UTC</span>
        </div>
        <CreditCard className="size-4 shrink-0 text-blue-400" />
      </CardHeader>
      <CardContent className="space-y-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Provider net paid
          </p>
          <div className="text-stat-value truncate text-emerald-400">
            <AnimatedNumber value={data.providerNetPaidUsd} format="currency" />
          </div>
          <p className="text-[11px] leading-snug text-muted-foreground">
            Whop paid_at since 00:00 UTC. Net is gross USD equivalent minus
            provider fees.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-1.5 -mx-0.5">
          <FiatChip
            icon={CircleDollarSign}
            label="Gross paid"
            value={data.providerGrossPaidUsd}
            count={`${formatNumber(data.providerPaymentCount)} provider payments`}
            tone="emerald"
          />
          <FiatChip
            icon={WalletCards}
            label="Balance credited"
            value={data.grossCreditedUsd}
            count={`${formatNumber(data.creditedPaymentCount)} completed credits`}
            tone="blue"
          />
        </div>

        {data.uncreditedExceptionCount > 0 && (
          <details className="rounded-md border border-amber-500/20 bg-amber-500/5 px-2 py-1.5">
            <summary className="cursor-pointer list-none text-[11px] font-semibold text-amber-600 dark:text-amber-400">
              <span className="inline-flex items-center gap-1">
                <AlertTriangle className="size-3 shrink-0" />
                {formatNumber(data.uncreditedExceptionCount)} paid beyond
                settlement grace ·{" "}
                <AnimatedNumber
                  value={data.uncreditedExceptionGrossUsd}
                  format="currency"
                />
              </span>
            </summary>
            <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
              Read-only alert. Refunded, disputed, canceled, staff, duplicate,
              fresh, and alternate-linked credits are excluded.
            </p>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {data.uncreditedExceptions.map((exception) => (
                <ExceptionLink
                  key={exception.intentId}
                  exception={exception}
                />
              ))}
            </div>
          </details>
        )}

        <div className="border-t border-border/50 pt-2">
          <div className="grid grid-cols-3 gap-2 text-[11px]">
            <Status
              label="Whop fees"
              value={`$${data.providerFeesUsd.toFixed(2)}`}
            />
            <Status
              label="Refunded"
              value={`$${data.refundCreditsUsd.toFixed(2)}`}
            />
            <Status label="Disputes" value={formatNumber(data.disputeCount)} />
          </div>
          {(data.partialRefundCount > 0 || data.reviewCount > 0) && (
            <p className="mt-2 flex items-start gap-1 text-[11px] leading-snug text-muted-foreground">
              <ShieldAlert className="mt-0.5 size-3 shrink-0 text-amber-400" />
              {formatNumber(data.reviewCount)} in review
              {data.partialRefundCount > 0
                ? ` · ${formatNumber(data.partialRefundCount)} partial refund${data.partialRefundCount === 1 ? "" : "s"}`
                : ""}
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

function ExceptionLink({
  exception,
}: {
  exception: DashboardFiatException;
}) {
  return (
    <Link
      href={`/transactions/card-payments/${exception.intentId}`}
      className="rounded border border-amber-500/20 bg-background/60 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-amber-700 hover:underline dark:text-amber-300"
      title={`Open exact fiat intent ${exception.intentId}`}
    >
      {exception.intentId.slice(0, 8)} · ${exception.grossPaidUsd.toFixed(2)}
    </Link>
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
  tone: "emerald" | "blue";
}) {
  const color =
    tone === "emerald"
      ? "text-emerald-600 dark:text-emerald-400"
      : "text-blue-600 dark:text-blue-400";
  const border =
    tone === "emerald" ? "border-emerald-500/15" : "border-blue-500/15";

  return (
    <div
      className={`min-w-0 rounded-md border bg-background/40 px-2 py-1.5 ${border}`}
    >
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
