import { HandCoins, Scale } from "lucide-react";

import { SectionHeading } from "@/components/modern-panels";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/empty-state";
import { safeQueryOrNull } from "@/lib/errors/safe-query";
import { formatCurrency, formatDate } from "@/lib/utils/format";
import { cn } from "@/lib/utils";

// Cached wrapper over the EXISTING backend deal read (60s TTL, tag-flushed
// on deal creation) — the uncached read re-fired 3 backend GETs on every
// Overview re-render, including each `?activityPeriod=` switch.
import { getDealCardDataCached } from "../_queries/deal-card-data";
import type { CreatorDealResponse } from "@/lib/backend-api";
import type { AdminCreatorPnlDeal } from "@/lib/creator-pnl-settlement";
import {
  getCreatorApprovalDealMarker,
  selectLiveCreatorDealPeriods,
} from "@/lib/creator-approval-deal-ids";
import { NewDealDialog } from "./new-deal-dialog";
import { DealCardActions, PreviousDealsButton } from "./deal-actions";
import { PnlCalculateButton, PnlSettlementButton } from "./pnl-settlement-button";
import { PnlDealControls } from "./pnl-deal-controls";
import { DEAL_STATUS_COLORS } from "./status-badges";

/**
 * Deal card (left half of the Overview "Deal | Affiliate Leaderboards" row).
 *
 * Shows this creator's CURRENT weekly-fill deal terms read from the existing
 * backend deal read (`getCreatorDealData`) — fills, per-fill amount, withdraw
 * cap (used / total), conversion rate, tip + sponsor caps, leaderboard
 * allowances. Picks the active deal if one exists, else the most recent.
 *
 * Actions: "New Deal" (primary, opens the hub-native create dialog) + a
 * compact overflow menu holding Edit terms / Previous deals / Terminate
 * (typed confirmation). Nothing fabricated: a creator with no deal shows a
 * clean empty state; a backend outage shows a degraded note.
 *
 * Streamed in its own Suspense boundary from the Overview tab.
 */

function num(v: string | null | undefined): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function DealTerm({
  label,
  value,
  valueClassName,
}: {
  label: string;
  value: string;
  valueClassName?: string;
}) {
  return (
    <div className="rounded-lg border bg-background/40 px-3 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={cn("mt-0.5 text-sm font-semibold tabular-nums", valueClassName)}>
        {value}
      </div>
    </div>
  );
}

