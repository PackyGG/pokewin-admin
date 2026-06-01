import Image from "next/image";
import Link from "next/link";
import { HandCoins, Percent, Users } from "lucide-react";
import { FadeIn } from "@/components/fade-in";
import { KpiTile, SectionHeading } from "@/components/modern-panels";
import { formatCompactUsd, formatNumber } from "@/lib/utils/format";
import { getBorrowAnalytics } from "@/lib/queries/insights-games/borrow";
import type { GamesPeriod } from "@/lib/queries/insights-games/_shared";
import { labelForPeriod } from "@/lib/queries/insights-games/_shared";

/**
 * Borrow tab — quantifies the borrow play that the other tabs DROP.
 *
 * The figures here answer "how much exposure did the house take
 * via borrow in the period, and who's drawing the most".
 *
 *   • Sticker exposure = cash paid + borrowed (the headline
 *     gross). On a $1k pack at 90% borrow it's $1000.
 *   • Borrow share = borrowed / sticker × 100 (what fraction of
 *     all gross exposure was house-fronted).
 *   • Cash share of plays = how many of all plays used borrow.
 *
 * Top users surface the biggest borrowers — useful for risk
 * profiling and recouping incentive spend.
 */
export async function BorrowTab({ period }: { period: GamesPeriod }) {
  const data = await getBorrowAnalytics(period);
  const t = data.totals;
  return (
    <FadeIn>
      <div className="space-y-6">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <KpiTile
            label="Borrow plays"
            value={formatNumber(t.borrowedPlaysCount)}
            sub={`${t.borrowShareOfPlaysPct.toFixed(2)}% of plays · ${labelForPeriod(period)}`}
            icon={HandCoins}
            accent="amber"
          />
          <KpiTile
            label="House-fronted"
            value={formatCompactUsd(t.borrowedAmountSum)}
            sub="Borrow exposure"
            icon={HandCoins}
            accent="purple"
          />
          <KpiTile
            label="User cash paid"
            value={formatCompactUsd(t.cashPaidSum)}
            sub="Out of user balance"
            icon={HandCoins}
            accent="emerald"
          />
          <KpiTile
            label="Borrow share"
            value={`${t.borrowSharePct.toFixed(2)}%`}
            sub={`Sticker ${formatCompactUsd(t.stickerSum)}`}
            icon={Percent}
            accent="blue"
          />
        </div>

        <SectionHeading icon={Users} title="Top borrowers" />
        {data.topUsers.length === 0 ? (
          <div className="rounded-2xl border bg-card p-8 text-center text-sm text-muted-foreground">
            No borrow activity in this period.
          </div>
        ) : (
          <div className="overflow-hidden rounded-2xl border bg-card">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-semibold">User</th>
                    <th className="px-3 py-2 text-right font-semibold">Plays</th>
                    <th className="px-3 py-2 text-right font-semibold">Avg borrow %</th>
                    <th className="px-3 py-2 text-right font-semibold">User paid</th>
                    <th className="px-3 py-2 text-right font-semibold">House fronted</th>
                  </tr>
                </thead>
                <tbody>
                  {data.topUsers.map((u) => (
                    <tr key={u.userId} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="px-3 py-2">
                        <Link
                          href={`/users/${u.userId}`}
                          className="flex items-center gap-2 hover:underline"
                        >
                          {u.image ? (
                            <Image
                              src={u.image}
                              alt={u.username ?? "user"}
                              width={28}
                              height={28}
                              className="size-7 rounded-full object-cover"
                              unoptimized
                            />
                          ) : (
                            <div className="size-7 rounded-full bg-muted" />
                          )}
                          <span className="font-medium">{u.username ?? "—"}</span>
                        </Link>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatNumber(u.borrowPlays)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {u.avgBorrowPct.toFixed(1)}%
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatCompactUsd(u.cashPaidSum)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-purple-600 dark:text-purple-400">
                        {formatCompactUsd(u.borrowedAmountSum)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </FadeIn>
  );
}
