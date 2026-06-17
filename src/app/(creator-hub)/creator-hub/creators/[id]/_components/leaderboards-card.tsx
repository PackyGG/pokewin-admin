import Link from "next/link";
import { Trophy, ExternalLink, Info } from "lucide-react";

import { BackendApiError } from "@/lib/backend-api/errors";
import { SectionHeading } from "@/components/modern-panels";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/empty-state";
import { formatCurrency, formatDate } from "@/lib/utils/format";
import { cn } from "@/lib/utils";

import { getCreatorLeaderboardCost } from "../../../../../(admin)/creators/[userId]/_queries/leaderboard-cost-by-creator";
import { getCreatorLeaderboardWagerMap } from "../../../../../(admin)/creators/[userId]/_queries/leaderboard-wager-by-board";
import { getLeaderboardSponsorshipMap } from "../../../../../(admin)/creators/_queries/leaderboard-sponsorship";
import {
  getLeaderboardsPreviewCached,
  type LeaderboardApprovalStatus,
  type LeaderboardPreviewRow,
  type LeaderboardTimeStatus,
} from "../_queries/leaderboards-preview";
import { getPreviousLeaderboardsCached } from "../_queries/previous-leaderboards";
import { CreateLeaderboardDialog } from "./create-leaderboard-dialog";
import { PreviousLeaderboardsDialog } from "./previous-leaderboards-dialog";

/**
 * Affiliate Leaderboards card (right half of the Overview "Deal | Affiliate
 * Leaderboards" row).
 *
 * Read-only summary of this creator's leaderboards: the realized house cost
 * (sponsored-% weighted, from the existing `getCreatorLeaderboardCost`) + a
 * preview of recent boards from the existing backend list endpoint — now
 * read through `getLeaderboardsPreviewCached` (120s TTL, tag-flushed on
 * leaderboard mutations) so Overview re-renders / `?activityPeriod=`
 * switches stop re-firing the backend call. "Create Leaderboard" opens the
 * hub-native create dialog (reuses admin server actions).
 *
 * House-POV: leaderboard prize cost is house spend → rose. Best-effort: a
 * backend outage degrades to a note, and a failed cost/wager chip read now
 * renders a visible muted "chips unavailable" note instead of silently
 * omitting the chips. Streamed in its own Suspense boundary from the
 * Overview tab.
 */

const APPROVAL_COLORS: Record<LeaderboardApprovalStatus, string> = {
  pending:
    "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30",
  approved:
    "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30",
  rejected: "bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30",
};

const TIME_COLORS: Record<LeaderboardTimeStatus, string> = {
  upcoming: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  active:
    "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  ended: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30",
};

export async function LeaderboardsCard({ userId }: { userId: string }) {
  // Link targets to the EXISTING flows (this wave reuses them as-is).
  const manageHref = `/creator-hub/leaderboards`;

  // List preview + realized house cost + previous (ended) boards, fetched
  // together. All best-effort: a list failure degrades to a note; a cost
  // failure renders a visible muted "chips unavailable" note (never a silent
  // omission); a previous-boards failure simply hides the modal trigger. The
  // list read is wrapped OUTSIDE the cache so a transport / non-2xx failure
  // returns a marker instead of throwing the card down (a throw is never
  // cached).
  const [listResult, costResult, previousResult] = await Promise.all([
    getLeaderboardsPreviewCached(userId)
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
      }),
    getCreatorLeaderboardCost(userId)
      .then((cost) => ({ ok: true as const, cost }))
      .catch((e: unknown) => {
        console.error(
          "[creator-hub.creators.leaderboards] cost fetch failed:",
          e,
        );
        return { ok: false as const };
      }),
    getPreviousLeaderboardsCached(userId).catch((e: unknown) => {
      console.error(
        "[creator-hub.creators.leaderboards] previous boards fetch failed:",
        e,
      );
      return [];
    }),
  ]);
  const cost = costResult.ok ? costResult.cost : null;
  const previousRows = previousResult;

  const heading = (
    <SectionHeading
      icon={Trophy}
      title="Affiliate Leaderboards"
      action={
        <div className="flex flex-wrap items-center gap-2">
          {previousRows.length > 0 && (
            <PreviousLeaderboardsDialog rows={previousRows} />
          )}
          <CreateLeaderboardDialog userId={userId} />
        </div>
      }
    />
  );

  if (!listResult.ok) {
    return (
      <div className="space-y-3">
        {heading}
        <Card size="sm">
          <CardContent className="py-6">
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
  const total = listResult.preview.total;

  let wagerFailed = false;
  // Per-board wager driven + the admin sponsored % (the house-funded share
  // of each prize pool). The sponsorship map defaults a board to 100% when
  // un-annotated — same convention as the cost aggregates above.
  const [wagerMap, sponsorshipMap] = await Promise.all([
    getCreatorLeaderboardWagerMap(
      rows.map((r) => ({
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
      return new Map<string, number>();
    }),
    getLeaderboardSponsorshipMap(rows.map((r) => r.id)).catch((e) => {
      console.error(
        "[creator-hub.creators.leaderboards] sponsorship map failed:",
        e,
      );
      return new Map<string, number>();
    }),
  ]);

  // Visible (muted) note when a chip source failed — a missing cost/wager
  // chip must be distinguishable from a genuine $0 / no-wager board.
  const chipGaps = [
    ...(!costResult.ok ? ["house-cost chip"] : []),
    ...(wagerFailed ? ["wagered chips"] : []),
  ];

  return (
    <div className="space-y-3">
      {heading}
      <Card size="sm">
        <CardContent className="space-y-3">
          {chipGaps.length > 0 && (
            <div className="flex items-start gap-2 rounded-md border border-dashed border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-muted-foreground">
              <Info className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
              <span>
                {chipGaps.join(" and ")} couldn&apos;t load this time — the
                board list still renders. Refresh to retry.
              </span>
            </div>
          )}

          {/* Realized house cost (sponsored-% weighted) → rose. */}
          {cost && cost.leaderboardCount > 0 && (
            <div className="flex items-center justify-between gap-3 rounded-lg border bg-background/40 px-3 py-2">
              <span className="text-xs text-muted-foreground">
                House cost · {cost.leaderboardCount} approved
              </span>
              <span className="text-sm font-semibold tabular-nums text-rose-600 dark:text-rose-400">
                {formatCurrency(cost.costUsd)}
              </span>
            </div>
          )}

          {rows.length === 0 ? (
            <EmptyState
              icon={Trophy}
              title="No leaderboards yet"
              description="This creator hasn't set up any leaderboards. Use Create Leaderboard to add one."
              compact
            />
          ) : (
            <div className="space-y-2">
              {rows.map((r) => {
                const wagered = wagerMap.get(r.id);
                // House-funded share: admin sponsored % (default 100% when
                // un-annotated) × the prize pool. This is what we actually
                // pay off the board → rose (house spend).
                const sponsoredPct = Math.min(
                  100,
                  Math.max(0, sponsorshipMap.get(r.id) ?? 100),
                );
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
                      {wagered != null && wagered > 0 && (
                        <span className="shrink-0 text-xs tabular-nums text-emerald-600 dark:text-emerald-400">
                          · {formatCurrency(wagered)} wagered
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
                        APPROVAL_COLORS[r.approval_status],
                      )}
                    >
                      {r.approval_status}
                    </Badge>
                    <Badge
                      variant="outline"
                      className={cn("text-[10px]", TIME_COLORS[r.time_status])}
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
            {total > rows.length
              ? `View all ${total} leaderboards`
              : "Manage leaderboards"}
            <ExternalLink className="size-3.5" />
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
