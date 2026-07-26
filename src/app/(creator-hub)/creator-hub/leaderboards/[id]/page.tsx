import { Suspense } from "react";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ExternalLink } from "lucide-react";

import { requireCreatorHubPageAccess } from "@/lib/require-creator-hub-access";
import { isUuid } from "@/lib/utils/ids";
import { eq } from "drizzle-orm";
import { getDrizzleDb } from "@/lib/db";
import { user } from "@/lib/db-schema/main/schema";
import {
  affiliateLeaderboardsApi,
  type ApprovalStatus,
  type TimeStatus,
} from "@/lib/backend-api/affiliate-leaderboards";
import { BackendApiError } from "@/lib/backend-api/errors";
import { PageHero } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { safeQueryOrNull } from "@/lib/errors/safe-query";
import { formatCurrency, formatDate } from "@/lib/utils/format";
import {
  getAffiliateLeaderboardRankings,
  getAffiliateLeaderboardClaims,
} from "@/lib/queries/creators";
import { getRewardExpiry } from "@/lib/backend-api/reward-expiry";
import { computeLeaderboardClaimWindow } from "@/lib/reward-expiry/leaderboard-claim-window";
import { getCreatorLeaderboardWagerMap } from "../../../../(admin)/creators/[userId]/_queries/leaderboard-wager-by-board";

import { LeaderboardStandingsPanel } from "../../../../(admin)/creators/leaderboards/_components/leaderboard-standings-panel";
import { LeaderboardClaimsPanel } from "../../../../(admin)/creators/leaderboards/_components/leaderboard-claims-panel";

export const metadata = { title: "Leaderboard · Creator Hub" };

/**
 * Creator Hub — leaderboard detail.
 *
 * SHELL-FIRST: only the board record itself (one bounded backend read) is on
 * the critical path, because the hero copy IS that record (title / status
 * badges / owner link). Everything heavier — standings, claims, claim holds,
 * the wager map, the reward-expiry window — streams behind its own Suspense
 * boundary so the hero + summary paint immediately instead of waiting on a
 * six-way fan-out.
 *
 * Every leg is individually guarded: a failing standings/claims/wager read
 * degrades that panel to an empty state rather than throwing the page into
 * the route error boundary.
 */

const APPROVAL_COLORS: Record<ApprovalStatus, string> = {
  pending:
    "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30",
  approved:
    "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  rejected: "bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30",
};

const TIME_COLORS: Record<TimeStatus, string> = {
  upcoming: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  active:
    "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  ended: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30",
};

type Board = Awaited<ReturnType<typeof affiliateLeaderboardsApi.get>>;

export default async function CreatorHubLeaderboardDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireCreatorHubPageAccess();
  const { id } = await params;
  if (!isUuid(id)) notFound();

  // The ONLY blocking read — the hero renders this record. Bounded so a stuck
  // backend degrades to the route error boundary in seconds instead of
  // hanging the request; a confirmed 404 still 404s.
  const { data: lb, error } = await safeQueryOrNull(
    async () => {
      try {
        return await affiliateLeaderboardsApi.get(id);
      } catch (err) {
        if (err instanceof BackendApiError && err.status === 404) return null;
        throw err;
      }
    },
    "creator-hub.leaderboard.get",
    8_000,
  );
  if (!lb) {
    if (error) throw new Error(`Leaderboard lookup failed: ${error}`);
    notFound();
  }

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex items-start gap-3">
          <Link
            href="/creator-hub/leaderboards"
            className="mt-1 flex size-9 items-center justify-center rounded-lg border hover:bg-muted"
          >
            <ArrowLeft className="size-4" />
          </Link>
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-bold leading-tight tracking-tight">
              {lb.title}
            </h1>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <Badge
                variant="outline"
                className={APPROVAL_COLORS[lb.approval_status]}
              >
                {lb.approval_status}
              </Badge>
              <Badge variant="outline" className={TIME_COLORS[lb.time_status]}>
                {lb.time_status}
              </Badge>
              {lb.is_sponsored && <Badge variant="outline">sponsored</Badge>}
              {lb.cancelled_at && (
                <Badge
                  variant="outline"
                  className="border-zinc-500/30 bg-zinc-500/15 text-zinc-600"
                >
                  cancelled
                </Badge>
              )}
            </div>
            <Suspense fallback={<CreatorLineSkeleton />}>
              <CreatorLine
                creatorUserId={lb.creator_user_id}
              />
            </Suspense>
          </div>
        </div>
      </PageHero>

      <Suspense fallback={<DetailSkeleton />}>
        <DetailSections board={lb} />
      </Suspense>
    </div>
  );
}

// ─── Owner line (streamed — one indexed MAIN lookup) ───────────────────

