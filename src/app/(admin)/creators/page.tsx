import { Suspense } from "react";
import {
  AlertTriangle,
  Coins,
  LineChart,
  Megaphone,
  Sparkles,
  Users,
  UserX,
  Wallet,
  Zap,
} from "lucide-react";

import { requirePageAccess } from "@/lib/dal";
import { cn } from "@/lib/utils";
import {
  safeQuery,
  safeQueryOrNull,
  withTimeout,
  isQueryTimeoutError,
} from "@/lib/errors/safe-query";
import { FadeIn } from "@/components/fade-in";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { BackendApiError, BackendNetworkError } from "@/lib/backend-api";
import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import {
  CreatorsKpiPanel,
  CreatorsSignedHero,
  CreatorsPlainHero,
  CreatorsPanelChip,
  CreatorsPanelSub,
} from "./_components/creators-kpi-panel";

import {
  parseCreatorsSearchParams,
  type CreatorsSearchParams,
  type CreatorsTab,
} from "./_lib/search-params";
import { type CreatorsListPage } from "./_queries/list-creators";
import { listCreatorsFiltered } from "./_queries/list-creators-filtered";
import { getCreatorsListForTab } from "./_queries/list-creators-by-tab";
import {
  getExCreatorsList,
  getExCreatorCount,
} from "./_queries/list-ex-creators";
import {
  getApprovedSocialsByUser,
  type CreatorSocialSummary,
} from "./_queries/socials-by-user";
import {
  getCodeAndWagerByUser,
  type CreatorCodeAndWager,
} from "./_queries/code-and-wager-by-user";
import { getCreatorsGlobalStats } from "./_queries/creators-stats";
import { getMultiplierCreatorCount } from "./_queries/multiplier-creator-count";
import { getFillCreatorCount } from "./_queries/fill-creator-count";
import {
  getDealCapInfoByUser,
  type DealCapInfo,
} from "./_queries/deal-cap-by-user";
import {
  getWithdrawnFromConvertedByDeal,
  type WithdrawnFromConverted,
} from "./_queries/withdrawn-from-converted-by-deal";
import {
  getLeaderboardCostTotal,
  getLeaderboard2wkCostByUser,
  type Lb2wkInfo,
} from "./_queries/leaderboard-cost";
import { getTipsSponsorSpend } from "./_queries/tips-sponsor-spend";
import { type CreatorWithSocials } from "./_components/creator-card-grid";
import { LeaderboardSpendPanel } from "./_components/leaderboard-spend-tile";
import { TipsSponsorSpendPanel } from "./_components/tips-sponsor-spend-tile";
import { AddCreatorDialog } from "./_components/add-creator-dialog";
import { WhitelistDialog } from "./_components/whitelist-dialog";
import { CreatorsSearchProvider } from "./_components/creators-search-context";
import { CreatorsSearchInput } from "./_components/creators-search-input";
import { CreatorsTabSwitch } from "./_components/creators-tab-switch";
import { CreatorsViewToggle } from "./_components/creators-view-toggle";
import { CreatorsViewProvider } from "./_components/creators-view-context";
import { CreatorsViewRender } from "./_components/creators-view-render";
import {
  CreatorsSortControl,
  CreatorsPeriodControl,
} from "./_components/creators-sort-control";
import { GlobalPnlByCreatorPopover } from "./_components/global-pnl-by-creator-popover";
import { NetGgrBreakdownPopover } from "./_components/net-ggr-breakdown-popover";
import { InfoHint } from "./_components/info-hint";
import { BackendUnavailableHint } from "./_components/backend-unavailable-hint";
import { getAllCreatorsLifetimePnl } from "./_queries/all-creators-lifetime-pnl";
import { getAllCreatorsNetGgr } from "./_queries/all-creators-net-pnl";
import { DASHBOARD_PERIOD_LABELS } from "@/lib/queries/dashboard-period";

export const metadata = { title: "Creators" };

// Server pagination is disabled on /creators: every render path now fits a
// single page (the default tab path fetches the whole pool at `perPage: 100`
// so the instant client-side search can filter every creator; the tile-filter
// and Past paths were already single-page). This flag gates the pagination
// control off while keeping its (narrowing) guard + element in place for a
// future paginated path. Typed `boolean` (not the literal `false`) on purpose
// so TS can't dead-code-eliminate the branch and drop the `result` non-null
// narrowing the JSX below relies on.
const SHOW_PAGINATION: boolean = false;

// Wall-clock bound for every BACKEND-API-dependent read on this page. The
// backend fetch client already caps each round-trip at 8s
// (DEFAULT_TIMEOUT_MS in backend-api/client.ts), but a read that fans out
// across many creators (the roster walk, the per-deal cap fan-out) can
// stack those, and a `.catch()` only rescues a THROW — not a hang. Wrapping
// each backend read in safeQuery with this timeout means one slow/dead leg
// degrades to its fallback (→ the tile shows "—" + a "backend unavailable"
// hint) instead of pinning the Server Component until the platform kills
// the whole request. Set a hair above the client's 8s so a healthy-but-slow
// single call still lands, while a truly unreachable backend degrades fast.
const BACKEND_READ_TIMEOUT_MS = 10_000;

// Wall-clock bound for the two heavy Main-DB attribution tiles — Net
// Code-User GGR (getAllCreatorsNetGgr) and Fill/Multiplier-Segment Net
// (getAllCreatorsLifetimePnl). Both are now SET-BASED (one pass, not N
// correlated subqueries) AND cross-request `unstable_cache`d (300s / 900s),
// so the heavy scan runs at most once per TTL and every other render is
// instant. The catch: the cache only helps once the COLD run completes and
// populates the slot — abandoning it at the 10s backend budget would leave
// the tile stuck on "—" forever, never warming the cache. So these two get
// a more generous cold-run budget: long enough for the once-per-TTL cold
// scan to finish and fill the slot (then every later render serves the
// cached value in <1ms), but still BELOW the DB's 30s global
// `statement_timeout` (db.ts) so a genuinely pathological scan still
// degrades to "—" via safeQuery instead of pinning the streamed tile. These
// run once per 5–15 min, so the occasional longer cold render is fine — it
// only ever blocks the streamed tile, never the already-painted page shell.
const HEAVY_ATTRIBUTION_TILE_TIMEOUT_MS = 25_000;

