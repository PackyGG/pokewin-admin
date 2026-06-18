import { Suspense } from "react";
import {
  Coins,
  Wallet,
  Percent,
  Gift,
  TrendingDown,
  PiggyBank,
  Activity,
} from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
  KpiTile,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { safeQueryOrNull } from "@/lib/errors/safe-query";
import {
  getDepositBonusTracker,
  DEPOSIT_BONUS_RATE_PCT,
} from "@/lib/queries/rewards/deposit-bonus-tracker";
import { getDepositBonusConfig } from "@/lib/backend-api/deposit-bonus-config";
import { DepositBonusTrendChart } from "./_components/trend-chart";

export const metadata = { title: "Deposit Bonus" };

export default async function DepositBonusPage() {
  await requirePageAccess("/rewards/deposit-bonus");

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Coins}
          accent="rose"
          title="Deposit Bonus"
          subtitle={`${DEPOSIT_BONUS_RATE_PCT}% of every deposit, capped per rolling window. Live spend plus savings vs the old system.`}
        />
      </PageHero>

      <Suspense fallback={<TrackerSkeleton />}>
        <TrackerBody />
      </Suspense>
    </div>
  );
}

function fmtCutover(iso: string): { date: string; ago: string } {
  const d = new Date(iso);
  const date = d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  const hrs = (Date.now() - d.getTime()) / 3_600_000;
  const ago =
    hrs < 1
      ? "just now"
      : hrs < 48
        ? `~${Math.round(hrs)}h ago`
        : `~${Math.round(hrs / 24)}d ago`;
  return { date, ago };
}

function pct(v: number | null): string {
  return v === null ? "—" : `${(v * 100).toFixed(2)}%`;
}

