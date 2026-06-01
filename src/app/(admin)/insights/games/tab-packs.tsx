import Image from "next/image";
import Link from "next/link";
import { Package } from "lucide-react";
import { FadeIn } from "@/components/fade-in";
import { SectionHeading } from "@/components/modern-panels";
import { formatCompactUsd, formatNumber } from "@/lib/utils/format";
import { getPacksProfitability } from "@/lib/queries/insights-games/packs";
import type { GamesPeriod } from "@/lib/queries/insights-games/_shared";
import { labelForPeriod } from "@/lib/queries/insights-games/_shared";

/**
 * Packs tab — per-pack profitability table for the selected period.
 *
 * Every figure here is borrow-corrected (what the user actually
 * paid, not the sticker price). The Sticker column is surfaced as
 * a reference so the operator can spot heavy-borrow packs at a
 * glance (sticker >> wager-paid).
 *
 * Sort: by borrow-corrected wager DESC — the packs that pulled the
 * most actual revenue land at the top.
 */
export async function PacksTab({ period }: { period: GamesPeriod }) {
  const data = await getPacksProfitability(period);
  return (
    <FadeIn>
      <div className="space-y-4">
        <SectionHeading
          icon={Package}
          title={`Per-pack profitability — ${labelForPeriod(period)}`}
        />
        <p className="text-xs text-muted-foreground">
          Wager is the user&apos;s actual cash paid (post-borrow). Sticker is
          opens × pack price for reference. Payout is the realised card
          value the user kept. Creators on-stream are excluded.
        </p>
        {data.packs.length === 0 ? (
          <div className="rounded-2xl border bg-card p-8 text-center text-sm text-muted-foreground">
            No pack activity in this period.
          </div>
        ) : (
          <div className="overflow-hidden rounded-2xl border bg-card">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-semibold">Pack</th>
                    <th className="px-3 py-2 text-right font-semibold">Opens</th>
                    <th className="px-3 py-2 text-right font-semibold">
                      Wager (paid)
                    </th>
                    <th className="px-3 py-2 text-right font-semibold">Sticker</th>
                    <th className="px-3 py-2 text-right font-semibold">Payout</th>
                    <th className="px-3 py-2 text-right font-semibold">P&amp;L</th>
                    <th className="px-3 py-2 text-right font-semibold">RTP</th>
                    <th className="px-3 py-2 text-right font-semibold">Margin</th>
                  </tr>
                </thead>
                <tbody>
                  {data.packs.map((p) => (
                    <tr
                      key={p.packId}
                      className="border-b last:border-0 hover:bg-muted/30"
                    >
                      <td className="px-3 py-2">
                        <Link
                          href={`/packs/${p.packId}`}
                          className="flex items-center gap-2 hover:underline"
                        >
                          {p.imageUrl ? (
                            <Image
                              src={p.imageUrl}
                              alt={p.name}
                              width={32}
                              height={32}
                              className="size-8 rounded-md object-cover"
                              unoptimized
                            />
                          ) : (
                            <div className="size-8 rounded-md bg-muted" />
                          )}
                          <div className="min-w-0">
                            <p className="truncate font-medium">{p.name}</p>
                            <p className="text-[10px] text-muted-foreground">
                              {formatCompactUsd(p.stickerPrice)} sticker
                            </p>
                          </div>
                        </Link>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatNumber(p.opens)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                        {formatCompactUsd(p.borrowCorrectedWager)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                        {formatCompactUsd(p.stickerWager)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-rose-600 dark:text-rose-400">
                        {formatCompactUsd(p.payouts)}
                      </td>
                      <td
                        className={`px-3 py-2 text-right tabular-nums font-medium ${p.pnl >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}
                      >
                        {formatCompactUsd(p.pnl)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {p.rtpPct.toFixed(2)}%
                      </td>
                      <td
                        className={`px-3 py-2 text-right tabular-nums ${p.marginPct >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}
                      >
                        {p.marginPct.toFixed(2)}%
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
