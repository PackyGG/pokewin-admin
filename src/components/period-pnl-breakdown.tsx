import Link from "next/link";
import { type ElementType } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Wallet,
  Box,
  Ticket,
  CloudRain,
  Coins,
  Trophy,
  Gift,
  Sparkles,
  HandCoins,
  Megaphone,
  Award,
  Banknote,
  Swords,
  TrendingUp,
  ArrowRight,
} from "lucide-react";
import { formatCurrency } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import type {
  PnlBreakdownWindows,
  PnlBreakdownRow,
} from "@/lib/queries/pnl";

/**
 * Period P&L breakdown for Analytics → Overview.
 *
 * Per-window (24h / 3d / 7d) decomposition of the house P&L. Top rows
 * are the canonical formula components that SUM to the total:
 *   pnl = deposits − withdrawals − balanceΔ − inventoryΔ − voucherΔ
 * Below those, an informational "Where the money went" section shows
 * how much was paid out via each major surface (rain, creators, race,
 * leaderboards, rakeback, affiliate, gift/promo, bonuses, card sales,
 * battle refunds). The payout rows are subsets of balanceΔ and don't
 * add to the total — they exist so admins can see WHERE the balance
 * change came from at a glance.
 *
 * Every cell shows a signed CONTRIBUTION to house P&L. Color is
 * derived from the value (positive → emerald, negative → rose) per
 * the House-POV convention in CLAUDE.md, so a shrinking liability
 * reads emerald even though the underlying delta is negative.
 */

type RowDef = {
  label: string;
  description: string;
  /** Signed contribution to house P&L (positive = house +). */
  contribution: (b: PnlBreakdownRow) => number;
  icon: ElementType;
  /** Static accent for the icon chip — informational only; the cell
   *  values get their House-POV color from the actual signed value. */
  accent: "emerald" | "rose" | "neutral";
  href?: string;
};

const FORMULA_ROWS: RowDef[] = [
  {
    label: "Deposits",
    description: "Completed real-money deposits credited in window",
    contribution: (b) => b.deposits,
    icon: ArrowDownToLine,
    accent: "emerald",
    href: "/transactions/deposits",
  },
  {
    label: "Withdrawals",
    description: "Card withdrawals shipped/completed + manual",
    contribution: (b) => -b.withdrawals,
    icon: ArrowUpFromLine,
    accent: "rose",
    href: "/withdrawals",
  },
  {
    label: "User Balance change",
    description: "Net change in user available + locked balance",
    contribution: (b) => -b.balanceDelta,
    icon: Wallet,
    accent: "neutral",
    href: "/users?sortBy=balance&sortOrder=desc",
  },
  {
    label: "Inventory change",
    description: "Cards obtained minus cards sold/exchanged",
    contribution: (b) => -b.inventoryDelta,
    icon: Box,
    accent: "neutral",
    href: "/users?sortBy=inventoryValue&sortOrder=desc",
  },
  {
    label: "Voucher change",
    description: "Vouchers issued minus vouchers claimed",
    contribution: (b) => -b.voucherDelta,
    icon: Ticket,
    accent: "neutral",
    href: "/vouchers",
  },
];

const PAYOUT_ROWS: RowDef[] = [
  {
    label: "Rain Prizes",
    description: "rain_win credits paid to users",
    contribution: (b) => -b.rainPrizes,
    icon: CloudRain,
    accent: "rose",
    href: "/rain",
  },
  {
    label: "Creator Tips",
    description: "creator_tip credits received by users",
    contribution: (b) => -b.creatorTips,
    icon: HandCoins,
    accent: "rose",
  },
  {
    label: "Race Prizes",
    description: "race_prize credits",
    contribution: (b) => -b.racePrizes,
    icon: Trophy,
    accent: "rose",
  },
  {
    label: "Leaderboard Prizes",
    description: "affiliate_leaderboard_prize credits",
    contribution: (b) => -b.leaderboardPrizes,
    icon: Award,
    accent: "rose",
    href: "/creators/leaderboards",
  },
  {
    label: "Rakeback Claims",
    description: "rakeback_claim credits",
    contribution: (b) => -b.rakebackClaims,
    icon: Coins,
    accent: "rose",
    href: "/rewards?tab=rakeback",
  },
  {
    label: "Affiliate Claims",
    description: "affiliate_claim credits",
    contribution: (b) => -b.affiliateClaims,
    icon: Megaphone,
    accent: "rose",
  },
  {
    label: "Gift / Promo / Voucher",
    description: "gift_card / promo_code / voucher_redeemed credits",
    contribution: (b) => -b.giftPromoVoucher,
    icon: Gift,
    accent: "rose",
  },
  {
    label: "Bonuses",
    description: "deposit_bonus + balance_reward + waitlist_prize",
    contribution: (b) => -b.bonuses,
    icon: Sparkles,
    accent: "rose",
  },
  {
    label: "Card Sales / Exchanges",
    description: "card_sale + card_exchange + voucher_exchange credits",
    contribution: (b) => -b.cardSalesExchanges,
    icon: Banknote,
    accent: "rose",
  },
  {
    label: "Battle Refunds / Excess",
    description: "battle_refund + battle/exchange excess credits",
    contribution: (b) => -b.battleRefundsExcess,
    icon: Swords,
    accent: "rose",
  },
  {
    label: "Upgrader Payouts",
    description: "upgrader_payout credits paid to winners",
    contribution: (b) => -b.upgraderPayouts,
    icon: TrendingUp,
    accent: "rose",
  },
];

