import Link from "next/link";
import { ExternalLink, HandCoins } from "lucide-react";

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
import { NewDealDialog } from "./new-deal-dialog";

/**
 * Deal card (left half of the Overview "Deal | Affiliate Leaderboards" row).
 *
 * Shows this creator's CURRENT weekly-fill deal terms read from the existing
 * backend deal read (`getCreatorDealData`) — fills, per-fill amount, withdraw
 * cap (used / total), conversion rate, tip + sponsor caps, leaderboard
 * allowances. Picks the active deal if one exists, else the most recent.
 *
 * "New Deal" opens the hub-native create dialog (reuses admin server
 * actions). Nothing fabricated: a creator with no deal
 * shows a clean empty state; a backend outage shows a degraded note.
 *
 * Streamed in its own Suspense boundary from the Overview tab.
 */

const STATUS_COLORS: Record<string, string> = {
  active:
    "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  scheduled:
    "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  completed:
    "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30",
  terminated:
    "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30",
};

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

export async function DealCard({ userId }: { userId: string }) {
  const manageDealsHref = `/creator-hub/creators/${userId}`;
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
      <div className="space-y-3">
        {heading}
        <Card size="sm">
          <CardContent className="py-6">
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
  // Prefer the active deal; otherwise the most recently created.
  const deal =
    deals.find((d) => d.status === "active") ??
    [...deals].sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ??
    null;

  if (!deal) {
    return (
      <div className="space-y-3">
        {heading}
        <Card size="sm">
          <CardContent className="py-2">
            <EmptyState
              icon={HandCoins}
              title="No deal yet"
              description="This creator has no fill deal. Use New Deal to set one up."
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
    <div className="space-y-3">
      {heading}
      <Card size="sm">
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Badge
                variant="outline"
                className={cn(
                  "text-[10px] capitalize",
                  STATUS_COLORS[deal.status],
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
            {deals.length > 1 && (
              <span className="text-[11px] text-muted-foreground">
                +{deals.length - 1} more deal{deals.length - 1 === 1 ? "" : "s"}
              </span>
            )}
          </div>

          <Link
            href={manageDealsHref}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            Manage deals
            <ExternalLink className="size-3.5" />
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
