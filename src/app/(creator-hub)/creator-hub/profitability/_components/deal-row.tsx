"use client";

import Link from "next/link";

import { cn } from "@/lib/utils";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { formatCurrency } from "@/lib/utils/format";

import { HubKpiInfoPopover } from "../../_components/hub-kpi-info-popover";
import type { CreatorProfitabilityRow } from "../_queries/deal-profitability";
import type { PastDealRow } from "../_queries/past-deals";
import {
  MS_PER_DAY,
  Metric,
  conversionClass,
  costBreakdown,
  dealLengthLabel,
  housePnlClass,
} from "./deal-formatters";

/**
 * DealRow — the ONE row for both Profitability lists (active + past).
 *
 * Identical anatomy either way: avatar + creator link + status chip on the
 * left, the frame meta line (board title linked to its leaderboard detail ·
 * dates · length), the cost-breakdown line (cap + leaderboard + tips — no
 * daily-fill leg), and the right cluster of metrics. The ONLY intentional
 * variant difference is the middle cell of the boxed cluster: the active
 * variant shows Time Left, the past variant shows Affiliates Made Us.
 *
 * House-POV colours: deal cost = rose (house cost); actual wager = emerald
 * (house throughput); PnL / affiliates-made-us flip emerald/rose on sign.
 *
 * CLIENT COMPONENT — both variants read `Date.now()` at render time (day
 * X/N, time left, ended-ago), and the Actual PnL explainer is a popover.
 * Props are plain serializable JSON.
 */

const DATE_FMT_SHORT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
});
const DATE_FMT_YEAR = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

export type DealRowProps =
  | { variant: "active"; row: CreatorProfitabilityRow }
  | { variant: "past"; row: PastDealRow };

/** Active frame label: dates + "day X/N" (live), "upcoming", or "ended". */
function activeFrameLabel(row: CreatorProfitabilityRow): string {
  const { frameStartMs, frameEndMs, isLive } = row;
  if (frameStartMs == null || frameEndMs == null) return "No active frame";

  const range = `${DATE_FMT_SHORT.format(frameStartMs)} – ${DATE_FMT_SHORT.format(frameEndMs)}`;
  const totalDays = Math.max(
    1,
    Math.round((frameEndMs - frameStartMs) / MS_PER_DAY),
  );
  const now = Date.now();

  if (isLive) {
    const dayN = Math.min(
      totalDays,
      Math.max(1, Math.floor((now - frameStartMs) / MS_PER_DAY) + 1),
    );
    return `${range} · day ${dayN}/${totalDays}`;
  }
  if (frameStartMs > now) return `${range} · upcoming`;
  return `${range} · ended`;
}

/**
 * Past frame label: full dates + length. Surfaces the frame's day count
 * (`dealDays`) alongside the week label for multi-week frames.
 */
function pastFrameLabel(row: PastDealRow): string {
  const range = `${DATE_FMT_YEAR.format(row.frameStartMs)} – ${DATE_FMT_YEAR.format(
    row.frameEndMs,
  )}`;
  const length =
    row.dealWeeks > 1
      ? `${row.dealWeeks} weeks (${row.dealDays} days)`
      : `${row.dealDays} day${row.dealDays === 1 ? "" : "s"}`;
  return `${range} · ${length}`;
}

/** Time remaining in the frame: "X days" (live), "Upcoming", or "Ended". */
function timeLeftLabel(row: CreatorProfitabilityRow): string {
  const { frameStartMs, frameEndMs } = row;
  if (frameStartMs == null || frameEndMs == null) return "—";
  const now = Date.now();
  if (frameStartMs > now) return "Upcoming";
  if (frameEndMs < now) return "Ended";
  const daysLeft = Math.max(0, Math.ceil((frameEndMs - now) / MS_PER_DAY));
  return `${daysLeft} day${daysLeft === 1 ? "" : "s"}`;
}

function endedAgoLabel(row: PastDealRow): string {
  const days = Math.floor((Date.now() - row.frameEndMs) / MS_PER_DAY);
  if (days <= 0) return "today";
  if (days === 1) return "1 day ago";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months === 1) return "1 month ago";
  if (months < 12) return `${months} months ago`;
  const years = Math.floor(months / 12);
  return years === 1 ? "1 year ago" : `${years} years ago`;
}

