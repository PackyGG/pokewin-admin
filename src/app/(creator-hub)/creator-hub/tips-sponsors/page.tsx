import { Suspense } from "react";
import {
  Gift,
  HeartHandshake,
  LineChart as LineChartIcon,
  ListOrdered,
  Receipt,
  Scale,
} from "lucide-react";

import { requireCreatorHubPageAccess } from "@/lib/require-creator-hub-access";
import { KpiTile, SectionHeading } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import {
  parseDashboardPeriod,
  DASHBOARD_PERIOD_LABELS,
  type DashboardPeriod,
} from "@/lib/queries/dashboard-period";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { cn } from "@/lib/utils";

import { HubKpiInfoPopover } from "../_components/hub-kpi-info-popover";
import { HubNotice } from "../_components/hub-notice";
import { HubPeriodSelector } from "../_components/hub-period-selector";
import {
  getTipsSponsorsLedgerOverview,
  getTipsSponsorsSessionsOverview,
  SPONSOR_TYPE,
  TIP_TYPE,
} from "./_queries/tips-sponsors-data";
import { TipsSponsorsChart } from "./_components/tips-sponsors-chart";
import { CreatorSpendRanklist } from "./_components/creator-spend-ranklist";
import {
  ChartSkeleton,
  HeadlineLifetimeTileSkeleton,
  HeadlineSessionTilesSkeleton,
  RanklistSkeleton,
  ReconciliationSkeleton,
} from "./_components/tips-sponsors-skeleton";

export const metadata = { title: "Tips & Sponsors · Creator Hub" };

/**
 * Creator Hub — Tips & Sponsors.
 *
 * House-funded tips + battle sponsorships creators hand out from the fill
 * program pool. Two independent streams: the ledger leg (window Σ, lifetime,
 * 30-day trend — fast SQL) and the session leg (per-creator backend fan-out)
 * each render behind their own Suspense boundary, so the SQL KPIs never wait
 * on the slow roster walk.
 */
export default async function CreatorHubTipsSponsorsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireCreatorHubPageAccess();

  const period = parseDashboardPeriod((await searchParams).period);
  const windowLabel = DASHBOARD_PERIOD_LABELS[period].toLowerCase();

  return (
    <div className="space-y-6">
      {/* Headline — page opener carries the identity (PageHeroIdentity renders
          no titles by owner decision) and the period selector. */}
      <div className="space-y-3">
        <SectionHeading
          icon={Gift}
          title="Tips & Sponsors"
          action={<HubPeriodSelector current={period} />}
        />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Suspense
            key={`headline-sessions-${period}`}
            fallback={<HeadlineSessionTilesSkeleton />}
          >
            <HeadlineSessionTiles period={period} windowLabel={windowLabel} />
          </Suspense>
          <Suspense
            key={`headline-ledger-${period}`}
            fallback={<HeadlineLifetimeTileSkeleton />}
          >
            <HeadlineLifetimeTile period={period} />
          </Suspense>
        </div>
      </div>

      {/* Reconciliation — session counters vs ledger window, with an explicit
          delta (needs both legs; the ledger read is cached + fast). */}
      <div className="space-y-3">
        <SectionHeading icon={Scale} title="Reconciliation" />
        <Suspense
          key={`reconciliation-${period}`}
          fallback={<ReconciliationSkeleton />}
        >
          <ReconciliationRow period={period} windowLabel={windowLabel} />
        </Suspense>
      </div>

      {/* Breakdown — fixed 30-day trend + per-creator ranklist. */}
      <div className="space-y-3">
        <SectionHeading icon={LineChartIcon} title="Daily spend" />
        <Suspense key={`chart-${period}`} fallback={<ChartSkeleton />}>
          <ChartSection period={period} />
        </Suspense>
      </div>

      <div className="space-y-3">
        <SectionHeading
          icon={ListOrdered}
          title="By creator — session spend in window"
        />
        <Suspense key={`ranklist-${period}`} fallback={<RanklistSkeleton />}>
          <RanklistSection period={period} />
        </Suspense>
      </div>
    </div>
  );
}

// ─── Stream B: session leg (backend fan-out) ─────────────────────

async function HeadlineSessionTiles({
  period,
  windowLabel,
}: {
  period: DashboardPeriod;
  windowLabel: string;
}) {
  const { sessionsWindow } = await getTipsSponsorsSessionsOverview(period);

  return (
    <>
      <KpiTile
        label="Session spend"
        icon={Gift}
        accent="rose"
        value={formatCurrency(sessionsWindow.totalUsd)}
        sub={`${formatNumber(sessionsWindow.sessionsWithSpend)} sessions · ${formatNumber(sessionsWindow.creatorsWithSpend)} creators · ${windowLabel}`}
        live={sessionsWindow.activeSessionsWithSpend > 0}
        action={
          <HubKpiInfoPopover
            title="Session spend"
            description="Authoritative total from backend session counters — sums tips_spent_this_session_usd + sponsorship_spent_this_session_usd across all creators in the selected window."
            lines={[
              {
                label: "Sessions with spend",
                value: formatNumber(sessionsWindow.sessionsWithSpend),
                tone: "muted",
              },
              {
                label: "Live sessions with spend",
                value: formatNumber(sessionsWindow.activeSessionsWithSpend),
                tone: "muted",
              },
              {
                label: "Creators with spend",
                value: formatNumber(sessionsWindow.creatorsWithSpend),
                tone: "muted",
              },
            ]}
          />
        }
      />
      <KpiTile
        label="Tips vs sponsors"
        icon={HeartHandshake}
        accent="rose"
        value={formatCurrency(sessionsWindow.tipsUsd)}
        sub={`tips · ${formatCurrency(sessionsWindow.sponsorUsd)} sponsors`}
        action={
          <HubKpiInfoPopover
            title="Tips vs sponsors"
            description="Session-derived split of house-funded creator giveaways in the selected window."
            lines={[
              {
                label: `House tips · ${TIP_TYPE}`,
                value: formatCurrency(sessionsWindow.tipsUsd),
                tone: "rose",
              },
              {
                label: `Battle sponsorships · ${SPONSOR_TYPE}`,
                value: formatCurrency(sessionsWindow.sponsorUsd),
                tone: "rose",
              },
            ]}
            footer={{
              label: "Total",
              value: formatCurrency(sessionsWindow.totalUsd),
              tone: "rose",
            }}
          />
        }
      />
    </>
  );
}

