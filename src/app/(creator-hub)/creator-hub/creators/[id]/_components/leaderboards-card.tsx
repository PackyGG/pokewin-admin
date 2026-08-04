import Link from "next/link";
import { Trophy, ExternalLink, Info } from "lucide-react";

import { BackendApiError } from "@/lib/backend-api/errors";
import { SectionHeading } from "@/components/modern-panels";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/empty-state";
import { formatCurrency, formatDate } from "@/lib/utils/format";
import { cn } from "@/lib/utils";

import {
  getCreatorLeaderboardWagerBreakdownMap,
  type WagerBreakdown,
} from "../../../../../(admin)/creators/[userId]/_queries/leaderboard-wager-by-board";
import { getLeaderboardSponsorshipMap } from "../../../../../(admin)/creators/_queries/leaderboard-sponsorship";
import {
  getLeaderboardsPreviewCached,
  type LeaderboardPreviewRow,
} from "../_queries/leaderboards-preview";
import { CreateLeaderboardDialog } from "./create-leaderboard-dialog";
import { PreviousLeaderboardsDialog } from "./previous-leaderboards-dialog";
import { HubNotice } from "../../../_components/hub-notice";
import {
  LEADERBOARD_APPROVAL_COLORS,
  LEADERBOARD_TIME_COLORS,
} from "./status-badges";

/**
 * Affiliate Leaderboards card (right half of the Overview "Deal | Affiliate
 * Leaderboards" row).
 *
 * Read-only summary of this creator's LIVE boards (upcoming + active) from
 * the existing backend list endpoint, read through
 * `getLeaderboardsPreviewCached` (120s TTL, tag-flushed on leaderboard
 * mutations) so Overview re-renders / `?activityPeriod=` switches stop
 * re-firing the backend call. Ended boards are deliberately NOT in the card —
 * they are reachable only through the "Previous leaderboards" modal, which
 * reads from the same windowed fetch. "Create Leaderboard" opens the
 * hub-native create dialog (reuses admin server actions).
 *
 * House-POV: leaderboard prize cost is house spend → rose. Best-effort: a
 * backend outage degrades to a note, and a failed wager chip read renders a
 * visible muted "chips unavailable" note instead of silently omitting the
 * chips. Streamed in its own Suspense boundary from the Overview tab.
 */

