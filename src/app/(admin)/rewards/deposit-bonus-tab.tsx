import { Suspense } from "react";
import Link from "next/link";
import {
  Coins,
  Wallet,
  Percent,
  Gift,
  TrendingDown,
  PiggyBank,
  Activity,
  Scissors,
  Trophy,
} from "lucide-react";
import { SectionHeading, KpiTile } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { LinkPending } from "@/components/ux";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { safeQueryOrNull } from "@/lib/errors/safe-query";
import {
  getDepositBonusTracker,
  getDepositBonusTopRecipients,
  DEPOSIT_BONUS_RATE_PCT,
} from "@/lib/queries/rewards/deposit-bonus-tracker";
import { getDepositBonusConfig } from "@/lib/backend-api/deposit-bonus-config";
import { DepositBonusTrendChart } from "./deposit-bonus/_components/trend-chart";

/**
 * Deposit Bonus tab of the merged /rewards page (was /rewards/deposit-bonus).
 * Its OWN Overview|Top Recipients inner switch is namespaced to `?dbtab=` so
 * it never collides with the top-level `?tab=`. Only the active inner sub-tab
 * awaits its data (active-tab-only).
 */
const DB_SUBTABS = [
  { value: "overview", label: "Overview" },
  { value: "recipients", label: "Top Recipients" },
];

export function DepositBonusTab({
  params,
}: {
  params: Record<string, string | undefined>;
}) {
  const dbtab = params.dbtab === "recipients" ? "recipients" : "overview";

  return (
    <div className="space-y-6">
      <div className="flex gap-1 rounded-lg border bg-muted/50 p-1">
        {DB_SUBTABS.map((t) => (
          <Link
            key={t.value}
            href={`/rewards?tab=deposit-bonus&dbtab=${t.value}`}
            className={cn(
              "inline-flex items-center rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              dbtab === t.value
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
            <LinkPending size={13} />
          </Link>
        ))}
      </div>

      {dbtab === "recipients" ? (
        <Suspense key="db-recipients" fallback={<RecipientsSkeleton />}>
          <RecipientsBody />
        </Suspense>
      ) : (
        <Suspense key="db-overview" fallback={<TrackerSkeleton />}>
          <TrackerBody />
        </Suspense>
      )}
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
          {/* House-POV: a deposit is money into the house → emerald. */}
          <KpiTile
            label="Deposits (since live)"
            value={formatCurrency(since.deposits)}
            sub={`${formatNumber(since.depositors)} depositors`}
            icon={Wallet}
            accent="emerald"
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

        {/* ── Cap effectiveness ─────────────────────────────────── */}
        <div>
          <SectionHeading
            icon={Scissors}
            title="Cap effectiveness"
            action={
              tracker.cap.capUsd !== null ? (
                <span className="text-xs text-muted-foreground">
                  cap {formatCurrency(tracker.cap.capUsd)} per window
                </span>
              ) : undefined
            }
          />
          <div className="mt-3 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3">
            <KpiTile
              label="Saved by the cap"
              value={formatCurrency(tracker.cap.clamped)}
              sub={`vs uncapped 5% (${formatCurrency(tracker.cap.uncapped5pct)})`}
              icon={Scissors}
              accent="emerald"
            />
            <KpiTile
              label="Deposits over cap"
              value={formatNumber(tracker.cap.overCapCount)}
              sub={
                tracker.cap.overCapPct === null
                  ? `of ${formatNumber(tracker.cap.depositCount)} deposits`
                  : `${(tracker.cap.overCapPct * 100).toFixed(1)}% of ${formatNumber(tracker.cap.depositCount)} deposits`
              }
              icon={Percent}
              accent="amber"
            />
            <KpiTile
              label="5% exceeds cap above"
              value={
                tracker.cap.capUsd === null
                  ? "—"
                  : formatCurrency(tracker.cap.capUsd * 20)
              }
              sub="single-deposit size that alone hits the cap"
              icon={Wallet}
              accent="blue"
            />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Isolates the cap&apos;s direct impact: how much of the 5% bonus is
            clamped, separate from any shift in deposit mix.
          </p>
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

async function RecipientsBody() {
  const { data: recipients } = await safeQueryOrNull(
    () => getDepositBonusTopRecipients(),
    "rewards.deposit-bonus-recipients",
    20_000,
  );

  if (!recipients || recipients.length === 0) {
    return (
      <div className="rounded-xl border bg-muted/20 p-6 text-sm text-muted-foreground">
        No deposit bonuses have been paid since the new system went live yet.
      </div>
    );
  }

  return (
    <FadeIn>
      <div>
        <SectionHeading
          icon={Trophy}
          title="Top recipients since go-live"
          action={
            <span className="text-xs text-muted-foreground">
              {formatNumber(recipients.length)} users
            </span>
          }
        />
        <div className="mt-3 overflow-hidden rounded-2xl border bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-2.5 font-medium">#</th>
                <th className="px-4 py-2.5 font-medium">User</th>
                <th className="px-4 py-2.5 text-right font-medium">Bonus earned</th>
                <th className="px-4 py-2.5 text-right font-medium">Bonuses</th>
                <th className="px-4 py-2.5 text-right font-medium">Largest</th>
              </tr>
            </thead>
            <tbody>
              {recipients.map((r, i) => (
                <tr key={r.userId} className="border-b last:border-0 hover:bg-muted/30">
                  <td className="px-4 py-2.5 tabular-nums text-muted-foreground">
                    {i + 1}
                  </td>
                  <td className="px-4 py-2.5">
                    <Link
                      href={`/users/${r.userId}`}
                      className="font-medium text-primary hover:underline"
                    >
                      {r.username ?? r.userId.slice(0, 8)}
                      <LinkPending size={12} />
                    </Link>
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums font-semibold text-rose-600 dark:text-rose-400">
                    {formatCurrency(r.bonus)}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">
                    {formatNumber(r.count)}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums">
                    {formatCurrency(r.max)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </FadeIn>
  );
}

function RecipientsSkeleton() {
  return (
    <div className="space-y-3">
      <div className="h-8 w-56 rounded bg-muted animate-pulse" />
      <div className="h-[420px] rounded-2xl border bg-muted/20 animate-pulse" />
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
