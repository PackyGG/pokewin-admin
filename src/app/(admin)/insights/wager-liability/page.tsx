import {
  Lock,
  Users,
  ShieldCheck,
  Gauge,
  Gift,
  Share2,
  Percent,
  HandCoins,
  Layers,
  type LucideIcon,
} from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
  KpiTile,
  StatPanel,
  PanelRow,
  type AccentColor,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import {
  getWagerLiability,
  type WagerLiabilityAvailable,
  type WagerLiabilitySource,
} from "@/lib/queries/insights-wager-liability";
import { CohortChart } from "./cohort-chart";

export const metadata = { title: "Wager Liability" };

/**
 * /insights/wager-liability — the platform-wide wager-requirement liability
 * dashboard. The operational heart of the sweepstakes model, which until now
 * was only visible per user (the wager-progress card on /users/[id]).
 *
 * CURRENT-STATE SNAPSHOT: `balances.unwagered_*_usd` /
 * `wager_requirement_progress` are point-in-time counters the backend
 * overwrites in place — there is NO time-series — so this is a "right now"
 * dashboard with NO period selector (per the spec).
 *
 * House-POV colours: every gated/locked user balance is money WE OWE users
 * but is currently withheld → rose. Plain counts (blocked / exempt /
 * progress / cohort) are neutral → blue / cyan. See CLAUDE.md "Finanz-Farben".
 *
 * Customer-scoped via `getMetricsScope()` inside the query, so staff /
 * creators / blacklist never inflate the liability total.
 */
export default async function WagerLiabilityPage() {
  await requirePageAccess("/insights/wager-liability");

  const { data, error } = await safeQuery(
    () => getWagerLiability(),
    null,
    "insights.wagerLiability",
    REWARD_QUERY_TIMEOUT_MS,
  );

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Lock}
          accent="rose"
          title="Wager Liability"
          subtitle="Gated user balances held behind the lifetime wager requirement — current snapshot"
        />
      </PageHero>

      {error || !data ? (
        <TileErrorFallback
          label="Wager Liability"
          hint="The wager-liability aggregation failed. Server logs hold the digest."
          size="panel"
        />
      ) : !data.available ? (
        <UnavailableState />
      ) : (
        <FadeIn>
          <LiabilityBody data={data} />
        </FadeIn>
      )}
    </div>
  );
}

// ─── Unavailable (column not present on this DB) ────────────────────────

/**
 * Muted state when the connected game DB lacks the sweepstakes
 * `balances.wager_requirement_progress` column (prod schema drift). Never a
 * 42703 — the query returns `{ available: false }` and we explain why.
 */