export async function LeaderboardsCard({ userId }: { userId: string }) {
  // Stay inside the Hub: its own Leaderboards route is the manager-facing
  // read surface. (The admin route `/creators/leaderboards` is the
  // write/approval side and is reachable from the detail page.)
  const manageHref = `/creator-hub/leaderboards`;

  // List preview + realized house cost + previous (ended) boards, fetched
  // together. All best-effort: a list failure degrades to a note; a cost
  // failure renders a visible muted "chips unavailable" note (never a silent
  // omission); a previous-boards failure simply hides the modal trigger. The
  // list read is wrapped OUTSIDE the cache so a transport / non-2xx failure
  // returns a marker instead of throwing the card down (a throw is never
  // cached).
  const listResult = await getLeaderboardsPreviewCached(userId)
    .then((r) => ({ ok: true as const, preview: r }))
    .catch((err: unknown) => {
      const msg = err instanceof BackendApiError ? err.message : null;
      if (!(err instanceof BackendApiError)) {
        console.error(
          "[creator-hub.creators.leaderboards] backend fetch failed:",
          err,
        );
      }
      return { ok: false as const, message: msg };
    });
  // Ended boards never appear in the card body — they live behind the
  // "Previous leaderboards" modal only (owner call), so the box shows just
  // what is still running or upcoming.
  const previousRows = listResult.ok ? listResult.preview.previous : [];

  if (!listResult.ok) {
    return (
      <div className="flex h-full flex-col gap-3">
        <SectionHeading
          icon={Trophy}
          title="Affiliate Leaderboards"
          action={<CreateLeaderboardDialog userId={userId} />}
        />
        <Card size="sm" className="flex-1">
          <CardContent className="flex flex-1 items-center justify-center py-6">
            <p className="text-sm text-muted-foreground">
              {listResult.message
                ? `Could not load leaderboards: ${listResult.message}`
                : "Could not load leaderboards — the backend was unreachable. Refresh to retry."}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const rows: LeaderboardPreviewRow[] = listResult.preview.rows;
  const liveTotal = listResult.preview.liveTotal;

  let wagerFailed = false;
  // Per-board wager driven + the admin sponsored % (the house-funded share
  // of each prize pool). The sponsorship map defaults a board to 100% when
  // un-annotated — same convention as the cost aggregates above.
  //
  // ENDED boards are in the same batch as the live ones: the "Previous
  // leaderboards" modal shows the identical wagered / house-cost figures as
  // the card body, and the wager read is ONE aggregate scan over the whole
  // board set (not per board), so widening it costs a few extra tuples.
  const costBoards = [...rows, ...previousRows];
  const [wagerMap, sponsorshipMap] = await Promise.all([
    getCreatorLeaderboardWagerBreakdownMap(
      costBoards.map((r) => ({
        id: r.id,
        creatorUserId: r.creator_user_id,
        coCreatorUserIds: r.co_creator_user_ids ?? [],
        affiliateCodes: r.affiliate_codes ?? [],
        startDate: new Date(r.start_date),
        endDate: new Date(r.end_date),
      })),
    ).catch((e) => {
      console.error("[creator-hub.creators.leaderboards] wager map failed:", e);
      wagerFailed = true;
      return new Map<string, WagerBreakdown>();
    }),
    getLeaderboardSponsorshipMap(costBoards.map((r) => r.id)).catch((e) => {
      console.error(
        "[creator-hub.creators.leaderboards] sponsorship map failed:",
        e,
      );
      return new Map<string, number>();
    }),
  ]);

  // Visible (muted) note when a chip source failed — a missing wager chip
  // must be distinguishable from a genuine no-wager board.
  const chipGaps = wagerFailed ? ["wagered chips"] : [];

  /** Admin sponsored % (default 100% when un-annotated), clamped. */
  const sponsoredPctOf = (id: string) =>
    Math.min(100, Math.max(0, sponsorshipMap.get(id) ?? 100));

  // Ended boards, carrying the SAME money figures the card body shows, so
  // the modal isn't a strictly poorer view of the same board.
  const previousItems = previousRows.map((r) => {
    const wagered = wagerMap.get(r.id);
    const sponsoredPct = sponsoredPctOf(r.id);
    return {
      id: r.id,
      title: r.title,
      total_prize_usd: r.total_prize_usd,
      is_sponsored: r.is_sponsored,
      start_date: r.start_date,
      end_date: r.end_date,
      approval_status: r.approval_status,
      time_status: r.time_status,
      sponsoredPct,
      houseCostUsd: (Number(r.total_prize_usd) || 0) * (sponsoredPct / 100),
      wageredRawUsd: wagered?.raw ?? 0,
      wageredWeightedUsd: wagered?.weighted ?? 0,
    };
  });

  return (
    <div className="flex h-full flex-col gap-3">
      <SectionHeading
        icon={Trophy}
        title="Affiliate Leaderboards"
        action={
          <div className="flex flex-wrap items-center gap-2">
            {previousItems.length > 0 && (
              <PreviousLeaderboardsDialog rows={previousItems} />
            )}
            <CreateLeaderboardDialog userId={userId} />
          </div>
        }
      />
      <Card size="sm" className="flex-1">
        <CardContent className="space-y-3">
          {chipGaps.length > 0 && (
            <HubNotice tone="amber" icon={Info} dashed>
              {chipGaps.join(" and ")} couldn&apos;t load this time — the
              board list still renders. Refresh to retry.
            </HubNotice>
          )}

          {rows.length === 0 ? (
            <EmptyState
              icon={Trophy}
              title={
                previousRows.length > 0
                  ? "No live leaderboards"
                  : "No leaderboards yet"
              }
              description={
                previousRows.length > 0
                  ? "Nothing running or upcoming. Ended boards are in Previous leaderboards; use Create Leaderboard to start a new one."
                  : "This creator hasn't set up any leaderboards. Use Create Leaderboard to add one."
              }
              compact
            />
          ) : (
            <div className="space-y-2">
              {rows.map((r) => {
                const wagered = wagerMap.get(r.id);
                const hasWager = wagered != null && wagered.raw > 0;
                // House-funded share: admin sponsored % (default 100% when
                // un-annotated) × the prize pool. This is what we actually
                // pay off the board → rose (house spend).
                const sponsoredPct = sponsoredPctOf(r.id);
                const prizeUsd = Number(r.total_prize_usd) || 0;
                const houseCostUsd = prizeUsd * (sponsoredPct / 100);
                return (
                <Link
                  key={r.id}
                  href={`/creator-hub/leaderboards/${r.id}`}
                  className="flex flex-col gap-2 rounded-md border p-3 transition-colors hover:bg-muted/50 sm:flex-row sm:items-center sm:justify-between sm:gap-3"
                >
                  <div className="min-w-0 sm:flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="truncate text-sm font-medium">
                        {r.title}
                      </span>
                      {hasWager && (
                        <span className="shrink-0 text-xs tabular-nums text-emerald-600 dark:text-emerald-400">
                          · {formatCurrency(wagered.raw)} wagered ·{" "}
                          {formatCurrency(wagered.weighted)} weighted
                        </span>
                      )}
                      {r.is_sponsored && (
                        <Badge variant="outline" className="text-[10px]">
                          sponsored
                        </Badge>
                      )}
                    </div>
                    <div className="mt-1 truncate text-xs text-muted-foreground">
                      {formatDate(r.start_date)} → {formatDate(r.end_date)}
                    </div>
                    <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                      House pays {sponsoredPct}% ·{" "}
                      <span className="font-medium tabular-nums text-rose-600 dark:text-rose-400">
                        {formatCurrency(houseCostUsd)}
                      </span>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 sm:shrink-0">
                    <span className="text-sm font-semibold tabular-nums">
                      ${r.total_prize_usd}
                    </span>
                    <Badge
                      variant="outline"
                      className={cn(
                        "text-[10px]",
                        LEADERBOARD_APPROVAL_COLORS[r.approval_status],
                      )}
                    >
                      {r.approval_status}
                    </Badge>
                    <Badge
                      variant="outline"
                      className={cn(
                        "text-[10px]",
                        LEADERBOARD_TIME_COLORS[r.time_status],
                      )}
                    >
                      {r.time_status}
                    </Badge>
                  </div>
                </Link>
                );
              })}
            </div>
          )}

          <Link
            href={manageHref}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            {liveTotal > rows.length
              ? `View all ${liveTotal} live leaderboards`
              : "Manage leaderboards"}
            <ExternalLink className="size-3.5" />
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
