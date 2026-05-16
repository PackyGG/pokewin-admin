"use client";

import { useMemo, useState } from "react";
import {
  ChevronRight,
  CircleDot,
  Clock,
  Flag,
  Pencil,
  PowerOff,
  Trash2,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatDate, formatRelative } from "@/lib/utils/format";
import type { MultiplierDealResponse } from "@/lib/backend-api";

import {
  MULTIPLIER_STATUS_BADGE,
  MULTIPLIER_STATUS_LABEL,
  formatMultiplier,
  formatStringUsd,
} from "../../_components/multiplier-review/shared";
import { MultiplierDealDetailDrawer } from "../../_components/multiplier-review/deal-detail-drawer";
import { MultiplierDealFormDialog } from "../../_components/multiplier-review/deal-form-dialog";
import { MultiplierCancelDialog } from "../../_components/multiplier-review/cancel-dialog";
import { MultiplierForceEndDialog } from "../../_components/multiplier-review/force-end-dialog";

type Props = {
  userId: string;
  deals: MultiplierDealResponse[];
};

/**
 * Multiplier deals list for the creator detail page. Renders four
 * sections by lifecycle:
 *
 *   - Offer       (pending_deposit / funded) — admin's offer, creator
 *     hasn't activated. Actions: edit / cancel.
 *   - Active      (live)                       — stream running.
 *     Actions: force-end + detail.
 *   - In Review   (pending_review / flagged)   — legacy / stuck deals
 *     from before auto-settlement. Read-only here; new deals never land
 *     in this state. Clean-up via API only.
 *   - History     (terminal statuses)          — read-only.
 *
 * Sections are only shown when they have rows; an empty list shows the
 * "create offer" empty state instead. Row click opens the detail drawer
 * which exposes the same actions inline so the admin can do everything
 * either from a quick row button or the fuller drawer view.
 */
export function MultiplierDealsList({ userId, deals }: Props) {
  const [drawerDeal, setDrawerDeal] = useState<MultiplierDealResponse | null>(
    null,
  );

  const sections = useMemo(() => {
    const offer = deals.filter(
      (d) => d.status === "pending_deposit" || d.status === "funded",
    );
    const active = deals.filter((d) => d.status === "live");
    const review = deals.filter(
      (d) => d.status === "pending_review" || d.status === "flagged",
    );
    const history = deals.filter(
      (d) =>
        d.status === "approved" ||
        d.status === "rejected" ||
        d.status === "cancelled" ||
        d.status === "completed",
    );
    return { offer, active, review, history };
  }, [deals]);

  if (deals.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 px-6 py-10 text-center">
        <div className="flex size-10 items-center justify-center rounded-full bg-muted">
          <CircleDot className="size-5 text-muted-foreground" />
        </div>
        <div>
          <div className="text-sm font-medium">No multiplier deals yet</div>
          <div className="mt-1 text-xs text-muted-foreground">
            Create a multiplier offer so the creator can deposit and inflate
            their balance for a stream.
          </div>
        </div>
        <MultiplierDealFormDialog userId={userId} />
      </div>
    );
  }

  return (
    <div className="divide-y divide-border/60">
      {sections.offer.length > 0 && (
        <Section title="Offer" count={sections.offer.length}>
          {sections.offer.map((deal) => (
            <DealRow
              key={deal.id}
              deal={deal}
              onOpen={() => setDrawerDeal(deal)}
            />
          ))}
        </Section>
      )}

      {sections.active.length > 0 && (
        <Section
          title="Active"
          count={sections.active.length}
          accent="emerald"
        >
          {sections.active.map((deal) => (
            <DealRow
              key={deal.id}
              deal={deal}
              onOpen={() => setDrawerDeal(deal)}
            />
          ))}
        </Section>
      )}

      {sections.review.length > 0 && (
        <Section
          title="In Review"
          count={sections.review.length}
          accent="amber"
        >
          {sections.review.map((deal) => (
            <DealRow
              key={deal.id}
              deal={deal}
              onOpen={() => setDrawerDeal(deal)}
            />
          ))}
        </Section>
      )}

      {sections.history.length > 0 && (
        <Section title="History" count={sections.history.length}>
          {sections.history.map((deal) => (
            <DealRow
              key={deal.id}
              deal={deal}
              onOpen={() => setDrawerDeal(deal)}
            />
          ))}
        </Section>
      )}

      <MultiplierDealDetailDrawer
        deal={drawerDeal}
        open={drawerDeal !== null}
        onOpenChange={(o) => {
          if (!o) setDrawerDeal(null);
        }}
      />
    </div>
  );
}