async function TrackerBody() {
  const [{ data: tracker }, { data: config }] = await Promise.all([
    safeQueryOrNull(
      () => getDepositBonusTracker(),
      "rewards.deposit-bonus-tracker",
      20_000,
    ),
    safeQueryOrNull(
      () => getDepositBonusConfig(),
      "rewards.deposit-bonus-config",
      8_000,
    ),
  ]);

  if (!tracker) {
    return (
      <div className="rounded-xl border bg-muted/20 p-6 text-sm text-muted-foreground">
        Deposit-bonus data is temporarily unavailable. Refresh in a moment.
      </div>
    );
  }

  const { since, old, lifetime, savings } = tracker;
  const cut = fmtCutover(tracker.cutover);
  const newBeatsOld =
    savings.newEffRate !== null &&
    savings.oldEffRate !== null &&
    savings.newEffRate < savings.oldEffRate;
  const hrsSinceCutover =
    (Date.now() - new Date(tracker.cutover).getTime()) / 3_600_000;
  const smallSample = hrsSinceCutover < 24 * 7;

  const chartData = tracker.daily.map((d) => ({
    date: d.date,
    bonus: d.bonus,
    ratePct: d.effRate === null ? null : d.effRate * 100,
  }));
  const cutoverDate = tracker.cutover.split("T")[0];
  const recent = tracker.daily.slice(-14).reverse();

  return (
    <FadeIn>
      <div className="space-y-6">
        {/* ── Config / status strip ─────────────────────────────── */}
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Badge variant="outline" className="gap-1.5">
            <Activity className="size-3.5 text-emerald-500" />
            New system live since {cut.date}{" "}
            <span className="text-muted-foreground/70">({cut.ago})</span>
          </Badge>
          <Badge variant="outline">{DEPOSIT_BONUS_RATE_PCT}% of each deposit</Badge>
          {config ? (
            <Badge variant="outline">
              Cap {formatCurrency(config.cap_per_period_usd)} / {config.period_hours}h
              window
            </Badge>
          ) : (
            <Badge variant="outline" className="text-amber-500">
              Cap config unavailable
            </Badge>
          )}
        </div>

        {/* ── KPI strip ─────────────────────────────────────────── */}
        <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3 xl:grid-cols-6">
          <KpiTile
            label="Bonus paid (since live)"
            value={formatCurrency(since.bonus)}
            sub={`${formatNumber(since.count)} bonuses · ${formatNumber(since.claimants)} users`}
            icon={Gift}
            accent="rose"
          />
          <KpiTile
            label="Avg bonus"
            value={formatCurrency(since.avg)}
            sub={`max ${formatCurrency(since.max)}`}
            icon={Coins}
            accent="rose"
          />
          <KpiTile
            label="Deposits (since live)"
            value={formatCurrency(since.deposits)}
            sub={`${formatNumber(since.depositors)} depositors`}
            icon={Wallet}
            accent="blue"
          />
          <KpiTile
            label="New effective rate"
            value={pct(since.effRate)}
            sub="bonus per $ deposited"
            icon={Percent}
            accent={newBeatsOld ? "emerald" : "rose"}
          />
          <KpiTile
            label="Old effective rate"
            value={pct(old.effRate)}
            sub={`prior ${old.lookbackDays}d baseline`}
            icon={Percent}
            accent="amber"
          />
          <KpiTile
            label="Bonus paid (90d)"
            value={formatCurrency(lifetime.bonus)}
            sub={`${formatNumber(lifetime.count)} total`}
            icon={TrendingDown}
            accent="rose"
          />
        </div>

        {/* ── Savings panel ─────────────────────────────────────── */}
        <div>
          <SectionHeading
            icon={PiggyBank}
            title="Estimated savings vs old system"
          />
          <div className="mt-3 grid gap-4 lg:grid-cols-3">
            <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-5 lg:col-span-2">
              <div className="grid gap-5 sm:grid-cols-2">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Realized since go-live
                  </p>
                  <p className="mt-1 text-3xl font-bold tracking-tight tabular-nums text-emerald-600 dark:text-emerald-400">
                    {savings.realizedSinceCutover === null
                      ? "—"
                      : formatCurrency(savings.realizedSinceCutover)}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    vs what the old {pct(old.effRate)} rate would have paid on
                    the {formatCurrency(since.deposits)} deposited since go-live.
                  </p>
                </div>
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Projected / 30 days
                  </p>
                  <p className="mt-1 text-3xl font-bold tracking-tight tabular-nums text-emerald-600 dark:text-emerald-400">
                    {savings.projectedPer30d === null
                      ? "—"
                      : `≈ ${formatCurrency(savings.projectedPer30d)}`}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    rate delta applied to the trailing-30d deposit volume (
                    {formatCurrency(tracker.last30dDeposits)}).
                  </p>
                </div>
              </div>
              {smallSample && (
                <p className="mt-4 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
                  Only ~{Math.max(1, Math.round(hrsSinceCutover))}h of new-system
                  data so far — the new rate and projection will stabilize as
                  more deposits land. Realized savings is the honest figure for
                  now.
                </p>
              )}
            </div>

            <div className="rounded-2xl border bg-card p-5">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Effective-rate comparison
              </p>
              <div className="mt-3 space-y-3">
                <RateRow
                  label={`Old (prior ${old.lookbackDays}d)`}
                  value={pct(old.effRate)}
                  accent="amber"
                />
                <RateRow
                  label="New (since go-live)"
                  value={pct(since.effRate)}
                  accent={newBeatsOld ? "emerald" : "rose"}
                />
                <div className="border-t pt-3 text-xs text-muted-foreground">
                  Empirical method: bonus paid per $ deposited, before vs after
                  cutover. No counterfactual formula is assumed.
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* ── Trend chart ───────────────────────────────────────── */}
        <div>
          <SectionHeading
            icon={Activity}
            title="Daily bonus spend & effective rate (90d)"
          />
          <div className="mt-3 rounded-2xl border bg-card p-4">
            <DepositBonusTrendChart data={chartData} cutoverDate={cutoverDate} />
          </div>
        </div>

        {/* ── Recent daily breakdown ────────────────────────────── */}
        <div>
          <SectionHeading icon={Coins} title="Recent days" />
          <div className="mt-3 overflow-hidden rounded-2xl border bg-card">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <th className="px-4 py-2.5 font-medium">Date</th>
                  <th className="px-4 py-2.5 text-right font-medium">Bonus paid</th>
                  <th className="px-4 py-2.5 text-right font-medium">Deposits</th>
                  <th className="px-4 py-2.5 text-right font-medium">Eff. rate</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((d) => {
                  const afterCutover = d.date >= cutoverDate;
                  return (
                    <tr
                      key={d.date}
                      className={cn(
                        "border-b last:border-0",
                        afterCutover && "bg-emerald-500/[0.04]",
                      )}
                    >
                      <td className="px-4 py-2.5 tabular-nums">
                        {new Date(d.date + "T00:00:00Z").toLocaleDateString(
                          "en-US",
                          { month: "short", day: "numeric", timeZone: "UTC" },
                        )}
                        {afterCutover && (
                          <span className="ml-2 text-[10px] uppercase tracking-wide text-emerald-500">
                            new
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-rose-600 dark:text-rose-400">
                        {formatCurrency(d.bonus)}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">
                        {formatCurrency(d.deposits)}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        {d.effRate === null ? "—" : `${(d.effRate * 100).toFixed(2)}%`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </FadeIn>
  );
}

function RateRow({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent: "emerald" | "rose" | "amber";
}) {
  const tint =
    accent === "emerald"
      ? "text-emerald-600 dark:text-emerald-400"
      : accent === "rose"
        ? "text-rose-600 dark:text-rose-400"
        : "text-amber-600 dark:text-amber-400";
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className={cn("text-lg font-bold tabular-nums", tint)}>{value}</span>
    </div>
  );
}

function TrackerSkeleton() {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-6 w-40 rounded-full bg-muted animate-pulse" />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-24 rounded-xl border bg-muted/20 animate-pulse" />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="h-44 rounded-2xl border bg-muted/20 animate-pulse lg:col-span-2" />
        <div className="h-44 rounded-2xl border bg-muted/20 animate-pulse" />
      </div>
      <div className="h-[320px] rounded-2xl border bg-muted/20 animate-pulse" />
    </div>
  );
}
