import { Suspense } from "react";
import { notFound } from "next/navigation";
import Link from "next/link";
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  BadgeDollarSign,
  Flame,
  HandCoins,
  Info,
  MousePointerClick,
  Star,
  TrendingUp,
  UserPlus,
  Users,
  Wallet,
} from "lucide-react";

import {
  getCreatorDetail,
  getCreatorHeader,
  refreshStaleSocials,
} from "@/lib/queries/creators";
import { requirePageAccess } from "@/lib/dal";
import { safeQueryOrNull } from "@/lib/errors/safe-query";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHero, SectionHeading, KpiTile } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { formatCurrency, formatNumber } from "@/lib/utils/format";

import { MaskedEmail } from "./masked-email";
import { HeaderSocials } from "./header-socials";
import { RoleSelect } from "./role-select";
import { FunnelTable } from "./funnel-table";
import { WagerBreakdownCard } from "./wager-breakdown-card";
import { AffiliatePayoutsCard } from "./affiliate-payouts-card";
import { CountryBreakdown } from "./country-breakdown";
import { LeaderboardsCard } from "./leaderboards-card";
import { CreatorPnlPanel } from "./creator-pnl-panel";
import { CreatorDealCostPanel } from "./creator-deal-cost-panel";

import { parseCreatorDetailSearchParams } from "./_lib/search-params";
import { getCreatorDealData } from "./_queries/get-creator-deal-data";
import { getCreatorHeaderSocials } from "./_queries/header-socials";
import { DealTabs } from "./_components/deal-tabs";
import { DealsTab } from "./_components/deals-tab";
import { DealsSubTabs } from "./_components/deals-sub-tabs";
import { SessionsTab } from "./_components/sessions-tab";
import { PendingTab } from "./_components/pending-tab";
import { DealFormDialog } from "./_components/deal-form-dialog";
import { ApiKeyDialog } from "./_components/api-key-dialog";
import { listMultiplierDealsForCreator } from "../multiplier-actions";
import type { CreatorDetailSearchParams } from "./_lib/search-params";

export const metadata = { title: "Creator Detail" };

