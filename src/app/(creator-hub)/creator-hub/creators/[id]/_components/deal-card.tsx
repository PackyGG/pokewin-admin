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
import type { PnlDealResponse } from "@/lib/backend-api/pnl-deals";
import { NewDealDialog } from "./new-deal-dialog";
import { DealCardActions, PreviousDealsButton } from "./deal-actions";
import { PnlSettlementButton } from "./pnl-settlement-button";
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
  const pnlDeals: PnlDealResponse[] = data?.pnlDeals ?? [];
  const previousPnlDeals = pnlDeals.filter(
    (item) => item.status === "settled" || item.status === "cancelled",
  );
  const pnlDeal =
    pnlDeals.find((item) => item.status === "active") ??
    pnlDeals.find((item) => item.status === "settlement_pending") ??
    pnlDeals
      .filter((item) => item.status === "scheduled")
      .sort((a, b) => a.frame_start_utc.localeCompare(b.frame_start_utc))[0] ??
    null;

  if (pnlDeal) {
    return <PnlDealCard userId={userId} deal={pnlDeal} allDeals={pnlDeals} />;
  }
  // Only a LIVE deal belongs in this card: the active one, else the next
  // scheduled one. An ended deal (completed/terminated) must NEVER be shown
  // here as if it were the creator's terms — it lives in "Previous deals".
  const deal =
    deals.find((d) => d.status === "active") ??
    deals
      .filter((d) => d.status === "scheduled")
      .sort((a, b) => a.week_start_utc.localeCompare(b.week_start_utc))[0] ??
    null;

  // The live deal drives the terminate / edit actions (both apply to an
  // active or a not-yet-started scheduled deal, same as the admin deals
  // table). "Previous" = deals ended by any means (completed/terminated).
  const activeDeal = deal;
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

  const withdrawCap = deal.total_withdraw_cap_usd;
  const withdrawCapUsed = num(deal.withdraw_cap_used_usd);

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
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Badge
                variant="outline"
                className={cn(
                  "text-[10px] capitalize",
                  DEAL_STATUS_COLORS[deal.status],
                )}
              >
                {deal.status}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {formatDate(deal.week_start_utc)} → {formatDate(deal.week_end_utc)}
              </span>
            </div>
            <span className="text-[11px] text-muted-foreground">
              v{deal.version}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <DealTerm
              label="Fills"
              value={`${deal.fills_used} / ${deal.fills_allowed}`}
            />
            <DealTerm
              label="Per fill"
              value={formatCurrency(num(deal.per_fill_amount_usd))}
            />
            <DealTerm
              label="Conversion"
              value={`${(deal.conversion_rate_bps / 100).toFixed(2)}%`}
            />
            {/* Withdraw cap is the house's payout exposure → rose. */}
            <DealTerm
              label="Withdraw cap"
              value={
                withdrawCap == null
                  ? "—"
                  : `${formatCurrency(withdrawCapUsed)} / ${formatCurrency(num(withdrawCap))}`
              }
              valueClassName={withdrawCap != null ? "text-rose-600 dark:text-rose-400" : undefined}
            />
            <DealTerm
              label="Tip / stream"
              value={formatCurrency(num(deal.max_tip_per_stream_usd))}
            />
            <DealTerm
              label="Sponsor / stream"
              value={formatCurrency(num(deal.max_sponsorship_per_stream_usd))}
            />
          </div>

          <div className="flex flex-wrap items-center gap-1.5 pt-1">
            <Badge
              variant="outline"
              className={cn(
                "text-[10px]",
                deal.allow_code_leaderboards
                  ? "border-emerald-500/30 text-emerald-600 dark:text-emerald-400"
                  : "text-muted-foreground",
              )}
            >
              Code leaderboards {deal.allow_code_leaderboards ? "on" : "off"}
            </Badge>
            <Badge
              variant="outline"
              className={cn(
                "text-[10px]",
                deal.allow_site_leaderboards
                  ? "border-emerald-500/30 text-emerald-600 dark:text-emerald-400"
                  : "text-muted-foreground",
              )}
            >
              Site leaderboards {deal.allow_site_leaderboards ? "on" : "off"}
            </Badge>
            {/* Edit / Terminate live here rather than in the heading: the
                heading stays [Previous deals] [New Deal], mirroring the
                Affiliate Leaderboards card, and four inline buttons up there
                wrapped badly. */}
            <div className="ml-auto flex items-center gap-1.5">
              <DealCardActions userId={userId} deal={activeDeal} />
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

const PNL_STATUS_COLORS: Record<PnlDealResponse["status"], string> = {
  scheduled: "border-blue-500/30 text-blue-600 dark:text-blue-400",
  active: "border-emerald-500/30 text-emerald-600 dark:text-emerald-400",
  settlement_pending: "border-amber-500/30 text-amber-600 dark:text-amber-400",
  settled: "border-zinc-500/30 text-zinc-600 dark:text-zinc-400",
  cancelled: "border-rose-500/30 text-rose-600 dark:text-rose-400",
};

function PnlDealCard({ userId, deal, allDeals }: { userId: string; deal: PnlDealResponse; allDeals: PnlDealResponse[] }) {
  const framePnl = deal.frame_site_pnl_usd == null ? null : num(deal.frame_site_pnl_usd);
  const creatorShare = deal.creator_share_usd == null ? null : num(deal.creator_share_usd);
  const fundingLabel =
    deal.funding_mode === "non_withdrawable_fills"
      ? `${deal.fills_used} / ${deal.fills_allowed ?? 0} fills used`
      : deal.funding_mode === "linked_multiplier"
        ? "Linked multiplier"
        : "New multiplier";
  const frameEnded = new Date(deal.frame_end_utc).getTime() <= Date.now();
  const canSettle =
    frameEnded && (deal.status === "active" || deal.status === "settlement_pending");

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
          {canSettle && (
            <div className="flex items-center justify-between gap-3 border-t pt-3">
              <span className="text-xs text-muted-foreground">
                {deal.status === "settlement_pending"
                  ? "Settlement is pending; recompute and retry safely."
                  : "The exact UTC frame has ended and is ready to settle."}
              </span>
              <PnlSettlementButton
                userId={userId}
                dealId={deal.id}
                expectedVersion={deal.version}
                retry={deal.status === "settlement_pending"}
              />
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
