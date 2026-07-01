import { Coins, Info, LineChart, TrendingDown, TrendingUp } from "lucide-react";

import { safeQueryOrNull } from "@/lib/errors/safe-query";
import { SectionHeading, StatPanel, PanelRow } from "@/components/modern-panels";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { cn } from "@/lib/utils";

import { compareCreatorsDetailPnl } from "@/lib/clickhouse/compare/creators-detail-pnl";

import { getCreatorPnlCached } from "./_queries/_pnl-cache";
import { CreatorPnlUsersPopover } from "./_components/creator-pnl-users-popover";
import type { getCreatorDetailCached } from "@/lib/queries/creators";

const DISPLAYED_PERIODS: Array<{
  key: "24h" | "3d" | "7d" | "14d" | "30d";
  label: string;
  sub: string;
}> = [
  { key: "24h", label: "1d", sub: "Last 24 hours" },
  { key: "3d", label: "3d", sub: "Last 3 days" },
  { key: "7d", label: "7d", sub: "Last week" },
  { key: "14d", label: "2w", sub: "Last 2 weeks" },
  { key: "30d", label: "1m", sub: "Last month" },
];

const PNL_TO_FTD_PERIOD: Record<(typeof DISPLAYED_PERIODS)[number]["key"], string> = {
  "24h": "1d",
  "3d": "3d",
  "7d": "7d",
  "14d": "14d",
  "30d": "30d",
};

/**
 * Per-creator House P&L panel for /creators/[userId]. Renders the
 * lifetime hero plus 5 windowed tiles (1d / 3d / 7d / 2w / 1m), all
 * driven by the same code-attributed formula:
 *
 *   pnl = deposits − cardWithdrawals
 *
 * Wagered is displayed alongside as an informational figure
 * (volume) but does NOT enter the formula — wagers spin back and
 * forth within the platform, only deposits cross the money-in
 * boundary and only physical card withdrawals cross the value-out
 * boundary.
 *
 * Attribution is event-level via `affiliate_code_usages`: each
 * deposit / wager row carries the code that was active at the time,
 * so a referred user who later switches codes stops contributing
 * from that point on and never gets attributed to multiple creators
 * for the same event.
 *
 * Card withdrawals are matched via
 * `card_withdrawal_requests.inventory_item_ids` → user_inventory →
 * the creator's session set; valued at `value_at_obtained`.
 *
 * House POV:
 *   pnl > 0 (emerald) — house retained more cash than card value
 *                       physically shipped out
 *   pnl < 0 (rose)    — physical cards out exceeded cash deposited
 */