export default async function CreatorDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ userId: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/creators");
  const { userId } = await params;
  const sp = parseCreatorDetailSearchParams(await searchParams);

  // CRITICAL — active-timeframe-only + lazy streaming (CLAUDE.md):
  //
  // The page used to BLOCK its entire first paint on a single
  // `Promise.all([getCreatorDetail, getCreatorDealData,
  // listMultiplierDealsForCreator])` — i.e. 12 Main-DB analytics
  // round-trips PLUS 4 backend-API round-trips all had to resolve before
  // even the PageHero rendered. That is the "loads ~10x too long" cause.
  //
  // Now the page fetches ONLY the cheap header (2 indexed lookups) on the
  // critical path so the hero + nav paint immediately, then streams every
  // heavy region through its OWN independent Suspense boundary:
  //   • CreatorKpiStrip + CreatorAcquisitionPayouts — the single
  //     getCreatorDetail() analytics round-trip, SHARED across two page
  //     positions (KPI strip at the top, acquisition + affiliate-payouts at
  //     the bottom) via one in-flight promise so the aggregate fires once.
  //   • CreatorPnlPanel — its own getCreatorPnl() ledger scan, streamed in
  //     its OWN boundary so the heavier per-window P&L + per-user popover
  //     data doesn't extend the rest of the page's TTFB.
  //   • CreatorDealCostPanel — the leaderboard + multiplier cost backend
  //     round-trips, streamed in its OWN boundary.
  //   • CreatorDealBand — the 4 backend deal/session/pending/multiplier
  //     round-trips, streamed IN PARALLEL with the bands above (none blocks
  //     the others, none blocks the hero).
  //   • LeaderboardsCard — already its own boundary.
  // Each heavy fetch is timeout-bounded (safeQuery) so a slow one degrades
  // to a fallback instead of hanging the segment.
  const header = await getCreatorHeader(userId);
  if (!header) notFound();

  // Non-blocking: socials cache refresh for header display.
  refreshStaleSocials(userId).catch(() => {});

  // The KPI strip (top of page) and the acquisition + affiliate-payouts
  // section (bottom of page) both render off the SAME getCreatorDetail()
  // aggregate. To honour the owner's requested layout — KPI strip first,
  // acquisition/payouts last — without firing the heavy aggregate twice, we
  // kick it off ONCE here (not awaited on the critical path) and hand the
  // single in-flight promise to both streamed slots. React awaits the same
  // promise object in two places → the 12 Main-DB round-trips run exactly
  // once, but the rendered output is split across the page. Timeout-bounded
  // via safeQueryOrNull so a slow scan degrades to a fallback per-slot
  // instead of hanging the segment.
  const profileResultPromise = safeQueryOrNull(
    () => getCreatorDetail(userId),
    "creators.detail.profile",
    // 15s (was 20s) so the KPI strip degrades to its "analytics taking too
    // long" banner faster when the heavy aggregate stalls, rather than
    // holding the skeleton for a full 20s. The deal/multiplier bands below
    // keep their own 20s budget — they're independent Suspense boundaries.
    15_000,
  );

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex items-start gap-2.5 sm:gap-3 flex-wrap">
          <Link
            href="/creators"
            className="inline-flex size-9 items-center justify-center rounded-md hover:bg-accent hover:text-accent-foreground shrink-0"
          >
            <ArrowLeft className="size-4" />
          </Link>
          <Avatar className="size-10 sm:size-11 shrink-0">
            {header.image && <AvatarImage src={header.image} alt="" />}
            <AvatarFallback className="text-xs font-semibold">
              {(header.username ?? header.email ?? "?")
                .slice(0, 2)
                .toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <div className="hidden sm:flex size-10 items-center justify-center rounded-xl bg-pink-500/10 shrink-0">
            <Star className="size-5 text-pink-500" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex min-w-0 items-center gap-2 flex-wrap">
              <Link
                href={`/users/${header.userId}`}
                className="min-w-0 text-xl sm:text-2xl font-bold leading-tight hover:underline line-clamp-1"
              >
                {header.username ?? header.email}
              </Link>
              {header.code ? (
                <Badge variant="outline" className="font-mono text-[11px]">
                  {header.code}
                </Badge>
              ) : (
                <Badge variant="secondary" className="text-[11px]">
                  No affiliate code
                </Badge>
              )}
              <span className="hidden sm:inline text-muted-foreground/40">·</span>
              <RoleSelect userId={header.userId} currentRole={header.role} />
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
              {header.email && <MaskedEmail email={header.email} />}
              {/* Socials chips stream in their own boundary so the hero
                  text paints instantly; a thin admin-DB read (not the heavy
                  analytics aggregate) backs them. */}
              <Suspense
                fallback={
                  <span className="inline-flex items-center rounded-md border border-dashed px-1.5 py-0.5 text-[11px] text-muted-foreground">
                    …
                  </span>
                }
              >
                <HeaderSocialsStreamed userId={header.userId} />
              </Suspense>
            </div>
          </div>
          {header.role === "creator" && (
            <div className="ml-auto shrink-0">
              <ApiKeyDialog userId={header.userId} />
            </div>
          )}
        </div>
      </PageHero>

      <FadeIn className="space-y-4 sm:space-y-6">
        {/* 1 ── Display boxes (KPI strip) — top of page. Owns the FIRST
            render slot of the single getCreatorDetail() aggregate (shared
            with the acquisition + payouts section at the bottom via
            profileResultPromise, so the heavy read fires only once).
            Streamed so its Main-DB round-trips don't extend the hero's
            TTFB. ───────────────────────────────────────────────────────── */}
        <Suspense fallback={<CreatorKpiStripSkeleton />}>
          <CreatorKpiStrip profileResultPromise={profileResultPromise} />
        </Suspense>

        {/* 2 ── Users on code + Last wagers — per-code activity entry points,
            directly below the KPI strip. Each is its own dedicated page
            (full-width tables, breadcrumb back, pill-tab nav). Driven by the
            cheap header code so it paints with the hero, not behind the
            analytics band. ──────────────────────────────────────────────── */}
        {header.code && (
          <div className="grid gap-3 sm:gap-4 sm:grid-cols-2">
            <Link
              href={`/creators/${header.userId}/users`}
              className="group flex items-center gap-3 rounded-2xl border bg-card/60 p-4 transition-all hover:border-foreground/20 hover:bg-card hover:shadow-sm"
            >
              <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-blue-500/10 text-blue-500">
                <Users className="size-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold">Users on code</div>
                <div className="truncate text-xs text-muted-foreground">
                  Everyone tied to this creator&apos;s code
                </div>
              </div>
              <ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
            </Link>
            <Link
              href={`/creators/${header.userId}/wagers`}
              className="group flex items-center gap-3 rounded-2xl border bg-card/60 p-4 transition-all hover:border-foreground/20 hover:bg-card hover:shadow-sm"
            >
              <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-500">
                <Activity className="size-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold">Last wagers</div>
                <div className="truncate text-xs text-muted-foreground">
                  Recent wager events from those users
                </div>
              </div>
              <ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
            </Link>
          </div>
        )}

        {/* 3 ── Deals / Sessions — the 4 backend round-trips
            (deals/sessions/pending/multiplier), streamed in its OWN
            boundary so it loads in parallel with the analytics band rather
            than serially behind it. ─────────────────────────────────────── */}
        <Suspense fallback={<CreatorDealBandSkeleton />}>
          <CreatorDealBand userId={userId} sp={sp} />
        </Suspense>

        {/* 4 ── Affiliate leaderboards owned by this creator — read-only
            summary with deep-link to the dedicated management surface. Its
            own Suspense so a slow backend call here doesn't block the rest
            of the page. ─────────────────────────────────────────────────── */}
        <Suspense fallback={<LeaderboardsSkeleton />}>
          <LeaderboardsCard userId={userId} />
        </Suspense>

        {/* 5 ── PnL boxes — the all-time hero + 5 windowed boxes
            (1d / 3d / 7d / 2w / 1m), each with the per-user hover popover.
            Only needs userId (its own getCreatorPnl ledger scan), so it
            streams in its OWN boundary in parallel with everything above. ── */}
        <Suspense fallback={<CreatorPnlSkeleton />}>
          <CreatorPnlPanel userId={userId} />
        </Suspense>

        {/* 6 ── Everything else (below the PnL boxes):
            • Affiliate payouts + Acquisition (funnel / wager breakdown /
              country) — the SECOND render slot of the shared
              getCreatorDetail() aggregate. Streamed in its own boundary off
              the same in-flight profileResultPromise as the KPI strip, so no
              extra round-trip.
            • House deal-cost panel — the money the house spends ON this
              creator's promo programs (approved-leaderboard prizes net of
              escrow, multiplier payout vouchers, net multiplier fill),
              streamed via its own boundary. */}
        <Suspense fallback={<CreatorAcquisitionPayoutsSkeleton />}>
          <CreatorAcquisitionPayouts profileResultPromise={profileResultPromise} />
        </Suspense>

        <Suspense fallback={<CreatorDealCostSkeleton />}>
          <CreatorDealCostPanel userId={userId} />
        </Suspense>
      </FadeIn>
    </div>
  );
}

