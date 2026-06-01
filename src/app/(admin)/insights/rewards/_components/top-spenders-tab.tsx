import Link from "next/link";
import {
  Trophy,
  TrendingDown,
  Hash,
  Layers,
} from "lucide-react";
import {
  SectionHeading,
  KpiTile,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { EmptyState } from "@/components/empty-state";
import { cn } from "@/lib/utils";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import {
  getRewardsTopRecipients,
  type TopRecipientRow,
} from "@/lib/queries/insights-rewards/top-recipients";
import {
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";

/**
 * Top spenders tab — top 25 reward recipients across categories for
 * the active window.
 *
 * Each row carries the user, total reward $, per-category split,
 * distinct category count, and the user's in-window wager / GGR.
 * House-POV:
 *   - reward $ = rose (we paid)
 *   - in-window GGR signed (emerald positive, rose negative)
 *
 * Per-row link → /users/[id] for drilldown.
 */
export async function TopSpendersTab({
  period,
}: {
  period: InsightsRewardsPeriod;
}) {
  const rows = await getRewardsTopRecipients(period);
  const label = insightsRewardsPeriodLabel(period);

  if (rows.length === 0) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <EmptyState
          icon={Trophy}
          title={`No top spenders in ${label.toLowerCase()}`}
          description="No users received reward payouts in this window."
          compact
        />
      </div>
    );
  }

  const topTotal = rows.reduce((a, r) => a + r.total, 0);
  const topGgr = rows.reduce((a, r) => a + r.ggrInWindow, 0);
  const topUserCount = rows.length;
  const avgCategoriesPerUser =
    topUserCount > 0
      ? rows.reduce((a, r) => a + r.categoryCount, 0) / topUserCount
      : 0;

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <KpiTile
            label="Top 25 reward total"
            value={formatCurrency(topTotal)}
            sub={label}
            icon={TrendingDown}
            accent="rose"
          />
          <KpiTile
            label="Top 25 GGR (window)"
            value={`${topGgr >= 0 ? "+" : "−"}${formatCurrency(Math.abs(topGgr))}`}
            sub={
              topGgr >= 0
                ? "House profit on top spenders"
                : "House loss on top spenders"
            }
            icon={TrendingDown}
            accent={topGgr >= 0 ? "emerald" : "rose"}
          />
          <KpiTile
            label="Avg categories / user"
            value={avgCategoriesPerUser.toFixed(1)}
            sub="Distinct reward types"
            icon={Layers}
            accent="blue"
          />
          <KpiTile
            label="Top 25 ticket"
            value={formatCurrency(rows[0]?.total ?? 0)}
            sub={
              rows[0]
                ? `Largest: ${rows[0].username ?? rows[0].userId.slice(0, 8)}`
                : "—"
            }
            icon={Trophy}
            accent="rose"
          />
        </div>
      </FadeIn>

      <FadeIn>
        <div className="space-y-3">
          <SectionHeading
            icon={Hash}
            title="Top 25 reward recipients"
          />
          <RecipientsTable rows={rows} />
        </div>
      </FadeIn>
    </div>
  );
}

function RecipientsTable({ rows }: { rows: TopRecipientRow[] }) {
  return (
    <div className="overflow-x-auto rounded-2xl border bg-card">
      <div className="min-w-[920px]">
        <div className="grid grid-cols-[2rem_1.4fr_repeat(6,_minmax(0,_7rem))] gap-3 border-b border-border/60 bg-muted/30 px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          <span>#</span>
          <span>User</span>
          <span className="text-right">Categories</span>
          <span className="text-right">Reward total</span>
          <span className="text-right">Top category</span>
          <span className="text-right">Wager</span>
          <span className="text-right">Payout</span>
          <span className="text-right">GGR (window)</span>
        </div>
        <ul>
          {rows.map((r, idx) => {
            const ggrIsHouseProfit = r.ggrInWindow >= 0;
            const topCategoryEntry = topCategory(r.perCategory);
            return (
              <li key={r.userId}>
                <Link
                  href={`/users/${r.userId}`}
                  className="grid grid-cols-[2rem_1.4fr_repeat(6,_minmax(0,_7rem))] items-center gap-3 border-b border-border/60 px-4 py-2.5 text-xs transition-colors last:border-b-0 hover:bg-muted/30"
                >
                  <span className="text-right tabular-nums text-muted-foreground">
                    {idx + 1}.
                  </span>
                  <span className="truncate font-medium">
                    {r.username ?? `${r.userId.slice(0, 6)}…`}
                  </span>
                  <span className="text-right tabular-nums text-muted-foreground">
                    {r.categoryCount}
                  </span>
                  <span className="text-right tabular-nums text-rose-600 dark:text-rose-400">
                    {formatCurrency(r.total)}
                  </span>
                  <span className="truncate text-right text-muted-foreground">
                    {topCategoryEntry
                      ? `${topCategoryEntry.label} · ${formatCurrency(topCategoryEntry.value)}`
                      : "—"}
                  </span>
                  <span className="text-right tabular-nums text-muted-foreground">
                    {formatCurrency(r.wagerTotal)}
                  </span>
                  <span className="text-right tabular-nums text-muted-foreground">
                    {formatCurrency(r.payoutTotal)}
                  </span>
                  <span
                    className={cn(
                      "text-right font-semibold tabular-nums",
                      ggrIsHouseProfit
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-rose-600 dark:text-rose-400",
                    )}
                  >
                    {ggrIsHouseProfit ? "+" : "−"}
                    {formatCurrency(Math.abs(r.ggrInWindow))}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

const CATEGORY_LABELS: Record<keyof TopRecipientRow["perCategory"], string> = {
  bonuses: "Bonuses",
  rakeback: "Rakeback",
  affiliate: "Affiliate",
  rainRace: "Rain/Race",
  signupPack: "Signup",
  creatorTip: "Creator tip",
  waitlist: "Waitlist",
};

function topCategory(
  perCategory: TopRecipientRow["perCategory"],
): { label: string; value: number } | null {
  let best: { label: string; value: number } | null = null;
  for (const [key, value] of Object.entries(perCategory) as Array<
    [keyof TopRecipientRow["perCategory"], number]
  >) {
    if (value <= 0) continue;
    if (best === null || value > best.value) {
      best = { label: CATEGORY_LABELS[key], value };
    }
  }
  return best;
}