async function CreatorLine({ creatorUserId }: { creatorUserId: string }) {
  const { data: creator } = await safeQueryOrNull(
    async () => {
      const db = await getDrizzleDb();
      const [creator] = await db
        .select({ id: user.id, username: user.username, email: user.email })
        .from(user)
        .where(eq(user.id, creatorUserId))
        .limit(1);
      return creator ?? null;
    },
    "creator-hub.leaderboard.creator",
    5_000,
  );

  const label =
    creator?.username ?? creator?.email ?? creatorUserId.slice(0, 8);

  return (
    <p className="mt-2 text-sm text-muted-foreground">
      Creator:{" "}
      <Link
        href={`/creator-hub/creators/${creatorUserId}`}
        className="font-medium text-foreground hover:underline"
      >
        {label}
      </Link>
    </p>
  );
}

function CreatorLineSkeleton() {
  return <Skeleton className="mt-2 h-5 w-40 rounded" />;
}

// ─── Summary + panels (streamed — the heavy fan-out) ───────────────────

async function DetailSections({ board: lb }: { board: Board }) {
  const [standings, claimHolds, wagerMap, claims, leaderboardExpiryDays] =
    await Promise.all([
      getAffiliateLeaderboardRankings({
        leaderboardId: lb.id,
        creatorUserId: lb.creator_user_id,
        coCreatorUserIds: lb.co_creator_user_ids ?? [],
        affiliateCodes: lb.affiliate_codes,
        startDate: new Date(lb.start_date),
        endDate: new Date(lb.end_date),
        prizeTiers: lb.prize_tiers,
        limit: 100,
      }).catch((err) => {
        console.error("[creator-hub.leaderboard] rankings query failed", err);
        return { rankings: [], source: "live" as const };
      }),
      affiliateLeaderboardsApi.listClaimHolds(lb.id).catch((err) => {
        console.error("[creator-hub.leaderboard] claim holds query failed", err);
        return [] as Awaited<
          ReturnType<typeof affiliateLeaderboardsApi.listClaimHolds>
        >;
      }),
      getCreatorLeaderboardWagerMap([
        {
          id: lb.id,
          creatorUserId: lb.creator_user_id,
          coCreatorUserIds: lb.co_creator_user_ids ?? [],
          affiliateCodes: lb.affiliate_codes ?? [],
          startDate: new Date(lb.start_date),
          endDate: new Date(lb.end_date),
        },
      ]).catch((err) => {
        console.error("[creator-hub.leaderboard] wager map failed", err);
        return new Map<string, number>();
      }),
      getAffiliateLeaderboardClaims(lb.id).catch((err) => {
        console.error("[creator-hub.leaderboard] claims query failed", err);
        return [] as Awaited<ReturnType<typeof getAffiliateLeaderboardClaims>>;
      }),
      getRewardExpiry().then(
        (e) => e.leaderboard_days,
        () => null as number | null,
      ),
    ]);

  const claimWindow = computeLeaderboardClaimWindow({
    endIso: lb.end_date,
    expiryDays: leaderboardExpiryDays,
  });
  const rankings = standings.rankings;
  const holdByUserId = new Map(claimHolds.map((h) => [h.user_id, h]));
  const totalWagerUsd =
    wagerMap.get(lb.id) ??
    rankings.reduce((sum, r) => sum + r.totalWageredUsd, 0);

  return (
    <>
      <FadeIn>
        <div className="space-y-3 rounded-2xl border bg-card p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Summary
          </h2>
          <SummaryRow
            label="Event window"
            value={`${formatDate(lb.start_date)} → ${formatDate(lb.end_date)}`}
          />
          <SummaryRow
            label="Prize pool"
            value={
              <span className="font-semibold tabular-nums">
                {formatCurrency(Number(lb.total_prize_usd) || 0)}
              </span>
            }
          />
          <SummaryRow
            label="Total wager"
            value={
              totalWagerUsd > 0 ? (
                <span className="font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                  {formatCurrency(totalWagerUsd)}
                </span>
              ) : (
                <span className="italic text-muted-foreground">—</span>
              )
            }
          />
          <SummaryRow
            label="Affiliate codes"
            value={
              lb.affiliate_codes.length > 0 ? (
                <div className="flex flex-wrap justify-end gap-1">
                  {lb.affiliate_codes.map((c) => (
                    <Badge key={c} variant="outline">
                      {c}
                    </Badge>
                  ))}
                </div>
              ) : (
                <span className="italic text-muted-foreground">all codes</span>
              )
            }
          />
          <div className="border-t pt-3">
            <Link
              href={`/creators/leaderboards/${lb.id}`}
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              Full admin view
              <ExternalLink className="size-3.5" />
            </Link>
          </div>
        </div>
      </FadeIn>

      <LeaderboardClaimsPanel claimWindow={claimWindow} claims={claims} />

      <LeaderboardStandingsPanel
        leaderboardId={lb.id}
        rankings={rankings}
        holdByUserId={holdByUserId}
        timeStatus={lb.time_status}
        source={standings.source}
      />
    </>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-[220px] rounded-2xl" />
      <Skeleton className="h-[180px] rounded-2xl" />
      <Skeleton className="h-[320px] rounded-2xl" />
    </div>
  );
}

function SummaryRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 text-sm">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <div className="max-w-[65%] text-right">{value}</div>
    </div>
  );
}