// ── Streamed header socials ──────────────────────────────────────────
//
// Thin admin-DB read of the creator's connected-social chips, streamed so
// the hero text never waits on it. Best-effort: a failure renders the
// "No socials linked" empty state (HeaderSocials with []) rather than
// crashing the hero.
async function HeaderSocialsStreamed({ userId }: { userId: string }) {
  const socials = await getCreatorHeaderSocials(userId).catch(() => []);
  return <HeaderSocials socials={socials} />;
}

// ── Shared getCreatorDetail() result ──────────────────────────────────
//
// Both the KPI strip (top of page) and the acquisition + affiliate-payouts
// section (bottom of page) render off the SINGLE heavy getCreatorDetail()
// aggregate (12 Main-DB round-trips). The page kicks the read off ONCE and
// passes the same in-flight `safeQueryOrNull` result promise to both
// components below, so the aggregate fires exactly once even though its
// output is split across two page positions.
type ProfileResultPromise = Promise<{
  data: Awaited<ReturnType<typeof getCreatorDetail>> | null;
  error: string | null;
}>;

// ── 1 ── Streamed KPI strip (top of page) ─────────────────────────────
//
// First render slot of the shared aggregate. Renders the degraded-state /
// "no affiliate account" banners + the 6 KPI tiles. Streamed behind its
// own Suspense so the read never extends the hero's TTFB.
async function CreatorKpiStrip({
  profileResultPromise,
}: {
  profileResultPromise: ProfileResultPromise;
}) {
  const { data: profile } = await profileResultPromise;

  // getCreatorDetail returns null only for a truly unknown user — but the
  // hero already resolved via getCreatorHeader, so a null here means the
  // analytics read failed/timed out. Surface a compact degraded state for
  // this band rather than 404-ing the whole (already-rendered) page.
  if (!profile) {
    return (
      <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-sm">
        <Info className="size-4 mt-0.5 text-amber-500 shrink-0" />
        <div>
          <div className="font-medium text-amber-500">
            Creator analytics are taking too long to load
          </div>
          <div className="mt-0.5 text-muted-foreground">
            The financial + acquisition metrics timed out. Refresh to retry —
            the rest of the page is unaffected.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      {!profile.hasAffiliateAccount && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-sm">
          <Info className="size-4 mt-0.5 text-amber-500 shrink-0" />
          <div>
            <div className="font-medium text-amber-500">
              This user has no affiliate account
            </div>
            <div className="mt-0.5 text-muted-foreground">
              Not yet provisioned as a creator — affiliate code, deal, click,
              and signup metrics will appear empty.
            </div>
          </div>
        </div>
      )}

      {/* KPI strip — house-POV financial colors:
          - Total Earned: money paid TO creator → rose (house loss)
          - Wager Volume: money flowing FROM users TO us → emerald
          - Clicks / Signups / FTDs: funnel events → blue family
          - Active affi: currently-engaged referrals → amber
          Phone: 2 cols, tablet: 3 cols, desktop: 6 cols (1 row). */}
      <div className="grid grid-cols-2 gap-2.5 sm:gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <KpiTile
          label="Clicks"
          value={formatNumber(profile.clicks.total)}
          icon={MousePointerClick}
          accent="blue"
        />
        <KpiTile
          label="Signups"
          value={formatNumber(profile.signups.total)}
          icon={UserPlus}
          accent="cyan"
        />
        {/* FTDs — distinct referrals who actually deposited (gates on
            both an affiliate_code_usages 'deposit' row for this code
            AND a balances row with total_deposited > 0). All-time
            count across this creator's primary code. */}
        <KpiTile
          label="FTDs"
          value={formatNumber(profile.ftdCount)}
          icon={BadgeDollarSign}
          accent="purple"
        />
        {/* Active affi — distinct referrals with any deposit /
            wager activity. Headline value is the 7-day count (the
            window the affiliate system uses to count them as
            "active"); subtitle layers in the 24h count so the admin
            can see momentum at a glance. Amber to read as
            "currently warm". */}
        <KpiTile
          label="Active affi"
          value={formatNumber(profile.activeReferrals7d)}
          sub={`${formatNumber(profile.activeReferrals24h)} in 24h · 7d window`}
          icon={Flame}
          accent="amber"
        />
        <KpiTile
          label="Wager Volume"
          value={formatCurrency(profile.totalWagerVolumeUsd)}
          icon={Wallet}
          accent="emerald"
        />
        <KpiTile
          label="Total Earned"
          value={formatCurrency(profile.totalEarnedUsd)}
          sub={`Paid out: ${formatCurrency(profile.totalPaidOutUsd)}`}
          icon={HandCoins}
          accent="rose"
        />
      </div>
    </div>
  );
}