export async function CreatorPnlPanel({
  userId,
  profileResultPromise,
}: {
  userId: string;
  profileResultPromise?: Promise<{
    data: Awaited<ReturnType<typeof getCreatorDetailCached>> | null;
    error: string | null;
  }>;
}) {
  // Degrade gracefully instead of throwing the whole creators segment into
  // its error boundary when the ledger scan fails or times out. Every other
  // heavy section on this page already fails soft (the deal-cost panel
  // `.catch`es its own getCreatorPnl, the KPI/acquisition bands run through
  // safeQueryOrNull); this is the one fetch that previously awaited raw, so
  // a Main-DB hiccup here used to take the entire page down. Now it renders a
  // compact "unavailable" state for THIS band and the rest of the page is
  // unaffected — matching the "load till it's possible" rule.
  //
  // `getCreatorPnlCached` memoizes the scan per creator (prod-pinned, 5-min
  // TTL) so repeat loads / retries don't re-pay it, and the underlying scan
  // runs with a raised per-statement timeout so the COLD populating run
  // actually completes and warms the cache. The safeQuery budget is sized to
  // MATCH that cold-run budget (60s) so it doesn't cut the populating scan
  // off before it can finish — a slow first load that then caches is fine;
  // "always times out" is not. Subsequent loads resolve from the warm entry
  // near-instantly.
  const [{ data, kind }, profileResult] = await Promise.all([
    safeQueryOrNull(
      () => getCreatorPnlCached(userId),
      "creators.detail.pnl",
      60_000,
    ),
    profileResultPromise ?? Promise.resolve({ data: null, error: null }),
  ]);
  const ftdByPeriod = profileResult.data?.ftdByPeriod ?? {};
  const lifetimeFtds = ftdByPeriod.all ?? 0;

  if (!data) {
    // Truthful band copy — a hard failure must not masquerade as "slow".
    const timedOut = kind === "timeout";
    return (
      <div className="space-y-3">
        <SectionHeading icon={LineChart} title="Affiliates PnL" />
        <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-sm">
          <Info className="size-4 mt-0.5 text-amber-500 shrink-0" />
          <div>
            <div className="font-medium text-amber-500">
              {timedOut
                ? "Affiliate P&L is taking too long to load"
                : "Affiliate P&L failed to load"}
            </div>
            <div className="mt-0.5 text-muted-foreground">
              {timedOut
                ? "The per-window deposit / card-withdrawal scan timed out. Refresh to retry — the rest of the page is unaffected."
                : "The per-window deposit / card-withdrawal scan failed — its data is unavailable right now. Refresh to retry; the rest of the page is unaffected."}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Phase 2B CQRS read-migration — fire-and-forget ClickHouse comparison of the
  // per-window + lifetime P&L headline (no-op unless `creators_detail_pnl` is in
  // comparison mode). The served value is ALWAYS the Postgres `data`; this only
  // logs drift and can never affect the rendered panel.
  void compareCreatorsDetailPnl(userId, data);

  const byPeriod = new Map(data.byPeriod.map((p) => [p.period, p]));

  const lifetimePnl = data.lifetime.pnl;
  const isLifetimeWin = lifetimePnl > 0;
  const isLifetimeLoss = lifetimePnl < 0;
  const lifetimeAccent: "emerald" | "rose" | "blue" = isLifetimeWin
    ? "emerald"
    : isLifetimeLoss
      ? "rose"
      : "blue";

  return (
    <div className="space-y-3">
      <SectionHeading icon={LineChart} title="Affiliates PnL" />

      {/* Lifetime (capped) hero — `deposits − cardWithdrawals` over the
          last 365 days of events booked against this creator's code. The
          window is capped (was full-history) so the lifetime scan stays an
          index range instead of a full-table seq-scan; the affiliate program
          is recent enough that 365 days covers effectively all attributed
          activity, so the figure is unchanged in practice. */}
      <StatPanel
        title="Lifetime (capped)"
        icon={
          isLifetimeWin
            ? TrendingUp
            : isLifetimeLoss
              ? TrendingDown
              : LineChart
        }
        accent={lifetimeAccent}
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <div
              className={cn(
                "text-3xl font-bold tabular-nums leading-none sm:text-4xl",
                isLifetimeWin
                  ? "text-emerald-600 dark:text-emerald-400"
                  : isLifetimeLoss
                    ? "text-rose-600 dark:text-rose-400"
                    : "text-muted-foreground",
              )}
              title="Lifetime House P&L (last 365 days) — deposits under this code minus physical card withdrawals from its sessions"
            >
              {lifetimePnl === 0
                ? "—"
                : `${isLifetimeWin ? "+" : ""}${formatCurrency(lifetimePnl)}`}
            </div>
            <p className="text-xs text-muted-foreground">
              Lifetime House P&amp;L from this creator&apos;s affiliates
              {" "}
              <span className="text-[10px]">(last 365 days)</span>
              <br />
              <span className="text-[10px]">
                Positive (emerald) = we kept value · Negative (rose) =
                cards out &gt; cash in
              </span>
            </p>
          </div>
          {data.lifetime.totalWagered > 0 && (
            <div
              className="space-y-1 text-left sm:text-right"
              title="Sum of every wager booked against this creator's code — lifetime. Informational, not in the PnL formula."
            >
              <div className="text-xl font-bold tabular-nums leading-none sm:text-2xl">
                {formatCurrency(data.lifetime.totalWagered)}
              </div>
              <p className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <Coins className="size-3" />
                Lifetime Wagered
              </p>
            </div>
          )}
        </div>
        <div className="mt-3 flex items-start gap-2 rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
          <Info className="size-3.5 shrink-0 mt-0.5" />
          <span>
            Per-code attribution from{" "}
            <code className="font-mono">affiliate_code_usages</code>:
            deposits booked against this creator&apos;s code and physical
            card withdrawals for cards obtained in its sessions. Wagered
            shown as volume context, not in the formula. Excludes
            creator deal cost — combine with the FinancialsCard for net
            creator economics.
          </span>
        </div>
        <div className="mt-4 grid grid-cols-1 gap-y-0.5 sm:grid-cols-2 lg:grid-cols-4 sm:gap-x-6">
          <PanelRow
            label="Deposits"
            value={
              data.lifetime.totalDeposits === 0
                ? "—"
                : formatCurrency(data.lifetime.totalDeposits)
            }
            valueClassName={
              data.lifetime.totalDeposits > 0
                ? "text-emerald-600 dark:text-emerald-400"
                : ""
            }
          />
          <PanelRow
            label="FTDs"
            value={lifetimeFtds === 0 ? "—" : formatNumber(lifetimeFtds)}
            valueClassName={
              lifetimeFtds > 0 ? "text-purple-600 dark:text-purple-400" : ""
            }
          />
          <PanelRow
            label="Wagered"
            value={
              data.lifetime.totalWagered === 0
                ? "—"
                : formatCurrency(data.lifetime.totalWagered)
            }
            valueClassName="text-muted-foreground"
          />
          {/* Card Withdrawals row intentionally omitted — the money-out figure
              is not surfaced (owner request). The lifetime P&L above still nets
              it (`deposits − cardWithdrawals`); only the standalone row is
              hidden, so the P&L number is unchanged. */}
        </div>
      </StatPanel>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {DISPLAYED_PERIODS.map(({ key, label, sub }) => {
          const row = byPeriod.get(key);
          const pnl = row?.pnl ?? 0;
          const deposits = row?.deposits ?? 0;
          const wagered = row?.wagered ?? 0;
          const ftds = ftdByPeriod[PNL_TO_FTD_PERIOD[key]] ?? 0;
          const isWin = pnl > 0;
          const isLoss = pnl < 0;
          const accent: "emerald" | "rose" | "blue" = isWin
            ? "emerald"
            : isLoss
              ? "rose"
              : "blue";
          return (
            <StatPanel
              key={key}
              title={label}
              icon={isWin ? TrendingUp : isLoss ? TrendingDown : LineChart}
              accent={accent}
              action={
                <CreatorPnlUsersPopover
                  users={row?.users ?? []}
                  periodLabel={sub}
                />
              }
            >
              <div className="space-y-1.5">
                <div
                  className={cn(
                    "text-xl font-bold tabular-nums leading-none",
                    isWin
                      ? "text-emerald-600 dark:text-emerald-400"
                      : isLoss
                        ? "text-rose-600 dark:text-rose-400"
                        : "text-muted-foreground",
                  )}
                  title={`House P&L — ${sub}`}
                >
                  {pnl === 0 ? "—" : formatCurrency(pnl)}
                </div>
                <p className="text-[10px] text-muted-foreground">{sub}</p>
              </div>
              <div className="mt-3 space-y-0.5">
                <PanelRow
                  label="Deposits"
                  value={deposits === 0 ? "—" : formatCurrency(deposits)}
                  valueClassName={
                    deposits > 0
                      ? "text-emerald-600 dark:text-emerald-400"
                      : ""
                  }
                />
                <PanelRow
                  label="FTDs"
                  value={ftds === 0 ? "—" : formatNumber(ftds)}
                  valueClassName={
                    ftds > 0 ? "text-purple-600 dark:text-purple-400" : ""
                  }
                />
                <PanelRow
                  label="Wagered"
                  value={wagered === 0 ? "—" : formatCurrency(wagered)}
                  valueClassName="text-muted-foreground"
                />
                {/* Card WD row intentionally omitted — money-out figure not
                    surfaced (owner request). The P&L above still nets it. */}
              </div>
            </StatPanel>
          );
        })}
      </div>

      <p className="text-[11px] text-muted-foreground">
        House P&amp;L = deposits − card withdrawals. Wagered shown for
        volume context, not in the formula. FTDs = distinct referred users
        with a deposit under this creator&apos;s code in the window (same
        source as the funnel table). Attribution is event-level
        from <code className="font-mono">affiliate_code_usages</code>:
        each event carries the code that was active at the time. Card
        withdrawals are matched via{" "}
        <code className="font-mono">inventory_item_ids</code> →{" "}
        <code className="font-mono">user_inventory.source_id</code>.
        Excludes admin / support / creator role accounts and creator
        deal cost (commission, tips, fills) — that lives on the
        FinancialsCard. Positive (emerald) = we kept value.
      </p>
    </div>
  );
}