export default async function CreatorsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/creators");

  const params = parseCreatorsSearchParams(await searchParams);

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Megaphone}
          accent="pink"
          title="Creators"
          subtitle="Weekly fill deals, stream sessions, and payouts."
          action={
            <div className="flex items-center gap-2">
              <WhitelistDialog />
              <AddCreatorDialog />
            </div>
          }
        />
      </PageHero>

      {/* KPI strip — Suspense boundary keyed on `tab` so flipping
          Fill / Multiplier swaps the strip to a skeleton instead of
          freezing the page on stale numbers. The single tab-aware
          tile inside (Fill Creators / Multiplier Creators) flips
          label, value, and icon from the active tab's cached count.
          Layout: 6 uniform dashboard-style panels (4 figure panels +
          the Leaderboard Spend + Tips & Sponsor Spend panels) on a
          responsive grid (1-up on phones, 2 at sm, 4 at lg, 6 at xl). */}
      <Suspense
        key={`kpi-${params.tab}-${params.filter ?? ""}`}
        fallback={<CreatorsKpiStripSkeleton />}
      >
        <CreatorsKpiStrip tab={params.tab} period={params.period} />
      </Suspense>

      <div className="space-y-3">
        {/* The heading reflects the active view: a KPI-tile filter
            ("Live Creators" / "Creators with Active Deals", which also
            hides the tab switch), the Past Creators tab ("Canceled /
            Past Creators"), or the default ("Creators"). */}
        <SectionHeading
          icon={params.tab === "past" ? UserX : Users}
          title={
            params.filter === "live"
              ? "Live Creators"
              : params.filter === "active-deals"
                ? "Creators with Active Deals"
                : params.tab === "past"
                  ? "Canceled / Past Creators"
                  : "Creators"
          }
        />
        {/* Both providers are now URL-bound (Item C, 2026-06-05): the
            search query lives in `?q=` and the Grid / List view lives in
            `?view=`, so bookmarking + sharing the URL restores the exact
            filtered view + render mode. They are still INSTANT — neither
            param is in the grid Suspense `key=` below, so flipping the
            view OR typing a query re-renders the SAME already-fetched
            rows in place with no navigation, no refetch, and no
            skeleton. See _components/creators-search-context.tsx +
            creators-view-context.tsx for the URL-sync mechanics. The
            providers wrap BOTH the toolbar inputs AND the renderer
            inside the Suspense boundary so they share one state and the
            controls keep rendering during any unrelated data refetch. */}
        <CreatorsSearchProvider>
          <CreatorsViewProvider>
            <FadeIn className="space-y-4">
              {/* Toolbar is OUTSIDE the Suspense boundary so the search +
                  tab switch + view toggle stay responsive while the rows
                  stream in. Tab switch (leading) hides while a filter is
                  active — the filter overrides the Fill / Multiplier view.
                  The search slot is an instant client-side filter
                  (CreatorsSearchInput → CreatorsSearchProvider); the
                  Grid / List view toggle (trailing `children`) flips the
                  render mode via client state — neither refetches. */}
              <DataTableToolbar
                searchSlot={
                  <CreatorsSearchInput placeholder="Search by username or email..." />
                }
                leading={params.filter ? undefined : <CreatorsTabSwitch />}
              >
                {/* Period chips scope the windowed code-user GGR on each
                    row (+ the roster-wide Net GGR tile); the sort dropdown
                    re-orders the page by GGR / FTDs. Both drive URL params
                    and live alongside the Grid / List view toggle. The
                    period chips are hidden on the Past Creators tab — GGR
                    is creator-gated there (ex-creators always render "—"),
                    so scoping a window has no effect. The sort dropdown
                    stays (its FTD / recent modes still work page-locally). */}
                {params.tab !== "past" && <CreatorsPeriodControl />}
                <CreatorsSortControl />
                <CreatorsViewToggle />
              </DataTableToolbar>
              {/* Card grid / list + pagination — Suspense boundary keyed on
                  `tab` + `page` + `sortBy` + `filter` + `period` so any
                  navigation that swaps the underlying data set shows the
                  skeleton instead of leaving the stale grid blocking.
                  `view` AND `q` are URL-bound (Item C, 2026-06-05) but
                  INTENTIONALLY NOT in this key — both are pure presentation
                  over the SAME already-fetched data (view toggle / instant
                  client-side search filter), so a `?view=` or `?q=` change
                  must NOT throw a fresh boundary / refetch the roster.
                  Keeping them out of the key preserves the instant
                  no-skeleton UX while still making the URL round-trippable.
                  `key=` forces React to throw the fresh boundary on every
                  data-changing navigation. */}
              <Suspense
                key={`grid-${params.tab}-${params.page}-${params.sortBy}-${params.perPage}-${params.filter ?? ""}-${params.period}`}
                fallback={<CreatorsGridSkeleton />}
              >
                <CreatorsGridSection params={params} />
              </Suspense>
            </FadeIn>
          </CreatorsViewProvider>
        </CreatorsSearchProvider>
      </div>
    </div>
  );
}

// ─── KPI strip ────────────────────────────────────────────────────
//
// Reskinned onto the dashboard's KPI-panel design (tinted `Card` + header
// with icon + Info/drill-in slot + hero value + chip-grid/sub) so the
// strip reads as one family with /dashboard's "P&L Today"-style cards.
//
// Tab-aware: ONE swap panel (Fill Creators / Multiplier Creators) — its
// value, label, and icon flip from the cached per-tab count. The other
// figures (Net Code-User GGR, Global PnL, Converted) stay tab-
// independent. The Leaderboard Spend and Tips & Sponsor Spend panels
// surface house cost (past-vs-active; tips + sponsor legs) on the same
// shell.
//
// Layout: 6 uniform panels (swap / Net GGR / Global PnL / Converted /
// Leaderboard Spend / Tips & Sponsor Spend) on a responsive grid: 1-up on
// phones, 2 at sm, 4 at lg, 6 across at xl.