// ── 6 ── Streamed acquisition + affiliate-payouts section (bottom) ─────
//
// Second render slot of the SAME shared aggregate — awaits the same
// in-flight `profileResultPromise` the KPI strip consumes, so no extra
// round-trip is fired. Renders the acquisition funnel/wager
// breakdown/country split + the affiliate-payouts card. If the aggregate
// failed/timed out the KPI strip already surfaced the degraded banner, so
// this slot renders nothing rather than repeating it.
async function CreatorAcquisitionPayouts({
  profileResultPromise,
}: {
  profileResultPromise: ProfileResultPromise;
}) {
  const { data: profile } = await profileResultPromise;
  if (!profile) return null;

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* ── Acquisition + affiliate payouts — one aligned row of 4 equal
          boxes: the clicks → signups → FTDs funnel, the per-game
          wager-volume breakdown, the creator's affiliate-commission account
          state (placed directly beside the wager-volume box), and the
          geographic split. (The noisy hourly/daily time-series chart was
          removed — at this per-creator granularity it read as near-zero
          noise; the funnel + breakdowns here carry the useful signal.)
          4-up on desktop, 2-up on tablet, 1-up on phone; `items-stretch`
          so the boxes match heights regardless of their internal row
          counts. ───────────────────────────────────────────────────────── */}
      <div className="space-y-3">
        <SectionHeading icon={TrendingUp} title="Acquisition" />
        <div className="grid items-stretch gap-3 sm:gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <FunnelTable
            clicks={profile.clicks}
            signups={profile.signups}
            ftdByPeriod={profile.ftdByPeriod}
          />
          <WagerBreakdownCard
            wagerVolumeUsd={profile.totalWagerVolumeUsd}
            wagerBreakdown={profile.wagerBreakdown}
          />
          {/* Affiliate payouts — the creator's commission account state
              (earned / available / paid-out / bonus). Placed directly next
              to the wager-volume box per the owner's layout. */}
          <AffiliatePayoutsCard
            earnedUsd={profile.totalEarnedUsd}
            availableUsd={profile.availableUsd}
            paidOutUsd={profile.totalPaidOutUsd}
            bonusDistributedUsd={profile.totalBonusDistributedUsd}
          />
          <CountryBreakdown rows={profile.countryBreakdown} />
        </div>
      </div>
    </div>
  );
}