const WINDOWS = [
  { key: "h24", label: "Past 24h" },
  { key: "d3", label: "Past 3d" },
  { key: "d7", label: "Past 7d" },
] as const;

export function PeriodPnlBreakdown({ data }: { data: PnlBreakdownWindows }) {
  return (
    <div className="rounded-2xl border bg-gradient-to-br from-card via-card to-card/80 p-4 sm:p-5">
      <div className="mb-4">
        <h3 className="text-base font-semibold leading-tight">
          Period P&amp;L
        </h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          House P&amp;L over the last 24h, 3 days, and 7 days. Formula
          rows sum to the total; the payout rows below are informational —
          they show where the balance change came from.
        </p>
      </div>

      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-3 py-2 text-left text-xs font-medium">
                Category
              </th>
              {WINDOWS.map((w) => (
                <th
                  key={w.key}
                  className="px-3 py-2 text-right text-xs font-medium"
                >
                  {w.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {/* Total — sum of the formula rows below. */}
            <tr className="border-b bg-muted/30 font-semibold">
              <td className="px-3 py-2.5">Total P&amp;L (House)</td>
              {WINDOWS.map((w) => (
                <AmountCell key={w.key} value={data[w.key].total} bold />
              ))}
            </tr>
            {/* Formula components. */}
            {FORMULA_ROWS.map((row) => (
              <BreakdownRow key={row.label} row={row} data={data} />
            ))}
            {/* Section divider. */}
            <tr>
              <td
                colSpan={WINDOWS.length + 1}
                className="bg-muted/40 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
              >
                Where the money went · informational
              </td>
            </tr>
            {PAYOUT_ROWS.map((row) => (
              <BreakdownRow key={row.label} row={row} data={data} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function BreakdownRow({
  row,
  data,
}: {
  row: RowDef;
  data: PnlBreakdownWindows;
}) {
  const Icon = row.icon;
  const iconColor =
    row.accent === "emerald"
      ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
      : row.accent === "rose"
        ? "bg-rose-500/10 text-rose-600 dark:text-rose-400"
        : "bg-muted text-muted-foreground";

  const label = (
    <div className="flex items-center gap-2">
      <span
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-md",
          iconColor,
        )}
      >
        <Icon className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium leading-tight">
          {row.label}
        </p>
        <p className="truncate text-[11px] text-muted-foreground">
          {row.description}
        </p>
      </div>
      {row.href && (
        <ArrowRight className="size-3.5 shrink-0 text-muted-foreground opacity-40 transition-opacity group-hover:opacity-80" />
      )}
    </div>
  );

  return (
    <tr className="group border-b last:border-b-0 hover:bg-muted/30">
      <td className="px-3 py-2 align-middle">
        {row.href ? (
          <Link href={row.href} className="block">
            {label}
          </Link>
        ) : (
          label
        )}
      </td>
      {WINDOWS.map((w) => (
        <AmountCell key={w.key} value={row.contribution(data[w.key])} />
      ))}
    </tr>
  );
}

function AmountCell({ value, bold }: { value: number; bold?: boolean }) {
  // House-POV color: positive contribution (house gained / liability
  // shrank) = emerald, negative (house paid / liability grew) = rose.
  const positive = value >= 0;
  const sign = positive ? "+" : "−";
  return (
    <td
      className={cn(
        "px-3 py-2 text-right tabular-nums",
        bold && "py-2.5 font-semibold",
        positive
          ? "text-emerald-600 dark:text-emerald-400"
          : "text-rose-600 dark:text-rose-400",
      )}
    >
      {sign}
      {formatCurrency(Math.abs(value))}
    </td>
  );
}
