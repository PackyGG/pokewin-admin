import Image from "next/image";
import Link from "next/link";
import { HandCoins, Percent, Users, Crown, Scale } from "lucide-react";
import { FadeIn } from "@/components/fade-in";
import { KpiTile, SectionHeading } from "@/components/modern-panels";
import { formatCompactUsd, formatDateTime, formatNumber } from "@/lib/utils/format";
import { getBorrowAnalytics } from "@/lib/queries/insights-games/borrow";
import type { GamesPeriod } from "@/lib/queries/insights-games/_shared";
import { labelForPeriod } from "@/lib/queries/insights-games/_shared";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { formatPctOrNa } from "./_format-metrics";

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
  const { data, error } = await safeQuery(
    () => getBorrowAnalytics(period),
    null,
    "insights-games.borrow",
    REWARD_QUERY_TIMEOUT_MS,
  );
  if (error || !data) {
    return (
      <TileErrorFallback
        label="Games — Borrow"
        hint="The borrow analytics query failed. Server logs hold the digest."
        size="panel"
      />
    );
  }
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

        {/* Biggest single play — surface the headline single-event
            borrow exposure for the period (most-fronted play, by
            absolute house-fronted dollars). */}
        {data.biggestPlay && (
          <>
            <SectionHeading icon={Crown} title="Biggest single borrow play" />
            <div className="overflow-hidden rounded-2xl border bg-card p-4 sm:p-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <Link
                  href={`/users/${data.biggestPlay.userId}`}
                  className="flex items-center gap-3 hover:underline"
                >
                  {data.biggestPlay.image ? (
                    <Image
                      src={data.biggestPlay.image}
                      alt={data.biggestPlay.username ?? "user"}
                      width={40}
                      height={40}
                      className="size-10 rounded-full object-cover"
                      unoptimized
                    />
                  ) : (
                    <div className="size-10 rounded-full bg-muted" />
                  )}
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">
                      {data.biggestPlay.username ?? "—"}
                    </p>
                    <p className="text-[10px] text-muted-foreground">
                      {data.biggestPlay.type === "pack_opening"
                        ? "Solo pack open"
                        : data.biggestPlay.type === "battle_sponsorship"
                          ? "Battle (sponsored)"
                          : "Battle bet"}{" "}
                      · {formatDateTime(data.biggestPlay.createdAt)}
                    </p>
                  </div>
                </Link>
                <div className="grid grid-cols-3 gap-3 text-xs sm:gap-4">
                  <div className="text-right">
                    <p className="text-[9px] uppercase tracking-wider text-muted-foreground">
                      Cash paid
                    </p>
                    <p className="font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                      {formatCompactUsd(data.biggestPlay.cashPaid)}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-[9px] uppercase tracking-wider text-muted-foreground">
                      House fronted
                    </p>
                    <p className="font-semibold tabular-nums text-purple-600 dark:text-purple-400">
                      {formatCompactUsd(data.biggestPlay.borrowedAmount)}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-[9px] uppercase tracking-wider text-muted-foreground">
                      Sticker · borrow %
                    </p>
                    <p className="font-semibold tabular-nums">
                      {formatCompactUsd(data.biggestPlay.stickerExposure)}{" "}
                      <span className="text-[10px] text-amber-600 dark:text-amber-400">
                        · {data.biggestPlay.borrowPct.toFixed(1)}%
                      </span>
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </>
        )}

        {/* Borrow vs non-borrow user cohort — apples-to-apples user
            economics. Per-user averages so cohort size doesn't bias
            the comparison. */}
        <SectionHeading icon={Scale} title="Borrowers vs non-borrowers" />
        <div className="overflow-hidden rounded-2xl border bg-card">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-semibold">Cohort</th>
                  <th className="px-3 py-2 text-right font-semibold">Users</th>
                  <th className="px-3 py-2 text-right font-semibold">
                    Total wager
                  </th>
                  <th className="px-3 py-2 text-right font-semibold">
                    Total payout
                  </th>
                  <th className="px-3 py-2 text-right font-semibold">
                    Avg wager / user
                  </th>
                  <th className="px-3 py-2 text-right font-semibold">
                    Avg payout / user
                  </th>
                  <th className="px-3 py-2 text-right font-semibold">
                    Avg P&amp;L / user
                  </th>
                  <th className="px-3 py-2 text-right font-semibold">RTP</th>
                </tr>
              </thead>
              <tbody>
                {data.cohorts.map((c) => (
                  <tr
                    key={c.label}
                    className="border-b last:border-0 hover:bg-muted/30"
                  >
                    <td className="px-3 py-2 font-medium">{c.label}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatNumber(c.users)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                      {formatCompactUsd(c.totalWager)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-rose-600 dark:text-rose-400">
                      {formatCompactUsd(c.totalPayout)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatCompactUsd(c.avgWagerPerUser)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatCompactUsd(c.avgPayoutPerUser)}
                    </td>
                    <td
                      className={`px-3 py-2 text-right tabular-nums font-medium ${c.avgPnlPerUser >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}
                    >
                      {formatCompactUsd(c.avgPnlPerUser)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatPctOrNa(c.rtpPct)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
                    <th className="px-3 py-2 text-right font-semibold">% of wager via borrow</th>
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
                      <td className="px-3 py-2 text-right tabular-nums">
                        {u.borrowShareOfWagerPct.toFixed(1)}%
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