// ── Streamed deal-management band ─────────────────────────────────────
//
// Owns the 4 backend-API round-trips (deals + sessions + pending +
// multiplier deals). Streamed from the page so it loads IN PARALLEL with
// the analytics band rather than serially behind a shared blocking await.
// Backend failures degrade to empty states (the underlying helpers
// already handle 404 → null).
async function CreatorDealBand({
  userId,
  sp,
}: {
  userId: string;
  sp: CreatorDetailSearchParams;
}) {
  const [dealDataResult, multiplierResult] = await Promise.all([
    safeQueryOrNull(
      () =>
        getCreatorDealData(userId, {
          dealsPage: sp.dealsPage,
          dealsPerPage: sp.dealsPerPage,
          sessionsPage: sp.sessionsPage,
          sessionsPerPage: sp.sessionsPerPage,
          sessionsStatus: sp.sessionsStatus,
          pendingStatus: sp.pendingStatus,
        }),
      "creators.detail.dealData",
      20_000,
    ),
    safeQueryOrNull(
      () => listMultiplierDealsForCreator(userId, { offset: 0, limit: 25 }),
      "creators.detail.multiplierDeals",
      20_000,
    ),
  ]);

  const dealData = dealDataResult.data;
  const multiplierDealsPage = multiplierResult.data;
  const multiplierDeals = multiplierDealsPage?.data ?? [];
  const multiplierCount = multiplierDealsPage?.total ?? 0;

  const deals = dealData?.deals ?? {
    data: [],
    total: 0,
    page: 1,
    perPage: sp.dealsPerPage,
    totalPages: 1,
  };
  const sessions = dealData?.sessions ?? {
    data: [],
    total: 0,
    page: 1,
    perPage: sp.sessionsPerPage,
    totalPages: 1,
  };
  const pending = dealData?.pending ?? [];

  return (
    <Card size="sm">
      <DealTabs
        value={sp.tab}
        counts={{
          deals: deals.total + multiplierCount,
          sessions: sessions.total,
          pending: pending.length,
        }}
        action={<DealFormDialog userId={userId} />}
        dealsPanel={
          <DealsSubTabs
            userId={userId}
            fillCount={deals.total}
            multiplierCount={multiplierCount}
            fillPanel={<DealsTab userId={userId} deals={deals} />}
            multiplierDeals={multiplierDeals}
          />
        }
        sessionsPanel={
          <SessionsTab
            userId={userId}
            sessions={sessions}
            currentStatus={sp.sessionsStatus}
          />
        }
        pendingPanel={
          <PendingTab pending={pending} currentStatus={sp.pendingStatus} />
        }
      />
    </Card>
  );
}

