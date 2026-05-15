import {
  Scale,
  ArrowDownToLine,
  ArrowUpFromLine,
  Wallet,
  TrendingUp,
  TrendingDown,
  Info,
} from "lucide-react";
import { getRealizedPnlSnapshot } from "@/lib/queries/_realized-pnl";
import { requirePageAccess } from "@/lib/dal";
import { PageHero } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { PnlBreakdown } from "@/components/pnl-breakdown";
import { StatCard } from "../dashboard/stat-card";

export const metadata = { title: "P&L" };

/**
 * Dedicated P&L tracking page.
 *
 * Renders the canonical realized-P&L snapshot — the same number the
 * dashboard's PnL card and the Analytics overview show — broken into
 * its contributing terms so an admin can see, at a glance, WHY the
 * number is what it is and click straight through to the users /
 * transactions driving each component.
 *
 * Realized P&L is a live balance-sheet snapshot (no time series is
 * stored), so this page always reflects "right now". The explainer
 * panel is explicit about that.
 */
export default async function PnlPage() {
  await requirePageAccess("/pnl");
  const snap = await getRealizedPnlSnapshot();

  // Everything a user currently holds is money the house still owes —
  // it all counts against P&L. Grouping the four liability terms into
  // one headline number makes the deposits-minus-withdrawals-minus-owed
  // story readable before the row-by-row breakdown below.
  const owedToUsers =
    snap.userBalance + snap.inventory + snap.vouchers + snap.unclaimedRakeback;
  const isProfit = snap.pnl >= 0;

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10">
            <Scale className="size-5 text-primary" />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-bold leading-tight sm:text-2xl">
              Profit &amp; Loss
            </h1>
            <p className="text-xs text-muted-foreground sm:text-sm">
              Live house P&amp;L — what&apos;s been earned and what&apos;s
              still owed to users.
            </p>
          </div>
        </div>
      </PageHero>

      {/* KPI strip — the P&L equation as four glanceable numbers:
          deposits − withdrawals − owed = realized P&L. */}
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatCard
          title="Total Deposits"
          animatedValue={snap.totalDeposited}
          formatKind="currency"
          subtitle="Real money users have funded"
          icon={ArrowDownToLine}
          color="emerald"
        />
        <StatCard
          title="Total Withdrawals"
          animatedValue={snap.totalWithdrawn}
          formatKind="currency"
          subtitle="Cashed-out balances + shipped cards"
          icon={ArrowUpFromLine}
          color="rose"
        />
        {/* Liability magnitude — accented orange (not rose) so it reads
            as "size of what we owe", not a directional loss signal.
            Matches the dashboard's "Users Total Balance" tile. */}
        <StatCard
          title="Owed to Users"
          animatedValue={owedToUsers}
          formatKind="currency"
          subtitle="Balances + inventory + vouchers + rakeback"
          icon={Wallet}
          color="orange"
        />
        <StatCard
          title="Realized P&L"
          animatedValue={snap.pnl}
          formatKind="currency"
          subtitle={isProfit ? "House is up" : "House is down"}
          icon={isProfit ? TrendingUp : TrendingDown}
          color={isProfit ? "emerald" : "rose"}
        />
      </div>

      <FadeIn>
        <PnlBreakdown
          total={snap.pnl}
          breakdown={{
            totalDeposits: snap.totalDeposited,
            totalWithdrawals: snap.totalWithdrawn,
            userBalance: snap.userBalance,
            inventory: snap.inventory,
            vouchers: snap.vouchers,
            unclaimedRakeback: snap.unclaimedRakeback,
          }}
        />
      </FadeIn>

      {/* Explainer — answers "why is P&L the number it is / why did it
          move" in plain language, plus the honest no-history caveat. */}
      <FadeIn>
        <div className="rounded-2xl border bg-gradient-to-br from-card via-card to-card/80 p-4 sm:p-5">
          <div className="mb-3 flex items-center gap-2">
            <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-blue-500/10">
              <Info className="size-3.5 text-blue-500" />
            </div>
            <h3 className="text-sm font-semibold">How to read this</h3>
          </div>
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>
              Realized P&amp;L is{" "}
              <span className="font-medium text-foreground">
                deposits − withdrawals − everything users still hold
              </span>
              . Every dollar a user holds — on-site balance, card
              inventory, unclaimed vouchers and rakeback — is a dollar the
              house still owes, so it counts against P&amp;L.
            </p>
            <p>
              P&amp;L goes{" "}
              <span className="font-medium text-rose-600 dark:text-rose-400">
                down
              </span>{" "}
              when users win (balances grow), when the house hands out
              bonuses or rewards, when open inventory grows, or when
              withdrawals rise. It goes{" "}
              <span className="font-medium text-emerald-600 dark:text-emerald-400">
                up
              </span>{" "}
              when users wager and lose. Click any row above to drill into
              the users and transactions behind that term.
            </p>
            <p className="text-xs">
              This is a live snapshot — it always reflects the current
              moment. Hour-by-hour P&amp;L history isn&apos;t recorded, so
              past movements can&apos;t be replayed here.
            </p>
          </div>
        </div>
      </FadeIn>
    </div>
  );
}
