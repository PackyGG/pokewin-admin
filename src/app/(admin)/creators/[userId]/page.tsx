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
  UserPlus,
  Users,
  Wallet,
} from "lucide-react";

import {
  getCreatorDetail,
  refreshStaleSocials,
} from "@/lib/queries/creators";
import { requirePageAccess } from "@/lib/dal";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHero, KpiTile } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { formatCurrency, formatNumber } from "@/lib/utils/format";

import { MaskedEmail } from "./masked-email";
import { HeaderSocials } from "./header-socials";
import { RoleSelect } from "./role-select";
import { AcquisitionChart } from "./acquisition-chart";
import { FunnelTable } from "./funnel-table";
import { FinancialsCard } from "./financials-card";
import { CountryBreakdown } from "./country-breakdown";
import { LeaderboardsCard } from "./leaderboards-card";

import { parseCreatorDetailSearchParams } from "./_lib/search-params";
import { getCreatorDealData } from "./_queries/get-creator-deal-data";
import { DealTabs } from "./_components/deal-tabs";
import { DealsTab } from "./_components/deals-tab";
import { SessionsTab } from "./_components/sessions-tab";
import { PendingTab } from "./_components/pending-tab";
import { DealFormDialog } from "./_components/deal-form-dialog";

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

  // Header data still comes from the legacy query for now — it carries
  // the profile fields (username/email/code/role/socials) the backend's
  // admin API doesn't expose yet. Deal data is fetched fresh from the
  // backend in parallel with per-tab pagination/filters.
  const [profile, dealData] = await Promise.all([
    getCreatorDetail(userId, 1, 1),
    getCreatorDealData(userId, {
      dealsPage: sp.dealsPage,
      dealsPerPage: sp.dealsPerPage,
      sessionsPage: sp.sessionsPage,
      sessionsPerPage: sp.sessionsPerPage,
      sessionsStatus: sp.sessionsStatus,
      pendingStatus: sp.pendingStatus,
    }),
  ]);

  if (!profile) notFound();

  // Non-blocking: socials cache refresh for header display.
  refreshStaleSocials(userId).catch(() => {});

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
            {profile.image && <AvatarImage src={profile.image} alt="" />}
            <AvatarFallback className="text-xs font-semibold">
              {(profile.username ?? profile.email ?? "?")
                .slice(0, 2)
                .toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <div className="hidden sm:flex size-10 items-center justify-center rounded-xl bg-pink-500/10 shrink-0">
            <Star className="size-5 text-pink-500" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <Link
                href={`/users/${profile.userId}`}
                className="text-xl sm:text-2xl font-bold leading-tight hover:underline truncate"
              >
                {profile.username ?? profile.email}
              </Link>
              {profile.code ? (
                <Badge variant="outline" className="font-mono text-[11px]">
                  {profile.code}
                </Badge>
              ) : (
                <Badge variant="secondary" className="text-[11px]">
                  No affiliate code
                </Badge>
              )}
              <span className="hidden sm:inline text-muted-foreground/40">·</span>
              <RoleSelect
                userId={profile.userId}
                currentRole={profile.role}
              />
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
              {profile.email && <MaskedEmail email={profile.email} />}
              <HeaderSocials socials={profile.socials} />
            </div>
          </div>
        </div>
      </PageHero>

      {!profile.hasAffiliateAccount && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-sm">
          <Info className="size-4 mt-0.5 text-amber-500 shrink-0" />
          <div>
            <div className="font-medium text-amber-500">
              Bu kullanıcının affiliate hesabı yok
            </div>
            <div className="mt-0.5 text-muted-foreground">
              Henüz creator olarak provision edilmemiş — affiliate code, deal,
              click ve signup metrikleri boş gözükecek.
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
            can see momentum at a glance — e.g. "12 active 7d, 3
            still going today" reads in one beat. Amber to read as
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

      <FadeIn className="space-y-4 sm:space-y-6">
        {/* Per-code activity entry points. Each is its own dedicated
            page (full-width tables, breadcrumb back, pill-tab nav to
            flip between the two views). Lives above the deal
            management band so the admin sees the entry points before
            drilling into deal terms. */}
        {profile.code && (
          <div className="grid gap-3 sm:gap-4 sm:grid-cols-2">
            <Link
              href={`/creators/${profile.userId}/users`}
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
              href={`/creators/${profile.userId}/wagers`}
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

        {/* Top band: deal management on the left (3/5), the acquisition
            chart on the right (2/5). Both in matching Card chrome so the
            row reads as one visual system with the analytics below. On
            phone they stack full-width. */}
        <div className="grid gap-3 sm:gap-4 lg:grid-cols-5">
          <Card size="sm" className="lg:col-span-3">
            <DealTabs
              value={sp.tab}
              counts={{
                deals: deals.total,
                sessions: sessions.total,
                pending: pending.length,
              }}
              action={<DealFormDialog userId={profile.userId} />}
              dealsPanel={<DealsTab userId={profile.userId} deals={deals} />}
              sessionsPanel={
                <SessionsTab
                  userId={profile.userId}
                  sessions={sessions}
                  currentStatus={sp.sessionsStatus}
                />
              }
              pendingPanel={
                <PendingTab
                  pending={pending}
                  currentStatus={sp.pendingStatus}
                />
              }
            />
          </Card>

          <aside className="lg:col-span-2">
            <AcquisitionChart
              hourly={profile.acquisition.hourly}
              daily={profile.acquisition.daily}
            />
          </aside>
        </div>

        {/* Affiliate leaderboards owned by this creator — read-only summary
            with deep-link to the dedicated /creators/leaderboards management
            surface for full action set (approve/reject/edit/sponsor/cancel).
            Sits directly below the deal tabs row so leaderboards read as
            part of the same "deal management" cluster, before the analytics
            band kicks in.
            Wrapped in Suspense so a slow backend API call here doesn't
            block the rest of the page from rendering — Next streams this
            section in once it resolves. */}
        <Suspense fallback={<LeaderboardsSkeleton />}>
          <LeaderboardsCard userId={profile.userId} />
        </Suspense>

        {/* Bottom band: three equal-width analytics cards. On phone they
            stack full-width; tablet shows two-up wherever possible. */}
        <div className="grid gap-3 sm:gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <FunnelTable
            clicks={profile.clicks}
            signups={profile.signups}
            ftdByPeriod={profile.ftdByPeriod}
          />
          <FinancialsCard
            wagerVolumeUsd={profile.totalWagerVolumeUsd}
            earnedUsd={profile.totalEarnedUsd}
            availableUsd={profile.availableUsd}
            paidOutUsd={profile.totalPaidOutUsd}
            bonusDistributedUsd={profile.totalBonusDistributedUsd}
          />
          <CountryBreakdown rows={profile.countryBreakdown} />
        </div>
      </FadeIn>
    </div>
  );
}

// ── Suspense fallbacks ───────────────────────────────────────────────
//
// Both panels do their own DB / backend round-trips, so streaming them
// in via Suspense lets the rest of the page paint immediately. The
// skeletons below match the rough shape of each panel so the page
// doesn't visibly jump when the real content swaps in.

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