async function RanklistSection({ period }: { period: DashboardPeriod }) {
  const { byCreator, backendUnavailable } =
    await getTipsSponsorsSessionsOverview(period);

  return (
    <FadeIn>
      <CreatorSpendRanklist
        rows={byCreator}
        backendUnavailable={backendUnavailable}
      />
    </FadeIn>
  );
}

// ─── Stream A: ledger leg (fast SQL) ─────────────────────────────

async function HeadlineLifetimeTile({ period }: { period: DashboardPeriod }) {
  const { lifetime } = await getTipsSponsorsLedgerOverview(period);

  return (
    <KpiTile
      label="Lifetime total"
      icon={Receipt}
      accent="rose"
      value={formatCurrency(lifetime.totalUsd)}
      sub={`${formatCurrency(lifetime.tipsUsd)} tips · ${formatCurrency(lifetime.sponsorUsd)} sponsors`}
    />
  );
}

async function ChartSection({ period }: { period: DashboardPeriod }) {
  const { chart30d } = await getTipsSponsorsLedgerOverview(period);
  return <TipsSponsorsChart data={chart30d} />;
}

// ─── Reconciliation (both legs) ──────────────────────────────────

async function ReconciliationRow({
  period,
  windowLabel,
}: {
  period: DashboardPeriod;
  windowLabel: string;
}) {
  const [{ ledgerWindow }, { sessionsWindow, backendUnavailable }] =
    await Promise.all([
      getTipsSponsorsLedgerOverview(period),
      getTipsSponsorsSessionsOverview(period),
    ]);

  if (backendUnavailable) {
    return (
      <HubNotice tone="amber" title="Session counters unavailable">
        The backend session API is unreachable, so the session-vs-ledger
        comparison can&apos;t be computed. Ledger window ({windowLabel}):{" "}
        {formatCurrency(ledgerWindow.totalUsd)} across{" "}
        {formatNumber(ledgerWindow.tipTxnCount + ledgerWindow.sponsorTxnCount)}{" "}
        txns.
      </HubNotice>
    );
  }

  // Ledger reads ~$0 while sessions carry spend → the ledger enum rows are
  // not populated yet. Say so instead of showing two silently contradicting
  // numbers.
  if (ledgerWindow.totalUsd < 0.01 && sessionsWindow.totalUsd >= 0.01) {
    return (
      <HubNotice
        tone="amber"
        icon={Scale}
        title="Ledger enum rows not populated yet — session counters are authoritative"
      >
        Sessions report {formatCurrency(sessionsWindow.totalUsd)} of tips +
        sponsor spend in the selected window ({windowLabel}), but the ledger
        carries no house-tip or battle-sponsorship rows for it yet.
      </HubNotice>
    );
  }

  const delta = sessionsWindow.totalUsd - ledgerWindow.totalUsd;
  const deltaIsZero = Math.abs(delta) < 0.01;

  return (
    <div className="grid grid-cols-1 gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-3">
      <ReconCell
        label="Session spend"
        value={formatCurrency(sessionsWindow.totalUsd)}
        sub={`backend counters · ${windowLabel}`}
        valueClassName="text-rose-600 dark:text-rose-400"
      />
      <ReconCell
        label="Ledger window"
        value={formatCurrency(ledgerWindow.totalUsd)}
        sub={`${formatNumber(ledgerWindow.tipTxnCount + ledgerWindow.sponsorTxnCount)} txns · ${windowLabel}`}
        valueClassName="text-rose-600 dark:text-rose-400"
      />
      <ReconCell
        label="Delta (session − ledger)"
        value={`${delta >= 0 ? "+" : "−"}${formatCurrency(Math.abs(delta))}`}
        sub={deltaIsZero ? "sources agree" : "sources disagree"}
        valueClassName={
          deltaIsZero
            ? "text-muted-foreground"
            : "text-amber-600 dark:text-amber-400"
        }
      />
    </div>
  );
}

function ReconCell({
  label,
  value,
  sub,
  valueClassName,
}: {
  label: string;
  value: string;
  sub: string;
  valueClassName?: string;
}) {
  return (
    <div className="bg-card px-4 py-3">
      <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </p>
      <p
        className={cn(
          "mt-1 text-lg font-bold leading-tight tracking-tight tabular-nums",
          valueClassName,
        )}
      >
        {value}
      </p>
      <p className="mt-0.5 text-[11px] text-muted-foreground">{sub}</p>
    </div>
  );
}
