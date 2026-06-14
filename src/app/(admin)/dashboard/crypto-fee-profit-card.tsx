"use client";

import { Coins, ArrowDownToLine, ArrowUpFromLine } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AnimatedNumber } from "@/components/animated-number";
import { formatCurrency } from "@/lib/utils/format";

/**
 * "Crypto fee profit" dashboard tile — the house's cumulative ALL-TIME
 * profit from the hidden crypto exchange-rate fee, as an ESTIMATE.
 *
 * This is house PROFIT (money WE keep, not paid out to a user) → emerald
 * per CLAUDE.md's House-POV rule (a dollar we make = green).
 *
 * It is explicitly an estimate: the fee is not recorded per transaction —
 * it's recorded crypto volume × the average fee-band midpoint (deposits
 * ~0.45%, withdrawals ~0.075%). The subtext says so plainly so nobody
 * reads it as an exactly-booked figure.
 *
 * All props are serializable primitives — no function props cross the RSC
 * boundary (`AnimatedNumber` takes the `format` string-enum, not a
 * formatter fn) per CLAUDE.md / Next 15.
 */
export function CryptoFeeProfitCard({
  totalFeeUsd,
  depositFeeUsd,
  withdrawalFeeUsd,
  depositBps,
  withdrawalBps,
}: {
  totalFeeUsd: number;
  depositFeeUsd: number;
  withdrawalFeeUsd: number;
  depositBps: number;
  withdrawalBps: number;
}) {
  // bps → percent for the subtext, trimmed to a clean short form
  // (45 bps → "0.45%", 7.5 bps → "0.075%").
  const depositPct = formatBpsPct(depositBps);
  const withdrawalPct = formatBpsPct(withdrawalBps);

  return (
    <Card className="bg-emerald-500/10">
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
          <CardTitle className="text-card-title text-muted-foreground">
            Crypto Fee Profit
          </CardTitle>
          <span className="text-tiny text-muted-foreground">Est. · all-time</span>
        </div>
        <Coins className="size-4 shrink-0 text-emerald-400" />
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Total — house profit, so emerald (House-POV: a dollar we make). */}
        <div className="text-stat-value truncate text-emerald-600 dark:text-emerald-300">
          <AnimatedNumber value={totalFeeUsd} format="currency" />
        </div>
        <p className="text-tiny text-muted-foreground">
          Est. from avg fee rate (~{depositPct} deposits · ~{withdrawalPct}{" "}
          withdrawals)
        </p>
        {/* Deposit / withdrawal split — the deposit leg dominates. */}
        <div className="grid grid-cols-2 gap-1.5 -mx-0.5">
          <FeeChip
            icon={ArrowDownToLine}
            label="Deposits"
            value={depositFeeUsd}
          />
          <FeeChip
            icon={ArrowUpFromLine}
            label="Withdrawals"
            value={withdrawalFeeUsd}
          />
        </div>
      </CardContent>
    </Card>
  );
}

/** One leg of the deposit/withdrawal split — emerald (house profit). */
function FeeChip({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Coins;
  label: string;
  value: number;
}) {
  return (
    <div className="rounded-md border border-emerald-500/15 bg-background/40 px-2 py-1.5 min-w-0">
      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground truncate flex items-center gap-1">
        <Icon className="size-2.5 shrink-0 opacity-70" />
        {label}
      </p>
      <p className="text-xs font-semibold tabular-nums truncate text-emerald-600 dark:text-emerald-400">
        {formatCurrency(value)}
      </p>
    </div>
  );
}

/**
 * Muted "not available" variant — rendered when the connected DB is missing
 * a required crypto column (host swap / schema drift). Keeps the card slot
 * filled without implying a real $0 of fee profit.
 */
export function CryptoFeeProfitUnavailableCard() {
  return (
    <Card className="bg-muted/20">
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
        <CardTitle className="text-card-title text-muted-foreground">
          Crypto Fee Profit
        </CardTitle>
        <Coins className="size-4 shrink-0 text-muted-foreground/60" />
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="text-stat-value truncate text-muted-foreground/70">—</div>
        <p className="text-tiny text-muted-foreground">
          Crypto fee data not available on this database.
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * bps → trimmed percent string. 45 → "0.45%", 7.5 → "0.075%", 50 → "0.5%".
 * Up to 3 decimals, trailing zeros stripped.
 */
function formatBpsPct(bps: number): string {
  const pct = bps / 100;
  // toFixed(3) then strip trailing zeros / dangling dot.
  const s = pct.toFixed(3).replace(/\.?0+$/, "");
  return `${s}%`;
}