export function DealRow(props: DealRowProps) {
  const { variant, row } = props;
  const initial = (row.username ?? (variant === "past" ? row.boardTitle : row.code) ?? "?")
    .slice(0, 1)
    .toUpperCase();

  const boardId = row.boardId;
  const boardTitle = row.boardTitle;

  const metaLabel =
    variant === "active"
      ? activeFrameLabel(props.row)
      : `${pastFrameLabel(props.row)} · ended ${endedAgoLabel(props.row)}`;

  return (
    <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-center gap-3">
        <Avatar className="size-10 shrink-0">
          <AvatarImage src={row.image ?? undefined} alt={row.username ?? ""} />
          <AvatarFallback>{initial}</AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <Link
              href={`/creator-hub/creators/${row.userId}`}
              className="truncate text-sm font-semibold hover:underline"
            >
              {row.username ?? "Unknown creator"}
            </Link>
            {variant === "active" && props.row.code && (
              <span className="shrink-0 rounded-md border border-border bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                {props.row.code}
              </span>
            )}
            {variant === "active" && props.row.isLive && (
              <span className="shrink-0 rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-400">
                Live
              </span>
            )}
            {variant === "past" && (
              <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
                Ended
              </span>
            )}
          </div>
          <div className="truncate text-[11px] text-muted-foreground">
            {/* Board title links to its leaderboard detail page. Sibling
                link to the creator link above — never nested anchors. */}
            {boardTitle &&
              (boardId ? (
                <>
                  <Link
                    href={`/creator-hub/leaderboards/${boardId}`}
                    className="hover:underline"
                  >
                    {boardTitle}
                  </Link>
                  {" · "}
                </>
              ) : (
                `${boardTitle} · `
              ))}
            {metaLabel}
          </div>
          <div className="truncate text-[10px] text-muted-foreground/70">
            {costBreakdown(row)}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-x-6 gap-y-2 sm:flex sm:items-center sm:gap-6">
        <div className="col-span-2 flex items-center gap-3 rounded-lg border bg-background/40 px-3 py-1.5 sm:col-span-1">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Length
            </div>
            <div className="text-sm font-semibold tabular-nums">
              {dealLengthLabel(row)}
            </div>
          </div>
          <div className="h-7 w-px bg-border" />
          {/* The ONE intentional variant difference in the row. */}
          {variant === "active" ? (
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Time Left
              </div>
              <div className="text-sm font-semibold tabular-nums">
                {timeLeftLabel(props.row)}
              </div>
            </div>
          ) : (
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Affiliates Made Us
              </div>
              <div
                className={cn(
                  "text-sm font-semibold tabular-nums",
                  housePnlClass(row.affiliatesMadeUs),
                )}
              >
                {row.affiliatesMadeUs >= 0 ? "+" : ""}
                {formatCurrency(row.affiliatesMadeUs)}
              </div>
            </div>
          )}
          <div className="h-7 w-px bg-border" />
          <div>
            <div className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Actual PnL
              <HubKpiInfoPopover
                title="Actual PnL"
                description={`Affiliates made us − deal cost, ${
                  variant === "active" ? "this deal frame" : "this frame's window"
                }. Affiliates made us = coverage-attributed cohort deposits − card withdrawals − the creator's own affiliate_claim earnings. Positive = the affiliates earned back more than the deal cost.`}
                lines={[
                  {
                    label: "Affiliates made us",
                    value: formatCurrency(row.affiliatesMadeUs),
                    tone: row.affiliatesMadeUs < 0 ? "rose" : "emerald",
                  },
                  {
                    label: "Deal cost",
                    value: `− ${formatCurrency(row.dealCost)}`,
                    tone: "rose",
                  },
                ]}
                footer={{
                  label: "Actual PnL",
                  value: formatCurrency(row.actualPnl),
                  tone: row.actualPnl < 0 ? "rose" : "emerald",
                }}
                ariaLabel="Show Actual PnL breakdown"
              />
            </div>
            <div
              className={cn(
                "text-sm font-semibold tabular-nums",
                housePnlClass(row.actualPnl),
              )}
            >
              {row.actualPnl >= 0 ? "+" : ""}
              {formatCurrency(row.actualPnl)}
            </div>
          </div>
        </div>
        <Metric
          label="Deal Cost"
          value={formatCurrency(row.dealCost)}
          className="text-rose-600 dark:text-rose-400"
        />
        <Metric label="Expected Wager" value={formatCurrency(row.expectedWager)} />
        <Metric
          label="Actual Wager"
          value={formatCurrency(row.actualWager)}
          className="text-emerald-600 dark:text-emerald-400"
        />
        <Metric
          label="Conversion"
          value={`${row.conversionRate.toFixed(2)}x`}
          className={conversionClass(row.conversionRate)}
        />
      </div>
    </div>
  );
}