async function CreatorsKpiStrip({
  tab,
  period,
}: {
  tab: CreatorsTab;
  period: CreatorsSearchParams["period"];
}) {
  // Past Creators tab — every other figure in the strip (Net GGR, Global
  // PnL, Converted, Leaderboard Spend) is an ACTIVE-roster figure that
  // would be misleading next to a list of canceled creators, and the
  // GGR/PnL aggregates are creator-gated (ex-creators don't appear in
  // them). So the Past tab renders a single honest tile — the ex-creator
  // count — instead of the full strip, and skips the active-roster
  // fan-outs entirely (active-timeframe rule).
  if (tab === "past") {
    // DB-sourced (ex-creator set from Main + Admin DB), not a backend read —
    // wrapped with a timeout purely so a slow scan degrades to "—" instead
    // of hanging the strip.
    const { data: pastCount } = await safeQueryOrNull(
      () => getExCreatorCount(),
      "creators.ex-creator-count",
      BACKEND_READ_TIMEOUT_MS,
    );
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-4 xl:grid-cols-6">
        <CreatorsKpiPanel
          title="Past Creators"
          icon={UserX}
          tint="purple"
          titleAdornment={
            <InfoHint text="Users who once held the creator role but no longer do — deal cancelled or role removed. Their full historical economics live on each creator's detail page." />
          }
        >
          <CreatorsPlainHero
            value={pastCount ?? null}
            format="number"
          />
          <CreatorsPanelSub>Canceled / role-removed ex-creators</CreatorsPanelSub>
        </CreatorsKpiPanel>
      </div>
    );
  }

  // Per-tab count for the swap tile — only the active tab's count is
  // needed each render. Each helper is its own cached fan-out so
  // bouncing between tabs doesn't re-fetch the whole creator pool.
  const tabCountPromise =
    tab === "multiplier"
      ? getMultiplierCreatorCount()
      : getFillCreatorCount();

  // Every entry is a BACKEND-API read EXCEPT tips/sponsor (Main DB). Each is
  // wrapped in safeQuery/safeQueryOrNull with a wall-clock timeout so an
  // unreachable backend degrades that ONE tile to its fallback (+ a "backend
  // unavailable" hint) instead of throwing out of this Server Component and
  // taking the whole page down. `.error` (non-null on failure/timeout) drives
  // the per-tile affordance below; we never echo the raw message into the DOM.
  const [
    tabCountResult,
    statsResult,
    leaderboardCostResult,
    tipsSponsorSpendResult,
  ] = await Promise.all([
    // Fill / Multiplier creator count — backend creator-pool walk
    // (creatorsApi / multiplierDealsApi). null fallback → tile renders "—".
    safeQueryOrNull(
      () => tabCountPromise,
      `creators.${tab}-count`,
      BACKEND_READ_TIMEOUT_MS,
    ),
    // Global creator stats (Converted/withdrawn + counts) — backend
    // creatorsApi.list walk. null fallback → the Converted tile renders "—".
    safeQueryOrNull(
      () => getCreatorsGlobalStats(),
      "creators.global-stats",
      BACKEND_READ_TIMEOUT_MS,
    ),
    // Leaderboard spend — backend affiliateLeaderboardsApi walk. null
    // fallback → the compact Leaderboard Spend tile renders "—".
    safeQueryOrNull(
      () => getLeaderboardCostTotal(),
      "creators.leaderboard-cost",
      BACKEND_READ_TIMEOUT_MS,
    ),
    // Tips & sponsor spend — lifetime house cost of the creator-funded
    // tips/sponsor pool (creator_fill_spend_tip + creator_fill_spend_battle).
    // Main-DB (NOT a backend read). The query already filters via `type::text`
    // so a not-yet-populated enum value can't error (the box reads $0 until
    // the fill system is live); the safeQueryOrNull wrapper degrades any
    // OTHER failure to null → the panel renders "—" instead of crashing.
    safeQueryOrNull(
      () => getTipsSponsorSpend(),
      "creators.tips-sponsor-spend",
      BACKEND_READ_TIMEOUT_MS,
    ),
  ]);
  const tabCount = tabCountResult.data;
  const stats = statsResult.data;
  const leaderboardCost = leaderboardCostResult.data;
  const tipsSponsorSpend = tipsSponsorSpendResult.data;
  // Per-tile "backend is down" flags — true when the backend read
  // failed/timed out (drives the inline amber affordance). A genuine $0 from
  // a reachable backend leaves these false, so a real zero never shows the
  // "unavailable" hint.
  //
  // The swap-tile count helpers (getFillCreatorCount / getMultiplierCreator-
  // Count) already swallow a backend failure INTERNALLY and resolve to `null`
  // (rather than throwing), so safeQuery's `.error` stays null on a backend
  // outage. A real count is always a number, so `tabCount == null` is itself
  // the "couldn't load" signal — OR the safeQuery error (a timeout we raced).
  // getCreatorsGlobalStats / getLeaderboardCostTotal DO throw their backend-
  // walk failures, so their `.error` flag is authoritative.
  const tabCountBackendDown = tabCountResult.error !== null || tabCount == null;
  const statsBackendDown = statsResult.error !== null;
  const leaderboardBackendDown = leaderboardCostResult.error !== null;

  // Tab-aware tile contents — flips label, icon, and accent based on
  // which tab program the user is viewing. Matches the icon set used
  // by <CreatorsTabSwitch /> (Coins for Fill, Zap for Multiplier) so
  // the strip + the tab pills read as one cohesive control. The Past
  // tab is handled by the early return above.
  const tabTile =
    tab === "multiplier"
      ? {
          label: "Multiplier Creators",
          icon: Zap,
          tint: "purple" as const,
          sub: "Creators with a multiplier deal",
          info: "Count of creators on a MULTIPLIER deal (their wagering is boosted by a payout multiplier). Switch the tab to see fill-deal creators instead.",
        }
      : {
          label: "Fill Creators",
          icon: Coins,
          tint: "pink" as const,
          sub: "Creators with a fill deal",
          info: "Count of creators on a FILL deal (we give them system/fake balance to gamble with on stream). Switch the tab to see multiplier-deal creators instead.",
        };

  return (
    <div className="grid grid-cols-1 items-stretch gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-4 xl:grid-cols-6">
      {/* Swap tile — flips between Fill and Multiplier counts based on
          the active tab. Replaces the previous Fill + Multiplier pair
          of tiles (one of which always rendered "—" on the inactive
          tab and was confusing). */}
      <CreatorsKpiPanel
        title={tabTile.label}
        icon={tabTile.icon}
        tint={tabTile.tint}
        titleAdornment={<InfoHint text={tabTile.info} />}
        headerRight={tabCountBackendDown ? <BackendUnavailableHint /> : undefined}
      >
        <CreatorsPlainHero value={tabCount ?? null} format="number" />
        <CreatorsPanelSub>{tabTile.sub}</CreatorsPanelSub>
      </CreatorsKpiPanel>
      {/* Net Code-User GGR — roster-wide windowed code-user GGR summed
          across every attributed creator (`getAllCreatorsNetGgr.totalGgr`)
          over the active `?period=` window. House-POV: positive = the
          cohorts net-lost to us (house win → emerald), negative = we
          net-paid them out (house loss → rose). GGR-side only — the full
          Net PnL (GGR − cost) lives per-creator on /creators/[id].
          Streamed via its own Suspense keyed on `period` so flipping the
          window repaints just this tile, and the same `cache()`d query
          backs the per-row GGR below (one ledger scan per window). */}
      <Suspense
        key={`ggr-${period}`}
        fallback={<NetGgrTileSkeleton />}
      >
        <NetGgrTile period={period} />
      </Suspense>
      {/* Global PnL — coverage-aware aggregate, tab-scoped to the
          creators in the active program (Fill vs Multiplier). Streamed
          via its own Suspense (keyed on `tab` so flipping tabs paints
          the skeleton instead of freezing on the stale figure) to keep
          this strip paintable as soon as the cheap stats land. Drill-in
          popover lives in the tile's top-right action slot — opens on
          hover, sorted ascending by pnl so the worst creator surfaces
          first. */}
      <Suspense key={`pnl-${tab}`} fallback={<GlobalPnlTileSkeleton tab={tab} />}>
        <GlobalPnlTile tab={tab} />
      </Suspense>
      {/* Converted — combined value of the end-of-session payout
          vouchers (`creator_fill_conversion`) MINTED across EVERY creator
          ever (LIFETIME, no active/scheduled-deal filter): how much stream
          earnings have ever been converted into payout vouchers. Sourced
          from the Main-DB vouchers table (the real minted amount), NOT the
          backend deal's withdraw-cap counter. Neutral (blue) accent — it's
          a throughput figure, not a house-POV gain/loss direction.

          Sub-line shows of that converted total, how much has actually
          walked out via a completed withdraw request (+ in-flight
          pending/processing/shipped when non-zero) — the SAME voucher
          set + same lifetime/all-creators scope, so withdrawn ≤ converted.
          Falls back to the static "Converted to payout vouchers" label
          when stats failed to load. */}
      <CreatorsKpiPanel
        title="Converted"
        icon={Wallet}
        tint="blue"
        titleAdornment={
          <InfoHint text="Lifetime stream earnings minted into end-of-session payout vouchers (creator_fill_conversion) across ALL creators — not just live-deal creators. The breakdown shows how much of that has actually been withdrawn off-platform vs still in flight." />
        }
        headerRight={statsBackendDown ? <BackendUnavailableHint /> : undefined}
      >
        <CreatorsPlainHero
          value={stats ? stats.convertedTotal : null}
          format="currency"
        />
        <CreatorsPanelSub>Converted to payout vouchers</CreatorsPanelSub>
        {/* Of that converted total: how much has actually walked out via a
            completed withdraw request, + in-flight (pending/processing/
            shipped) when non-zero. Same voucher set + lifetime/all-creators
            scope, so withdrawn ≤ converted. Withdrawn = money off-platform
            → house cost → rose. */}
        {stats && (
          <div
            className={cn(
              "grid gap-1.5 -mx-0.5",
              stats.withdrawPendingFromConvertedTotal > 0
                ? "grid-cols-2"
                : "grid-cols-1",
            )}
          >
            <CreatorsPanelChip
              label="Withdrawn"
              value={stats.withdrawnFromConvertedTotal}
              tone="rose"
            />
            {stats.withdrawPendingFromConvertedTotal > 0 && (
              <CreatorsPanelChip
                label="In flight"
                value={stats.withdrawPendingFromConvertedTotal}
                tone="rose"
              />
            )}
          </div>
        )}
      </CreatorsKpiPanel>
      {/* Leaderboard Spend — a dashboard-style panel (same shell as the
          other KPI boxes). Splits creator-leaderboard house cost by time:
          the rose HERO is what we're committed to on the boards running
          RIGHT NOW (+ "· N active · X% we pay" — the active board count
          and the blended house share we cover), and a "Past" chip is what
          we already spent on finished boards. Net of refunds, each board
          weighted by its admin-set house share % (set inline on
          /creators/leaderboards; defaults to 100%). The past/active split
          is derived from the SAME approved-board walk as the totals — no
          extra query. */}
      <LeaderboardSpendPanel
        activeHouseCostUsd={leaderboardCost?.activeHouseCostUsd ?? null}
        activeCoveragePct={leaderboardCost?.activeCoveragePct ?? null}
        activeCount={leaderboardCost?.activeCount ?? null}
        pastHouseCostUsd={leaderboardCost?.pastHouseCostUsd ?? null}
        pastCount={leaderboardCost?.pastCount ?? null}
        backendUnavailable={leaderboardBackendDown}
      />
      {/* Tips & Sponsor Spend — a dashboard-style panel (same shell as
          every other box in the strip). The lifetime house cost of the
          creator-funded tips/sponsor pool, with its tip + battle-sponsorship
          legs as a chip row (§3 of the creator model). House-POV:
          house-funded → house cost → rose. Reads $0 until the fill system is
          live (the underlying query is enum-safe). */}
      <TipsSponsorSpendPanel
        tipSpendUsd={tipsSponsorSpend?.tipSpendUsd ?? null}
        sponsorSpendUsd={tipsSponsorSpend?.sponsorSpendUsd ?? null}
        totalUsd={tipsSponsorSpend?.totalUsd ?? null}
      />
    </div>
  );
}