function UnavailableState() {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 p-10 text-center">
        <div className="flex size-12 items-center justify-center rounded-xl border border-border/70 bg-muted/40">
          <Lock className="size-6 text-muted-foreground" />
        </div>
        <div className="space-y-1">
          <p className="text-sm font-semibold">
            Wager liability not available on this database
          </p>
          <p className="mx-auto max-w-md text-xs text-muted-foreground">
            The connected game database does not carry the sweepstakes
            wager-requirement columns (<code>unwagered_*_usd</code> /{" "}
            <code>wager_requirement_progress</code>). Switch to a database where
            the sweepstakes model is live to see the liability snapshot.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Body ───────────────────────────────────────────────────────────────

function LiabilityBody({ data }: { data: WagerLiabilityAvailable }) {
  const cohortData = data.buckets.map((b) => ({
    label: b.label,
    users: b.users,
    lockedUsd: b.lockedUsd,
  }));
  const notBlocked = Math.max(0, data.totalCustomers - data.blockedUsers);

  return (
    <div className="space-y-6">
      {/* KPI strip — gated liability is money we owe (rose); counts neutral. */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiTile
          label="Total gated liability"
          value={formatCurrency(data.totalGatedUsd)}
          sub="locked across all customers"
          icon={Lock}
          accent="rose"
        />
        <KpiTile
          label="Customers blocked"
          value={formatNumber(data.blockedUsers)}
          sub={`of ${formatNumber(data.totalCustomers)} with any locked balance`}
          icon={Users}
          accent="blue"
        />
        <KpiTile
          label="Exempt customers"
          value={formatNumber(data.exemptUsers)}
          sub="per-user override = 0 bps"
          icon={ShieldCheck}
          accent="cyan"
        />
        <KpiTile
          label="Wager progress cleared"
          value={formatCurrency(data.totalProgress)}
          sub="weighted wager toward requirement"
          icon={Gauge}
          accent="blue"
        />
      </div>

      {/* Locked-by-source breakdown */}
      <section className="space-y-3">
        <SectionHeading
          icon={Layers}
          title="Locked by source"
        />
        <LockedBySource data={data} />
      </section>

      {/* Cohort: blocked vs not + size buckets */}
      <section className="space-y-3">
        <SectionHeading icon={Users} title="Blocked-customer cohort" />
        <div className="grid gap-4 lg:grid-cols-2">
          <CohortSplit
            blocked={data.blockedUsers}
            notBlocked={notBlocked}
            total={data.totalCustomers}
          />
          <Card>
            <CardContent className="space-y-3 p-4 sm:p-5">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Blocked by locked-balance size
                </p>
                <span className="text-[11px] text-muted-foreground">
                  {formatNumber(data.blockedUsers)} blocked
                </span>
              </div>
              {data.blockedUsers > 0 ? (
                <CohortChart data={cohortData} />
              ) : (
                <p className="py-12 text-center text-sm text-muted-foreground">
                  No customers are currently blocked.
                </p>
              )}
            </CardContent>
          </Card>
        </div>
        <CohortTable data={data} />
      </section>

      <p className="text-[11px] leading-snug text-muted-foreground">
        Current snapshot — <code>balances.unwagered_*_usd</code> are
        point-in-time counters maintained by the backend, not a time-series, so
        there is no period selector. Customer-scoped (staff, creators and the
        excluded-users blacklist are dropped, identical to every other money
        surface). House perspective: a locked balance is user money we owe but
        is gated behind the wager requirement.
      </p>
    </div>
  );
}

// ─── Locked by source ───────────────────────────────────────────────────

const SOURCE_ICON: Record<WagerLiabilitySource["key"], LucideIcon> = {
  bonus: Gift,
  affiliate: Share2,
  rakeback: Percent,
  tips: HandCoins,
};

/**
 * The big rose StatPanel: total gated liability as the hero number, with a
 * per-source breakdown row + a proportional bar per source. Every figure is
 * a locked user balance → rose (House-POV: money we owe).
 */
function LockedBySource({ data }: { data: WagerLiabilityAvailable }) {
  const maxMag = Math.max(...data.sources.map((s) => s.lockedUsd), 1);
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,_20rem)_1fr]">
      <StatPanel title="Total gated liability" icon={Lock} accent="rose">
        <p className="text-3xl font-bold leading-tight tracking-tight tabular-nums text-rose-600 dark:text-rose-400 sm:text-4xl">
          {formatCurrency(data.totalGatedUsd)}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          held behind the wager requirement across{" "}
          {formatNumber(data.blockedUsers)} blocked customers
        </p>
        <div className="mt-4 space-y-0.5 border-t border-border/60 pt-3">
          {data.sources.map((s) => (
            <PanelRow
              key={s.key}
              label={s.label}
              value={formatCurrency(s.lockedUsd)}
              valueClassName="text-rose-600 dark:text-rose-400"
            />
          ))}
        </div>
      </StatPanel>

      <Card>
        <CardContent className="space-y-3 p-4 sm:p-5">
          {data.sources.map((s) => {
            const Icon = SOURCE_ICON[s.key];
            const widthPct = Math.min(
              100,
              Math.max(2, (s.lockedUsd / maxMag) * 100),
            );
            return (
              <div key={s.key} className="space-y-1">
                <div className="flex items-baseline justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <Icon className="size-3.5 shrink-0 text-rose-500" />
                    <span className="truncate text-sm font-medium">
                      {s.label}
                    </span>
                    <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                      {formatNumber(s.users)} user
                      {s.users === 1 ? "" : "s"}
                    </span>
                  </div>
                  <span className="shrink-0 font-mono text-sm font-semibold tabular-nums text-rose-600 dark:text-rose-400">
                    {formatCurrency(s.lockedUsd)}
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted/60">
                  <div
                    className="h-full rounded-full bg-rose-500/70"
                    style={{ width: `${widthPct}%` }}
                  />
                </div>
              </div>
            );
          })}
          <p className="border-t border-border/60 pt-2.5 text-[10px] leading-snug text-muted-foreground">
            &ldquo;Bonus &amp; race prizes&rdquo; merges the bonus and
            race-prize buckets (<code>unwagered_bonus_other_usd</code> +{" "}
            <code>unwagered_race_prize_usd</code>) — the same grouping as the
            per-user wager-progress card.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Cohort split (blocked vs not) ──────────────────────────────────────

/**
 * Blocked vs not-blocked split with a proportional stacked bar. Neutral
 * counts → blue (blocked) vs muted (clear), no money tinting.
 */
function CohortSplit({
  blocked,
  notBlocked,
  total,
}: {
  blocked: number;
  notBlocked: number;
  total: number;
}) {
  const blockedPct = total > 0 ? (blocked / total) * 100 : 0;
  const tiles: Array<{
    label: string;
    value: number;
    sub: string;
    accent: AccentColor;
  }> = [
    {
      label: "Blocked",
      value: blocked,
      sub: total > 0 ? `${blockedPct.toFixed(1)}% of customers` : "—",
      accent: "blue",
    },
    {
      label: "Not blocked",
      value: notBlocked,
      sub: total > 0 ? `${(100 - blockedPct).toFixed(1)}% clear` : "—",
      accent: "cyan",
    },
  ];
  return (
    <Card>
      <CardContent className="space-y-4 p-4 sm:p-5">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Blocked vs clear
        </p>
        <div className="grid grid-cols-2 gap-3">
          {tiles.map((t) => (
            <div
              key={t.label}
              className="rounded-xl border bg-card p-3 ring-1 ring-foreground/10"
            >
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {t.label}
              </span>
              <p
                className={cn(
                  "mt-1 text-2xl font-bold tabular-nums",
                  t.accent === "blue"
                    ? "text-blue-600 dark:text-blue-400"
                    : "text-cyan-600 dark:text-cyan-400",
                )}
              >
                {formatNumber(t.value)}
              </p>
              <p className="mt-0.5 text-[10px] text-muted-foreground">{t.sub}</p>
            </div>
          ))}
        </div>
        <div
          className="flex h-2 overflow-hidden rounded-full bg-muted/60"
          aria-hidden
        >
          <div
            className="h-full bg-blue-500/70"
            style={{ width: `${blockedPct}%` }}
          />
          <div
            className="h-full bg-cyan-500/40"
            style={{ width: `${100 - blockedPct}%` }}
          />
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Cohort table (size buckets) ────────────────────────────────────────

function CohortTable({ data }: { data: WagerLiabilityAvailable }) {
  const rows = data.buckets;
  const totalLocked = rows.reduce((s, b) => s + b.lockedUsd, 0);
  return (
    <Card>
      <CardContent className="p-0">
        <div className="grid grid-cols-[1fr_minmax(0,_6rem)_minmax(0,_8rem)] items-center gap-2 border-b bg-muted/30 px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground sm:gap-3">
          <span>Locked-balance band</span>
          <span className="text-right">Blocked</span>
          <span className="text-right">Locked</span>
        </div>
        <ul>
          {rows.map((b) => (
            <li
              key={b.label}
              className="grid grid-cols-[1fr_minmax(0,_6rem)_minmax(0,_8rem)] items-center gap-2 border-b border-border/60 px-4 py-2.5 text-xs last:border-b-0 sm:gap-3"
            >
              <span className="truncate font-medium">{b.label}</span>
              <span className="text-right tabular-nums text-muted-foreground">
                {formatNumber(b.users)}
              </span>
              <span className="text-right font-mono font-semibold tabular-nums text-rose-600 dark:text-rose-400">
                {formatCurrency(b.lockedUsd)}
              </span>
            </li>
          ))}
        </ul>
        <div className="grid grid-cols-[1fr_minmax(0,_6rem)_minmax(0,_8rem)] items-center gap-2 border-t bg-muted/20 px-4 py-2.5 text-xs sm:gap-3">
          <span className="font-semibold">Total</span>
          <span className="text-right font-semibold tabular-nums">
            {formatNumber(data.blockedUsers)}
          </span>
          <span className="text-right font-mono font-semibold tabular-nums text-rose-600 dark:text-rose-400">
            {formatCurrency(totalLocked)}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