function Section({
  title,
  count,
  accent,
  children,
}: {
  title: string;
  count: number;
  accent?: "emerald" | "amber";
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center gap-2 bg-muted/30 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <span
          className={cn(
            "inline-block size-1.5 rounded-full",
            accent === "emerald" && "bg-emerald-500",
            accent === "amber" && "bg-amber-500",
            !accent && "bg-muted-foreground/40",
          )}
        />
        {title}
        <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
          {count}
        </Badge>
      </div>
      <div className="divide-y divide-border/40">{children}</div>
    </div>
  );
}

function DealRow({
  deal,
  onOpen,
}: {
  deal: MultiplierDealResponse;
  onOpen: () => void;
}) {
  const isOffer =
    deal.status === "pending_deposit" || deal.status === "funded";
  const isLive = deal.status === "live";
  const isReviewable =
    deal.status === "pending_review" || deal.status === "flagged";
  const isHistory =
    deal.status === "approved" ||
    deal.status === "rejected" ||
    deal.status === "cancelled" ||
    deal.status === "completed";

  return (
    <div className="flex items-start gap-3 px-4 py-3 hover:bg-muted/30">
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-start gap-3 text-left"
      >
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant="outline"
              className={MULTIPLIER_STATUS_BADGE[deal.status]}
            >
              {MULTIPLIER_STATUS_LABEL[deal.status]}
            </Badge>
            <span className="text-sm font-medium">
              {formatStringUsd(deal.required_deposit_usd)}
            </span>
            <span className="text-xs text-muted-foreground">×</span>
            <span className="text-sm font-medium">
              {formatMultiplier(deal.multiplier_bps)}
            </span>
            <span className="text-xs text-muted-foreground">→</span>
            <span className="text-sm font-medium">
              {deal.total_loaded_usd
                ? formatStringUsd(deal.total_loaded_usd)
                : `${formatStringUsd(
                    String(
                      Number(deal.required_deposit_usd) *
                        (deal.multiplier_bps / 10000),
                    ),
                  )} (preview)`}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {deal.activated_at && (
              <span className="inline-flex items-center gap-1">
                <Clock className="size-3" />
                Started {formatRelative(deal.activated_at)}
              </span>
            )}
            {!deal.activated_at && (
              <span>Created {formatDate(deal.created_at)}</span>
            )}
            {isLive && deal.fill_remaining_usd && (
              <span>
                {formatStringUsd(deal.fill_remaining_usd)} remaining
              </span>
            )}
            {(isReviewable || isHistory) && deal.ending_balance_usd && (
              <span>
                Ended {formatStringUsd(deal.ending_balance_usd)}
              </span>
            )}
            {isReviewable &&
              deal.flagged_reasons &&
              deal.flagged_reasons.length > 0 && (
                <span className="inline-flex items-center gap-1 text-orange-500">
                  <Flag className="size-3" />
                  {deal.flagged_reasons.length} flag
                  {deal.flagged_reasons.length === 1 ? "" : "s"}
                </span>
              )}
            {isHistory && deal.review_decision && (
              <span>{deal.review_decision}</span>
            )}
          </div>
        </div>
        <ChevronRight className="mt-1 size-4 shrink-0 text-muted-foreground" />
      </button>

      {/* Inline actions — quick path for the common operations.
          More options + full context available in the drawer. */}
      <div className="flex shrink-0 items-center gap-1">
        {isOffer && (
          <>
            {deal.status === "pending_deposit" && (
              <MultiplierDealFormDialog
                userId={deal.user_id}
                mode="edit"
                deal={deal}
                trigger={
                  <>
                    <Pencil className="size-3.5" />
                  </>
                }
              />
            )}
            <MultiplierCancelDialog
              deal={deal}
              trigger={
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 text-rose-500 hover:text-rose-600"
                  aria-label="Cancel offer"
                >
                  <Trash2 className="size-3.5" />
                </Button>
              }
            />
          </>
        )}
        {isLive && (
          <MultiplierForceEndDialog
            deal={deal}
            trigger={
              <Button
                variant="ghost"
                size="icon"
                className="size-7 text-rose-500 hover:text-rose-600"
                aria-label="Force-end stream"
              >
                <PowerOff className="size-3.5" />
              </Button>
            }
          />
        )}
        {/* In Review rows are read-only: auto-settlement issues the
            voucher inline at end-stream, so no approve/reject/flag
            buttons here. Legacy stuck deals (rare) are cleared via the
            backend admin API directly. */}
      </div>
    </div>
  );
}