export async function DealCard({
  userId,
}: {
  userId: string;
}) {
  const heading = (
    <SectionHeading
      icon={HandCoins}
      title="Deal"
      action={<NewDealDialog userId={userId} />}
    />
  );

  const { data, error } = await safeQueryOrNull(
    () => getDealCardDataCached(userId),
    "creator-hub.creators.dealData",
    20_000,
  );

  if (error) {
    return (
      <div className="flex h-full flex-col gap-3">
        {heading}
        <Card size="sm" className="flex-1">
          <CardContent className="flex flex-1 items-center justify-center py-6">
            <p className="text-sm text-muted-foreground">
              Could not load the deal — the backend was unreachable. Refresh to
              retry.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const deals: CreatorDealResponse[] = data?.deals.data ?? [];
  const pnlDeals: AdminCreatorPnlDeal[] = data?.pnlDeals ?? [];
  const previousPnlDeals = pnlDeals.filter(
    (item) => item.status === "settled" || item.status === "cancelled",
  );
  const pnlDeal =
    pnlDeals.find((item) => item.status === "crediting") ??
    pnlDeals.find((item) => item.status === "calculated") ??
    pnlDeals.find((item) => item.status === "settlement_pending") ??
    pnlDeals.find((item) => item.status === "active") ??
    pnlDeals
      .filter((item) => item.status === "scheduled")
      .sort((a, b) => a.frame_start_utc.localeCompare(b.frame_start_utc))[0] ??
    null;

  if (pnlDeal) {
    return <PnlDealCard userId={userId} deal={pnlDeal} allDeals={pnlDeals} />;
  }
  // A recurring cap is provisioned as one backend row per cap period. Keep
  // the whole live schedule visible: selecting just the active row hid every
  // subsequent week even though it had been provisioned correctly.
  const liveDeals = selectLiveCreatorDealPeriods(deals);
  const deal = liveDeals[0] ?? null;

  // The live deal drives the terminate / edit actions (both apply to an
  // active or a not-yet-started scheduled deal, same as the admin deals
  // table). "Previous" = deals ended by any means (completed/terminated).
  const previousDeals = deals.filter(
    (d) => d.status === "completed" || d.status === "terminated",
  );

  if (!deal) {
    const ended = previousDeals.length > 0;
    return (
      <div className="flex h-full flex-col gap-3">
        <SectionHeading
          icon={HandCoins}
          title="Deal"
          action={
            <div className="flex flex-wrap items-center gap-2">
              <PreviousDealsButton deals={previousDeals} />
              <PnlDealControls userId={userId} current={null} previous={previousPnlDeals} />
              <NewDealDialog userId={userId} />
            </div>
          }
        />
        <Card size="sm" className="flex-1">
          <CardContent className="flex flex-1 items-center justify-center py-2">
            <EmptyState
              icon={HandCoins}
              title={ended ? "No active deal" : "No deal yet"}
              description={
                ended
                  ? `This creator's last deal ended. ${previousDeals.length} previous deal${previousDeals.length === 1 ? "" : "s"} are in the actions menu. Use New Deal to set up a new one.`
                  : "This creator has no fill deal. Use New Deal to set one up."
              }
              compact
            />
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-3">
      <SectionHeading
        icon={HandCoins}
        title="Deal"
        action={
          <div className="flex flex-wrap items-center gap-2">
            <PreviousDealsButton deals={previousDeals} />
            <PnlDealControls userId={userId} current={null} previous={previousPnlDeals} />
            <NewDealDialog userId={userId} />
          </div>
        }
      />
      <Card size="sm" className="flex-1">
        <CardContent className="divide-y p-0">
          {liveDeals.map((liveDeal) => {
            const marker = getCreatorApprovalDealMarker(liveDeal);
            const withdrawCap = liveDeal.total_withdraw_cap_usd;
            const withdrawCapUsed = num(liveDeal.withdraw_cap_used_usd);

            return (
              <div key={liveDeal.id} className="space-y-3 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      variant="outline"
                      className={cn(
                        "text-[10px] capitalize",
                        DEAL_STATUS_COLORS[liveDeal.status],
                      )}
                    >
                      {liveDeal.status}
                    </Badge>
                    {marker?.periodCount && marker.periodCount > 1 && (
                      <Badge variant="secondary" className="text-[10px]">
                        Week {marker.periodIndex + 1} of {marker.periodCount}
                      </Badge>
                    )}
                    <span className="text-xs text-muted-foreground">
                      {formatDate(liveDeal.week_start_utc)} → {formatDate(liveDeal.week_end_utc)}
                    </span>
                  </div>
                  <span className="text-[11px] text-muted-foreground">
                    v{liveDeal.version}
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  <DealTerm label="Fills" value={`${liveDeal.fills_used} / ${liveDeal.fills_allowed}`} />
                  <DealTerm label="Per fill" value={formatCurrency(num(liveDeal.per_fill_amount_usd))} />
                  <DealTerm label="Conversion" value={`${(liveDeal.conversion_rate_bps / 100).toFixed(2)}%`} />
                  <DealTerm
                    label="Withdraw cap"
                    value={withdrawCap == null ? "—" : `${formatCurrency(withdrawCapUsed)} / ${formatCurrency(num(withdrawCap))}`}
                    valueClassName={withdrawCap != null ? "text-rose-600 dark:text-rose-400" : undefined}
                  />
                  <DealTerm label="Tip / stream" value={formatCurrency(num(liveDeal.max_tip_per_stream_usd))} />
                  <DealTerm label="Sponsor / stream" value={formatCurrency(num(liveDeal.max_sponsorship_per_stream_usd))} />
                </div>

                <div className="flex flex-wrap items-center gap-1.5 pt-1">
                  <Badge
                    variant="outline"
                    className={cn(
                      "text-[10px]",
                      liveDeal.allow_code_leaderboards
                        ? "border-emerald-500/30 text-emerald-600 dark:text-emerald-400"
                        : "text-muted-foreground",
                    )}
                  >
                    Code leaderboards {liveDeal.allow_code_leaderboards ? "on" : "off"}
                  </Badge>
                  <Badge
                    variant="outline"
                    className={cn(
                      "text-[10px]",
                      liveDeal.allow_site_leaderboards
                        ? "border-emerald-500/30 text-emerald-600 dark:text-emerald-400"
                        : "text-muted-foreground",
                    )}
                  >
                    Site leaderboards {liveDeal.allow_site_leaderboards ? "on" : "off"}
                  </Badge>
                  <div className="ml-auto flex items-center gap-1.5">
                    <DealCardActions userId={userId} deal={liveDeal} />
                  </div>
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}

const PNL_STATUS_COLORS: Record<AdminCreatorPnlDeal["status"], string> = {
  scheduled: "border-blue-500/30 text-blue-600 dark:text-blue-400",
  active: "border-emerald-500/30 text-emerald-600 dark:text-emerald-400",
  settlement_pending: "border-amber-500/30 text-amber-600 dark:text-amber-400",
  calculated: "border-violet-500/30 text-violet-600 dark:text-violet-400",
  crediting: "border-orange-500/30 text-orange-600 dark:text-orange-400",
  settled: "border-zinc-500/30 text-zinc-600 dark:text-zinc-400",
  cancelled: "border-rose-500/30 text-rose-600 dark:text-rose-400",
};

function PnlDealCard({ userId, deal, allDeals }: { userId: string; deal: AdminCreatorPnlDeal; allDeals: AdminCreatorPnlDeal[] }) {
  const framePnl = deal.frame_site_pnl_usd == null ? null : num(deal.frame_site_pnl_usd);
  const creatorShare = deal.creator_share_usd == null ? null : num(deal.creator_share_usd);
  const fundingLabel =
    deal.funding_mode === "non_withdrawable_fills"
      ? `${num(String(deal.funding_config.fills_allowed ?? 0))} non-withdrawable fills`
      : deal.funding_mode === "linked_multiplier"
        ? "Linked multiplier"
        : "New multiplier";
  const frameEnded = new Date(deal.frame_end_utc).getTime() <= Date.now();
  const canCalculate = frameEnded && ["scheduled", "active", "settlement_pending"].includes(deal.status);
  const canCredit = frameEnded && ["calculated", "crediting"].includes(deal.status);

  return (
    <div className="flex h-full flex-col gap-3">
      <SectionHeading
        icon={Scale}
        title="PnL Deal"
        action={<div className="flex items-center gap-2"><PnlDealControls userId={userId} current={deal} previous={allDeals.filter((item) => item.status === "settled" || item.status === "cancelled")} /><NewDealDialog userId={userId} /></div>}
      />
      <Card size="sm" className="flex-1">
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Badge variant="outline" className={cn("text-[10px] capitalize", PNL_STATUS_COLORS[deal.status])}>
                {deal.status.replaceAll("_", " ")}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {formatDate(deal.frame_start_utc)} → {formatDate(deal.frame_end_utc)}
              </span>
            </div>
            <span className="text-[11px] text-muted-foreground">v{deal.version}</span>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <DealTerm label="Positive PnL share" value={`${deal.positive_pnl_share_bps / 100}%`} valueClassName="text-pink-600 dark:text-pink-400" />
            <DealTerm label="Funding" value={fundingLabel} />
            <DealTerm label="Withdrawals" value={deal.funding_mode === "non_withdrawable_fills" ? "Disabled" : "Multiplier rules"} />
            <DealTerm label="Tip / stream" value={formatCurrency(num(deal.max_tip_per_stream_usd))} />
            <DealTerm label="Sponsor / stream" value={formatCurrency(num(deal.max_sponsorship_per_stream_usd))} />
            <DealTerm
              label="Creator payout"
              value={creatorShare == null ? "Pending frame settlement" : formatCurrency(creatorShare)}
              valueClassName={creatorShare != null ? "text-rose-600 dark:text-rose-400" : undefined}
            />
          </div>

          <div className="rounded-lg border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
            Frame PnL = affiliate contribution + real-money-weighted creator
            gameplay − realized leaderboard, fill cashout, tip, sponsorship,
            and reward costs. The creator receives only the agreed share of
            positive PnL; a negative frame pays $0.
            {framePnl != null && (
              <span className="ml-1 font-semibold text-foreground">
                Settled frame PnL: {framePnl >= 0 ? "+" : ""}{formatCurrency(framePnl)}.
              </span>
            )}
          </div>
          {deal.funding_mode !== "non_withdrawable_fills" && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              Multiplier funding currently cannot spend the stored tip or sponsor caps. Those terms are shown for audit only until platform support is added.
            </div>
          )}
          {deal.settlement_breakdown && (
            <details className="rounded-lg border px-3 py-2 text-xs">
              <summary className="cursor-pointer font-medium">Frozen calculation breakdown</summary>
              <pre className="mt-2 max-h-48 overflow-auto text-[10px]">{JSON.stringify(deal.settlement_breakdown, null, 2)}</pre>
            </details>
          )}
          {(canCalculate || canCredit) && (
            <div className="flex items-center justify-between gap-3 border-t pt-3">
              <span className="text-xs text-muted-foreground">
                {canCalculate
                  ? "Calculate and freeze the exact UTC frame before choosing a manual payout."
                  : "The calculation is frozen. Review it, then enter the approved manual credit."}
              </span>
              {canCalculate ? <PnlCalculateButton userId={userId} dealId={deal.id} expectedVersion={deal.version} /> : <PnlSettlementButton
                userId={userId}
                dealId={deal.id}
                expectedVersion={deal.version}
                computedShareUsd={creatorShare}
                initialAmountUsd={deal.credited_amount_usd == null ? null : num(deal.credited_amount_usd)}
                retry={deal.status === "crediting" || deal.credit_status === "failed"}
              />}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
