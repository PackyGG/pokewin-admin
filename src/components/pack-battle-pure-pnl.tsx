import { Package, Swords, Sigma } from "lucide-react";
import { formatCurrency } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import type {
  PackBattlePnlWindows,
  PackBattlePnlRow,
} from "@/lib/queries/pnl";

/**
 * Pack & Battle Pure P&L panel for Analytics → Overview.
 *
 * Shows the raw gameplay outcome for packs and battles ONLY — no
 * upgrader, no bonuses, no rakeback, no rain / race / leaderboard /
 * affiliate / creator-tip payouts. Just:
 *
 *   wager_in (pack_opening + battle_bet + battle_sponsorship)
 *   − payout_out (user_inventory rows source_type IN ('pack','battle')
 *                 + |battle_excess_to_voucher| + |battle_refund| — the
 *                 ledger gaming-payout legs of a battle win)
 *   = pure P&L
 *
 * Per-window columns (24h / 3d / 7d) so admins can read how the raw
 * gambling margin is trending without the reward surfaces polluting
 * the number.
 *
 * House-POV color: positive contribution (house gained) → emerald,
 * negative (house net paid out) → rose. Same convention as the
 * Period P&L Breakdown panel above it.
 */

const WINDOWS = [
  { key: "h24", label: "Past 24h" },
  { key: "d3", label: "Past 3d" },
  { key: "d7", label: "Past 7d" },
  { key: "all", label: "Lifetime" },
] as const;

export function PackBattlePurePnl({ data }: { data: PackBattlePnlWindows }) {
  return (
    <div className="rounded-2xl border bg-gradient-to-br from-card via-card to-card/80 p-4 sm:p-5">
      <div className="mb-4">
        <h3 className="text-base font-semibold leading-tight">
          Pack &amp; Battle Raw P&amp;L
        </h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Real-money plays only — the stats we actually make money
          from. Wager = customer cash on pack opens / battle bets.
          Payout = full battle/pack win the customer kept (net card
          value + battle cash refund + excess-voucher legs). Excludes:
          creator wagers (house-funded promo), every borrow-mode
          play (both wager and won inventory), and every reward
          surface (bonuses / rakeback / upgrader / rain / race /
          leaderboard prizes).
        </p>
      </div>

      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-3 py-2 text-left text-xs font-medium">
                Source
              </th>
              <th className="px-3 py-2 text-right text-xs font-medium">
                Metric
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
            {/* Total row at the top so the headline number is the
                first thing admins read; per-source rows below. */}
            <PnlRow
              icon={Sigma}
              accent="cyan"
              label="Combined"
              data={data}
              metricKey="totalPnl"
              wagerKey="totalWager"
              payoutKey="totalPayouts"
              bold
            />
            <SectionDivider label="Per source" />
            <PnlRow
              icon={Package}
              accent="orange"
              label="Packs"
              data={data}
              metricKey="packPnl"
              wagerKey="packWager"
              payoutKey="packPayouts"
            />
            <PnlRow
              icon={Swords}
              accent="pink"
              label="Battles"
              data={data}
              metricKey="battlePnl"
              wagerKey="battleWager"
              payoutKey="battlePayouts"
            />
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SectionDivider({ label }: { label: string }) {
  return (
    <tr>
      <td
        colSpan={WINDOWS.length + 2}
        className="bg-muted/40 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
      >
        {label}
      </td>
    </tr>
  );
}

function PnlRow({
  icon: Icon,
  accent,
  label,
  data,
  metricKey,
  wagerKey,
  payoutKey,
  bold,
}: {
  icon: React.ElementType;
  accent: "orange" | "pink" | "cyan";
  label: string;
  data: PackBattlePnlWindows;
  metricKey: keyof PackBattlePnlRow;
  wagerKey: keyof PackBattlePnlRow;
  payoutKey: keyof PackBattlePnlRow;
  bold?: boolean;
}) {
  const iconColor =
    accent === "orange"
      ? "bg-orange-500/10 text-orange-600 dark:text-orange-400"
      : accent === "pink"
        ? "bg-pink-500/10 text-pink-600 dark:text-pink-400"
        : "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400";

  // Three sub-rows per source — Wager, Payouts, P&L. Stacked in one
  // table row using a left-side rowspan label so the table stays
  // dense. Each P&L cell is colored emerald (house gained) or rose
  // (house lost) based on its sign.
  return (
    <>
      {/* Wager row */}
      <tr className="group border-b hover:bg-muted/30">
        <td rowSpan={3} className="px-3 py-2 align-middle">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "flex size-7 shrink-0 items-center justify-center rounded-md",
                iconColor,
              )}
            >
              <Icon className="size-3.5" />
            </span>
            <p
              className={cn(
                "truncate text-sm font-medium leading-tight",
                bold && "font-semibold",
              )}
            >
              {label}
            </p>
          </div>
        </td>
        <td className="px-3 py-2 text-right text-xs text-muted-foreground">
          Wager in
        </td>
        {WINDOWS.map((w) => (
          <td
            key={w.key}
            className="px-3 py-2 text-right tabular-nums text-muted-foreground"
          >
            {formatCurrency(data[w.key][wagerKey] as number)}
          </td>
        ))}
      </tr>
      {/* Payouts row */}
      <tr className="group border-b hover:bg-muted/30">
        <td className="px-3 py-2 text-right text-xs text-muted-foreground">
          Payout out
        </td>
        {WINDOWS.map((w) => (
          <td
            key={w.key}
            className="px-3 py-2 text-right tabular-nums text-muted-foreground"
          >
            {formatCurrency(data[w.key][payoutKey] as number)}
          </td>
        ))}
      </tr>
      {/* P&L row */}
      <tr className="group border-b hover:bg-muted/30">
        <td className="px-3 py-2 text-right text-xs font-semibold">
          P&amp;L
        </td>
        {WINDOWS.map((w) => (
          <PnlCell
            key={w.key}
            value={data[w.key][metricKey] as number}
            bold={bold}
          />
        ))}
      </tr>
    </>
  );
}

function PnlCell({ value, bold }: { value: number; bold?: boolean }) {
  const positive = value >= 0;
  const sign = positive ? "+" : "−";
  return (
    <td
      className={cn(
        "px-3 py-2 text-right tabular-nums",
        bold && "font-semibold",
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