// ─── Card grid section ────────────────────────────────────────────
//
// Async server component — owns the (heavy) full-pool walk + per-row
// enrichment fetches. Wrapped in Suspense by the page so tab switches
// show a skeleton instead of freezing on the stale grid.

async function CreatorsGridSection({
  params,
}: {
  params: CreatorsSearchParams;
}) {
  // Best-effort enrichment fan-outs — a single fetch blowing up
  // shouldn't sink the whole page, so each result has a sensible
  // empty fallback.
  let result: CreatorsListPage | null = null;
  let socialsByUser: Map<string, CreatorSocialSummary[]> = new Map();
  let codeAndWagerByUser: Map<string, CreatorCodeAndWager> = new Map();
  // Kicked off the moment the roster resolves so it overlaps the active-
  // tab deal-cost fan-out below (one fewer wave); awaited inside that
  // fan-out for active tabs, and separately for the Past tab.
  let codeAndWagerPromise: Promise<Map<string, CreatorCodeAndWager>> | null =
    null;
  // Windowed code-user GGR per creator over the active `?period=` window,
  // keyed on `creatorUserId`. GGR-side ONLY — the full Net PnL (GGR −
  // cost) is a per-creator backend round-trip that lives on the detail
  // page, intentionally NOT batched for the whole list. Best-effort: a
  // failure leaves the map empty and the rows render GGR as "—".
  let ggrByUser = new Map<string, number>();
  let loadError: { title: string; detail: string } | null = null;
  // Past Creators tab — canceled / ex-creators. This pool comes from the
  // DB (`getExCreatorsList`), NOT the live backend roster (which only
  // returns current creators). The windowed code-user GGR is
  // creator-gated (`getAllCreatorsNetGgr` resolves only `role='creator'`
  // ids), so it's deliberately NOT fetched here — fetching a heavy ledger
  // scan that drops every ex-creator would be pure waste AND violate the
  // active-timeframe rule. Ex-creators render GGR as "—"; their full
  // historical Net PnL lives on the detail page /creators/[id]. All the
  // OTHER columns (code, lifetime wager volume, signups, FTDs, momentum)
  // come from `getCodeAndWagerByUser`, which is role-agnostic, so the
  // owner still sees the complete historical economics on the row.
  const isPast = params.tab === "past";

  try {
    // Wave 1 — socials + (active tabs only) the roster-wide windowed GGR
    // (one cached pass for EVERY creator over the active window). The GGR
    // map feeds BOTH the per-row merge below AND the global `ggr_*`
    // ordering of the list. `getAllCreatorsNetGgr` is `cache()`d, so the
    // strip's GGR tile and this consult resolve to a single ledger pass
    // per window. On the Past tab the GGR pass is skipped (see above).
    const [socialsResult, ggr] = await Promise.all([
      // Socials — BACKEND read (creatorsApi.listSocials). safeQuery +
      // timeout so an unreachable backend degrades to an empty map (cards
      // render without social handles) instead of throwing into the
      // catch below and blanking the whole grid.
      safeQuery(
        () => getApprovedSocialsByUser(),
        new Map<string, CreatorSocialSummary[]>(),
        "creators.socials",
        BACKEND_READ_TIMEOUT_MS,
      ),
      // Windowed code-user GGR — Main-DB ledger scan (NOT a backend read).
      // Best-effort: a failure leaves the map empty and rows render "—".
      isPast
        ? Promise.resolve(null)
        : getAllCreatorsNetGgr(params.period).catch((e) => {
            console.error(
              "[creators] windowed GGR fetch failed (rows render '—'):",
              e,
            );
            return null;
          }),
    ]);
    socialsByUser = socialsResult.data;
    if (ggr) {
      ggrByUser = new Map(
        ggr.byCreator.map((r) => [r.creatorUserId, r.ggr]),
      );
    }

    // The list fetch diverges by mode:
    //   1. Past tab → DB-sourced ex-creator set (`getExCreatorsList`),
    //      paginated in memory. Search is applied inside the query.
    //   2. KPI-tile filter is active (?filter=live / ?filter=active-
    //      deals) → walk the whole creator pool and narrow in memory
    //      via `listCreatorsFiltered`. Pagination collapses in this
    //      mode (the filtered set fits on one screen), so the page's
    //      in-memory `.sort()` orders the whole filtered set by GGR/FTD.
    //   3. No filter → tab-aware fetch (`getCreatorsListForTab`). The
    //      GGR map is passed through so the `ggr_*` sorts order the
    //      WHOLE tab pool before pagination.
    // The active-tab paths (filter / default) walk the BACKEND creator
    // roster; the Past tab is DB-sourced. Bound the whole fetch with a
    // wall-clock timeout (withTimeout) so a hung backend roster walk rejects
    // into the catch below — which renders the "can't reach backend" card +
    // an empty grid (requirement: keep the page shell + DB tiles up even when
    // the roster is unavailable) — instead of pinning the Server Component.
    result = await withTimeout(
      () =>
        isPast
          ? getExCreatorsList(params)
          : params.filter
            ? listCreatorsFiltered(params.filter, params.search)
            : // Render the ENTIRE tab pool on one page (page 1, capped at the
              // 100-creator schema max — the same FETCH_CAP-bounded full walk
              // this query already does) so the instant client-side search
              // (CreatorsSearchInput → CreatorsViewRender) filters across every
              // creator, not just the current page's slice. Pagination is
              // hidden on this path (see the <DataTablePagination/> guard).
              getCreatorsListForTab(
                { ...params, page: 1, perPage: 100 },
                params.tab,
                ggrByUser,
              ),
      BACKEND_READ_TIMEOUT_MS,
    );

    // Kick off code+wager enrichment for the resolved roster WITHOUT
    // awaiting it here — it depends only on `result`, so starting it now
    // lets it run concurrently with the active-tab deal-cost fan-out below
    // (collapsing a wave). It must run for ALL tabs (past + active), so
    // active tabs await it inside the Promise.all and the Past tab awaits
    // it separately. The best-effort fallback is unchanged.
    codeAndWagerPromise = getCodeAndWagerByUser(
      result.data.map((c) => c.id),
    ).catch((e) => {
      console.error(
        "[creators] code+wager fetch failed (rendering without):",
        e,
      );
      return new Map<string, CreatorCodeAndWager>();
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isQueryTimeoutError(err)) {
      loadError = {
        title: "Backend timed out",
        detail:
          "The packy.gg backend didn't respond in time, so the creator roster couldn't load. The database-sourced figures above are still accurate. Reload once the backend is responsive.",
      };
    } else if (err instanceof BackendNetworkError) {
      loadError = {
        title: networkErrorTitle(err.causeCode),
        detail: networkErrorDetail(err),
      };
    } else if (err instanceof BackendApiError) {
      loadError = {
        title: `Backend rejected the request (HTTP ${err.status})`,
        detail: message,
      };
    } else if (
      err instanceof Error &&
      (err.name === "MissingBackendApiConfigError" ||
        /Missing (backend API URL|admin API key)/i.test(message))
    ) {
      loadError = {
        title: "Backend API is not configured",
        detail:
          "Set BACKEND_API_URL_PROD + BACKEND_ADMIN_KEY_PROD on Vercel (or the matching DEV vars) and redeploy. The creators page reads its data from the packy.gg backend.",
      };
    } else {
      loadError = {
        title: "Could not load creators",
        detail: message,
      };
    }
    console.error("[creators] listCreatorsForPage failed:", err);
  }

  // Per-card deal cap info — resolved from the backend deal of each
  // visible creator's active/scheduled deal. The lite `current_deal`
  // doesn't carry the cap fields, so we resolve each deal by id.
  let dealCapByUser = new Map<string, DealCapInfo>();
  let withdrawnFromConvertedByUser = new Map<string, WithdrawnFromConverted>();
  let leaderboard2wkByUser = new Map<string, Lb2wkInfo>();
  // Skipped on the Past tab: ex-creators have no active/scheduled deal
  // (so the cap + withdrawn fan-outs would resolve to nothing) and the
  // forward-looking 2-week leaderboard projection is an active-creator
  // figure. Leaving the maps empty renders the deal-cost chips/rows as
  // "—", which is correct for a canceled creator.
  if (result && !isPast) {
    const pageActiveDeals = result.data
      .filter(
        (c) =>
          c.current_deal != null &&
          (c.current_deal.status === "active" ||
            c.current_deal.status === "scheduled"),
      )
      .map((c) => ({ userId: c.id, dealId: c.current_deal!.id }));
    const [capInfoResult, withdrawn, lb2wkResult, codeAndWager] =
      await Promise.all([
        // Deal cap — BACKEND read (creatorsApi.getDeal per active deal, already
        // allSettled internally). safeQuery + timeout so a dead/slow backend
        // degrades to an empty map (cards render the cap chips as "—") instead
        // of hanging this segment.
        safeQuery(
          () => getDealCapInfoByUser(pageActiveDeals),
          new Map<string, DealCapInfo>(),
          "creators.deal-cap",
          BACKEND_READ_TIMEOUT_MS,
        ),
        // Withdrawn-from-converted — Main-DB query (NOT a backend read).
        // Best-effort: a failure hides the sub-line.
        getWithdrawnFromConvertedByDeal(pageActiveDeals).catch((e) => {
          console.error(
            "[creators] withdrawn-from-converted fetch failed (sub-line hidden):",
            e,
          );
          return new Map<string, WithdrawnFromConverted>();
        }),
        // Leaderboard 2-week cost — BACKEND read (affiliateLeaderboardsApi).
        // safeQuery + timeout so a dead/slow backend degrades to an empty map
        // (cards render the leaderboard cost as "—") instead of hanging.
        safeQuery(
          () => getLeaderboard2wkCostByUser(),
          new Map<string, Lb2wkInfo>(),
          "creators.leaderboard-2wk",
          BACKEND_READ_TIMEOUT_MS,
        ),
        // Code + wager enrichment — kicked off above the moment `result`
        // resolved; folded into this fan-out so it runs concurrently with
        // the deal-cost reads instead of in its own preceding wave. Its
        // best-effort fallback is already attached at the kickoff site; a
        // null promise (shouldn't happen here — result exists) degrades to
        // an empty map.
        codeAndWagerPromise ??
          Promise.resolve(new Map<string, CreatorCodeAndWager>()),
      ]);
    dealCapByUser = capInfoResult.data;
    withdrawnFromConvertedByUser = withdrawn;
    leaderboard2wkByUser = lb2wkResult.data;
    codeAndWagerByUser = codeAndWager;
  }

  // Past tab has no active-deal fan-out to ride along, so resolve the
  // code+wager enrichment (kicked off above) on its own here. Active tabs
  // already resolved it inside the Promise.all. A null promise (the roster
  // failed to load) leaves the default empty map.
  if (isPast && codeAndWagerPromise) {
    codeAndWagerByUser = await codeAndWagerPromise;
  }

  // Enriched + ordered creator rows — identical data for both render
  // modes; only the presentation (cards vs compact rows) differs, and
  // that choice is pure client state (CreatorsViewRender), so this
  // server component fetches once regardless of view.
  //
  // Final in-memory ordering by `sortBy`:
  //   • recent   — active/scheduled-deal creators pinned to the top of
  //                the page (the backend walk order otherwise).
  //   • ggr_*    — by the windowed code-user GGR merged on above. For
  //                the unfiltered tab path this is already GLOBAL (the
  //                pool was ordered by the cached GGR map before
  //                pagination in `getCreatorsListForTab`); this pass
  //                re-applies the same comparator so the filtered path
  //                (a single collapsed page) is ordered too, and the
  //                two paths share one rule. A creator with no
  //                attributed activity sorts as 0.
  //   • ftd_*    — by the lifetime first-time-depositor count. This is
  //                a PAGE-LOCAL sort (the current page's rows only): a
  //                roster-wide FTD ranking would need a full-pool FTD
  //                fan-out, the expensive walk the active-timeframe rule
  //                forbids eager-loading. GGR is the globally-rankable
  //                economic sort; FTD re-orders what's on the page.
  const creators = (result?.data ?? [])
    .map<CreatorWithSocials>((c) => {
      const cw = codeAndWagerByUser.get(c.id);
      return {
        ...c,
        socials: socialsByUser.get(c.id) ?? [],
        code: cw?.code ?? null,
        wagerVolumeUsd: cw?.wagerVolumeUsd ?? 0,
        signups: cw?.signups ?? 0,
        ftds: cw?.ftds ?? 0,
        deposits3dUsd: cw?.deposits3dUsd ?? 0,
        wagers3dUsd: cw?.wagers3dUsd ?? 0,
        convertedUsd: dealCapByUser.get(c.id)?.usedUsd ?? null,
        withdrawnFromConverted:
          withdrawnFromConvertedByUser.get(c.id) ?? null,
        deal2wkMaxUsd: dealCapByUser.get(c.id)?.totalCapUsd ?? null,
        leaderboard2wkMaxUsd:
          leaderboard2wkByUser.get(c.id)?.costUsd ?? null,
        withdrawalCapUsd: dealCapByUser.get(c.id)?.totalCapUsd ?? null,
        leaderboardSponsoredPct:
          leaderboard2wkByUser.get(c.id)?.effectivePct ?? null,
        // null when the creator has no attributed activity in the window
        // (absent from the batch GGR result) → the row shows "—". Always
        // null on the Past tab (GGR is creator-gated; the ggrByUser map is
        // empty there).
        windowedGgrUsd: ggrByUser.has(c.id) ? ggrByUser.get(c.id)! : null,
        // Marks the row as a canceled / ex-creator → renders the purple
        // "Ex-creator" badge. Only set on the Past Creators tab.
        isPastCreator: isPast,
      };
    })
    .sort((a, b) => {
      switch (params.sortBy) {
        case "ggr_desc":
          return (b.windowedGgrUsd ?? 0) - (a.windowedGgrUsd ?? 0);
        case "ggr_asc":
          return (a.windowedGgrUsd ?? 0) - (b.windowedGgrUsd ?? 0);
        case "ftd_desc":
          return b.ftds - a.ftds;
        case "ftd_asc":
          return a.ftds - b.ftds;
        case "recent":
        default: {
          // Pin active/scheduled-deal creators to the top of the page.
          const aActive =
            a.current_deal?.status === "active" ||
            a.current_deal?.status === "scheduled"
              ? 1
              : 0;
          const bActive =
            b.current_deal?.status === "active" ||
            b.current_deal?.status === "scheduled"
              ? 1
              : 0;
          return bActive - aActive;
        }
      }
    });

  return (
    <>
      {loadError && (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/5 p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-rose-500" />
            <div className="space-y-1">
              <p className="text-sm font-semibold text-rose-500 dark:text-rose-400">
                {loadError.title}
              </p>
              <p className="text-xs text-muted-foreground">
                {loadError.detail}
              </p>
            </div>
          </div>
        </div>
      )}
      {/* Grid / List render mode is client state — same `creators` data
          either way, switched in place with no refetch. */}
      <CreatorsViewRender creators={creators} />
      {/* Pagination is now hidden on the default (unfiltered) path too:
          that path renders the WHOLE tab pool on a single page
          (`perPage: 100` above) so the instant client-side search can
          filter every creator, which makes server pagination meaningless
          here — it would only ever show "1 of 1". The tile-filter path
          (`params.filter`) was already single-page via
          `listCreatorsFiltered`, and the Past tab is the only other path,
          which also fits one screen. So pagination is disabled across the
          board. The original `result && !params.filter` guard is kept so
          the bound `result` shape stays documented (and TS keeps narrowing
          `result` to non-null) in case a future paginated path wants it
          back; `SHOW_PAGINATION` (a runtime-false flag, typed `boolean` so
          the compiler can't dead-code-eliminate the branch and lose that
          narrowing) gates the actual render off. */}
      {SHOW_PAGINATION && result && !params.filter && (
        <DataTablePagination
          page={result.page}
          totalPages={result.totalPages}
          total={result.total}
          perPage={result.perPage}
        />
      )}
    </>
  );
}

// ─── Skeletons ────────────────────────────────────────────────────

/**
 * KPI-strip skeleton — mirrors the active-tab strip layout: 6 uniform
 * panel-shaped boxes (the 4 figure panels + the Leaderboard Spend and
 * Tips & Sponsor Spend panels) on the same responsive grid (1-up on
 * phones, 2 at sm, 4 at lg, 6 at xl). Shape matches the real `Card`
 * panels (tinted bg, header row, hero + sub) so there's no layout jank
 * when the data lands.
 */
function CreatorsKpiStripSkeleton() {
  return (
    <div className="grid grid-cols-1 items-stretch gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-4 xl:grid-cols-6">
      {Array.from({ length: 6 }).map((_, i) => (
        <Card key={i} className="bg-card">
          <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
            <Skeleton className="h-3.5 w-20" />
            <Skeleton className="size-4 rounded" />
          </CardHeader>
          <CardContent className="space-y-3">
            <Skeleton className="h-7 w-24" />
            <Skeleton className="h-3 w-28" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

/**
 * Grid skeleton + pagination — shown only while the server re-fetches a
 * new data set (tab / search / sort / page change), not on a view
 * toggle (that's a client re-render of the same data). Always renders
 * the card-grid variant: the server has no `view` knowledge anymore and
 * first paint defaults to grid, so the grid skeleton matches the initial
 * render. 6 card blocks (1 / 2 / 3 cols).
 */
function CreatorsGridSkeleton() {
  return (
    <>
      <div className="grid gap-3 grid-cols-1 sm:gap-4 md:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-64 rounded-2xl" />
        ))}
      </div>
      <div className="flex items-center justify-between flex-wrap gap-2">
        <Skeleton className="h-4 w-48" />
        <div className="flex items-center gap-2">
          <Skeleton className="h-8 w-8 rounded-md" />
          <Skeleton className="h-8 w-8 rounded-md" />
          <Skeleton className="h-8 w-20 rounded-md" />
          <Skeleton className="h-8 w-8 rounded-md" />
          <Skeleton className="h-8 w-8 rounded-md" />
        </div>
      </div>
    </>
  );
}

// ─── Helpers — keep error-state copy near the page that uses it ───

/**
 * Map a fetch-failure cause code to a human-readable headline. Covers
 * the common Node fetch failure modes — anything we don't recognize
 * falls back to a generic "unreachable" headline.
 */
function networkErrorTitle(code: string | null): string {
  switch (code) {
    case "ENOTFOUND":
      return "Backend host not found (DNS failure)";
    case "ECONNREFUSED":
      return "Backend refused the connection";
    case "ECONNRESET":
      return "Backend dropped the connection";
    case "ETIMEDOUT":
      return "Backend connection timed out";
    case "EAI_AGAIN":
      return "Temporary DNS resolution failure";
    case "CERT_HAS_EXPIRED":
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
    case "SELF_SIGNED_CERT_IN_CHAIN":
      return "Backend TLS certificate is invalid";
    default:
      return "Backend unreachable";
  }
}

function networkErrorDetail(err: BackendNetworkError): string {
  const cause = err.causeCode
    ? `${err.causeCode}${err.causeMessage ? ` — ${err.causeMessage}` : ""}`
    : (err.causeMessage ?? "fetch failed");
  let hint = "";
  switch (err.causeCode) {
    case "ENOTFOUND":
      hint =
        " Check BACKEND_API_URL_PROD on Vercel — typo in the hostname, or the DNS record is gone.";
      break;
    case "ECONNREFUSED":
      hint =
        " Backend is not listening on that host:port. Check the URL's port + that the service is running.";
      break;
    case "ETIMEDOUT":
      hint =
        " A firewall is dropping the connection silently. Cloudflare Access? IP allowlist? Vercel egress region?";
      break;
    case "ECONNRESET":
      hint =
        " The TCP socket got closed mid-handshake. Often a TLS / load-balancer mismatch on the backend.";
      break;
    case "CERT_HAS_EXPIRED":
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
      hint = " Renew the cert on the backend or add the CA to NODE_EXTRA_CA_CERTS.";
      break;
  }
  return `URL: ${err.url} · ${cause}.${hint}`;
}

// ─── Global PnL tile (streamed via Suspense) ──────────────────────
//
// The ledger+coverage reconstruction does a sort-merge join across all
// completed deposits — heaviest query on this page. Rendered as its
// own server component + Suspense fallback so it doesn't block the
// rest of the strip + the cards from painting immediately.
//
// Tab-scoped: the aggregate is filtered to creators in the active tab
// (Fill / Multiplier) so the figure matches the swap-tile count on the
// same row. The label flips with the tab — "Fill-Segment Net" vs
// "Multiplier-Segment Net" — so the scope reads at a glance.
//
// NOTE: this is the combined DEPOSITS − CASH-OUT figure across the
// segment's code cohorts (House POV) — a different lens than the
// per-creator "Net Creator PnL" (GGR − creator cost) on /creators/[id].
// The label + the InfoHint below spell that out so the two never get
// conflated (the owner explicitly couldn't tell what "Fill creator PnL"
// meant).
//
// Best-effort: a query failure renders the tile in its empty state
// rather than crashing the page.

function pnlTileLabel(tab: CreatorsTab): string {
  return tab === "multiplier"
    ? "Multiplier-Segment Net"
    : "Fill-Segment Net";
}

function pnlTileSub(tab: CreatorsTab): string {
  return tab === "multiplier"
    ? "Multiplier creators · deposits − cash-out · lifetime"
    : "Fill creators · deposits − cash-out · lifetime";
}

function pnlTileInfo(tab: CreatorsTab): string {
  const segment = tab === "multiplier" ? "multiplier-deal" : "fill-deal";
  return `Combined lifetime House P&L across every ${segment} creator's code cohort: total deposits from their referred players minus what those players cashed out (physical cards + session vouchers). House POV — emerald = up, rose = down. This is the deposits-vs-cash-out lens, NOT the GGR-minus-cost "Net Creator PnL" on a creator's detail page.`;
}

async function GlobalPnlTile({ tab }: { tab: CreatorsTab }) {
  // safeQueryOrNull (not a bare `.catch`) so this tile degrades on BOTH a
  // THROW and a HANG. `getAllCreatorsLifetimePnl` is mostly Main-DB, but it
  // first resolves the tab's creator-id set via the BACKEND
  // (getFillCreatorIds / getMultiplierCreatorIds). Those swallow a backend
  // REJECT internally (→ null), but a `.catch()` can't rescue a backend that
  // accepts the socket and never replies — the call would pin this streamed
  // Server Component until the platform kills the whole request (the page's
  // already-degraded shell included). The wall-clock timeout caps that wait
  // so the tile drops to "—" instead, matching every other read on the page.
  const { data: lifetimePnl } = await safeQueryOrNull(
    () => getAllCreatorsLifetimePnl(tab),
    "creators.global-lifetime-pnl",
    HEAVY_ATTRIBUTION_TILE_TIMEOUT_MS,
  );

  const pnl = lifetimePnl?.pnl;
  const byCreator = lifetimePnl?.byCreator ?? [];
  // House-POV signed hero (emerald = up / rose = down) when there's a
  // figure; a null pnl renders the neutral dashed placeholder. The panel's
  // icon tint stays blue (identity), matching the dashboard's approach of
  // tinting the panel by identity and the NUMBER by house-POV.

  return (
    <CreatorsKpiPanel
      title={pnlTileLabel(tab)}
      icon={LineChart}
      tint="blue"
      titleAdornment={<InfoHint text={pnlTileInfo(tab)} side="bottom" />}
      headerRight={
        byCreator.length > 0 ? (
          <GlobalPnlByCreatorPopover creators={byCreator} />
        ) : undefined
      }
    >
      <CreatorsSignedHero value={pnl ?? null} />
      <CreatorsPanelSub>{pnlTileSub(tab)}</CreatorsPanelSub>
    </CreatorsKpiPanel>
  );
}

function GlobalPnlTileSkeleton({ tab }: { tab: CreatorsTab }) {
  return (
    <Card className="bg-blue-500/10">
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
        <span className="text-card-title min-w-0 truncate text-muted-foreground">
          {pnlTileLabel(tab)}
        </span>
        <LineChart className="size-4 shrink-0 text-blue-400" />
      </CardHeader>
      <CardContent className="space-y-3">
        <Skeleton className="h-7 w-28" />
        <Skeleton className="h-3 w-40" />
      </CardContent>
    </Card>
  );
}

// ─── Net Code-User GGR tile (streamed via Suspense) ───────────────
//
// Roster-wide windowed code-user GGR — Σ ggr across every attributed
// creator over the active `?period=` window
// (`getAllCreatorsNetGgr().totalGgr`). House-POV: positive = the cohorts
// net-lost to us (house win → emerald), negative = we net-paid them out
// (house loss → rose), zero/null → neutral blue. GGR-side ONLY; the
// per-creator full Net PnL (GGR − cost) lives on /creators/[id].
//
// Backed by the SAME `cache()`d query the grid section consults for the
// per-row GGR merge, so the 3 ledger scans run once per window. Best-
// effort: a query failure renders "—" rather than crashing the strip.

async function NetGgrTile({
  period,
}: {
  period: CreatorsSearchParams["period"];
}) {
  // safeQueryOrNull (not a bare `.catch`) + wall-clock timeout: this is the
  // heaviest read on the page (three correlated-subquery ledger scans), and
  // CLAUDE.md requires heavy queries to run through the timeout wrapper so a
  // pathological scan degrades to a fallback tile instead of pinning this
  // streamed Server Component until the platform kills the whole request. On
  // a throw OR a timeout `data` is null → the tile renders "—", identical to
  // the prior `.catch(() => null)` degraded state.
  const { data } = await safeQueryOrNull(
    () => getAllCreatorsNetGgr(period),
    "creators.roster-net-ggr",
    HEAVY_ATTRIBUTION_TILE_TIMEOUT_MS,
  );

  const total = data?.totalGgr;
  const legs = data?.legs;
  // Only surface the drill-in list-down when there's attributed activity
  // in the window (a leg with a non-zero total) — otherwise the popover
  // would just say "no activity" everywhere.
  const hasLegs =
    legs != null && (legs.wagersTotal > 0 || legs.payoutsTotal > 0);

  return (
    <CreatorsKpiPanel
      title="Net Code-User GGR"
      icon={Sparkles}
      tint="cyan"
      titleAdornment={
        <InfoHint
          text="Gross gaming revenue (wager − payout) from every creator's code cohort, summed over the selected window. Counted only while each code was active (its 7-day attribution windows). House POV — emerald = players net-lost to us, rose = we net-paid them out."
          side="bottom"
        />
      }
      headerRight={
        /* Dashboard-style GGR list-down — decomposes the cohort GGR into
           its wager / payout legs (packs & battles + upgrader), mirroring
           the GGR breakdown popover on /dashboard. The legs reconcile to
           the tile's headline by construction. */
        hasLegs ? (
          <NetGgrBreakdownPopover
            packBattleWager={legs.packBattleWager}
            upgraderWager={legs.upgraderWager}
            inventoryPayout={legs.inventoryPayout}
            battleRefundLedger={legs.battleRefundLedger}
            upgraderPayout={legs.upgraderPayout}
            wagersTotal={legs.wagersTotal}
            payoutsTotal={legs.payoutsTotal}
            ggr={total ?? 0}
            periodLabel={DASHBOARD_PERIOD_LABELS[period]}
          />
        ) : undefined
      }
    >
      <CreatorsSignedHero value={total ?? null} />
      <CreatorsPanelSub>
        All creators · {DASHBOARD_PERIOD_LABELS[period].toLowerCase()}
      </CreatorsPanelSub>
    </CreatorsKpiPanel>
  );
}

function NetGgrTileSkeleton() {
  return (
    <Card className="bg-cyan-500/10">
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
        <span className="text-card-title min-w-0 truncate text-muted-foreground">
          Net Code-User GGR
        </span>
        <Sparkles className="size-4 shrink-0 text-cyan-400" />
      </CardHeader>
      <CardContent className="space-y-3">
        <Skeleton className="h-7 w-28" />
        <Skeleton className="h-3 w-40" />
      </CardContent>
    </Card>
  );
}