// ── Suspense fallbacks ───────────────────────────────────────────────

function LeaderboardsSkeleton() {
  return (
    <Card size="sm" className="space-y-3 p-4 sm:p-5">
      <div className="flex items-center justify-between">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-8 w-24" />
      </div>
      <div className="space-y-2">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
    </Card>
  );
}

// Placeholder matching the deal-management band — a full-width tabbed deal
// card (tab bar + a few rows).
function CreatorDealBandSkeleton() {
  return (
    <Card size="sm" className="space-y-3 p-4">
      <div className="flex items-center justify-between border-b pb-3">
        <div className="flex gap-3">
          <Skeleton className="h-7 w-16" />
          <Skeleton className="h-7 w-20" />
          <Skeleton className="h-7 w-20" />
        </div>
        <Skeleton className="h-8 w-24" />
      </div>
      <Skeleton className="h-9 w-full" />
      <Skeleton className="h-9 w-full" />
      <Skeleton className="h-9 w-full" />
    </Card>
  );
}

// Placeholder matching the KPI strip — the "no account" banner space is
// omitted (it only renders for non-affiliate users), so this is the 6 KPI
// tiles only, so the page doesn't reflow when the real strip lands.
function CreatorKpiStripSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-2.5 sm:gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <Card key={i} size="sm" className="space-y-2 p-4">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-6 w-20" />
          <Skeleton className="h-2.5 w-14" />
        </Card>
      ))}
    </div>
  );
}

// Placeholder matching the acquisition + affiliate-payouts section — one
// heading + the single 4-card breakdown row (funnel / wager-volume /
// affiliate-payouts / countries) so the page doesn't reflow when the real
// content lands.
function CreatorAcquisitionPayoutsSkeleton() {
  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="space-y-3">
        <Skeleton className="h-6 w-32" />
        <div className="grid items-stretch gap-3 sm:gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Skeleton className="h-48 rounded-2xl" />
          <Skeleton className="h-48 rounded-2xl" />
          <Skeleton className="h-48 rounded-2xl" />
          <Skeleton className="h-48 rounded-2xl" />
        </div>
      </div>
    </div>
  );
}

// Single StatPanel placeholder matching the CreatorDealCostPanel shape
// (heading + one hero panel with a few breakdown rows) so the page
// doesn't reflow when the real content lands.
function CreatorDealCostSkeleton() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-5 w-36" />
      <Card size="sm" className="space-y-3 p-4 sm:p-5">
        <Skeleton className="h-4 w-44" />
        <Skeleton className="h-9 w-32" />
        <Skeleton className="h-3 w-56" />
        <div className="space-y-1.5 pt-2">
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-full" />
        </div>
      </Card>
    </div>
  );
}

// Placeholder matching the CreatorPnlPanel shape — the all-time hero panel
// plus the 5 windowed boxes — so the page doesn't reflow when the real
// content lands.
function CreatorPnlSkeleton() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-5 w-36" />
      <Card size="sm" className="space-y-3 p-4 sm:p-5">
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-3 w-56" />
        <div className="grid grid-cols-1 gap-2 pt-2 sm:grid-cols-3">
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-full" />
        </div>
      </Card>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {[0, 1, 2, 3, 4].map((i) => (
          <Card key={i} size="sm" className="space-y-2 p-4">
            <Skeleton className="h-4 w-10" />
            <Skeleton className="h-7 w-24" />
            <Skeleton className="h-3 w-20" />
            <div className="space-y-1.5 pt-1">
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-full" />
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
