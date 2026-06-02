import Link from "next/link";
import { Suspense } from "react";
import {
  AlertTriangle,
  CalendarCheck,
  Coins,
  LineChart,
  Megaphone,
  Radio,
  Sparkles,
  Trophy,
  Users,
  UserX,
  Wallet,
  Zap,
} from "lucide-react";

import { requirePageAccess } from "@/lib/dal";
import { FadeIn } from "@/components/fade-in";
import { Skeleton } from "@/components/ui/skeleton";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { KpiStripSkeleton } from "@/components/loading-skeletons";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import { BackendApiError, BackendNetworkError } from "@/lib/backend-api";
import {
  PageHero,
  PageHeroIdentity,
  KpiTile,
  SectionHeading,
} from "@/components/modern-panels";

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
import { type CreatorWithSocials } from "./_components/creator-card-grid";
import { AddCreatorDialog } from "./_components/add-creator-dialog";
import { CreatorsTabSwitch } from "./_components/creators-tab-switch";
import { CreatorsViewToggle } from "./_components/creators-view-toggle";
import { CreatorsViewProvider } from "./_components/creators-view-context";
import { CreatorsViewRender } from "./_components/creators-view-render";
import {
  CreatorsSortControl,
  CreatorsPeriodControl,
} from "./_components/creators-sort-control";
import { GlobalPnlByCreatorPopover } from "./_components/global-pnl-by-creator-popover";
import { InfoHint } from "./_components/info-hint";
import { getAllCreatorsLifetimePnl } from "./_queries/all-creators-lifetime-pnl";
import { getAllCreatorsNetGgr } from "./_queries/all-creators-net-pnl";
import { DASHBOARD_PERIOD_LABELS } from "@/lib/queries/dashboard-period";

export const metadata = { title: "Creators" };

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
          action={<AddCreatorDialog />}
        />
      </PageHero>

      {/* KPI strip — Suspense boundary keyed on `tab` so flipping
          Fill / Multiplier swaps the strip to a skeleton instead of
          freezing the page on stale numbers. The single tab-aware
          tile inside (Fill Creators / Multiplier Creators) flips
          label, value, and icon from the active tab's cached count.
          Active Deals + Live Now tiles are clickable filter toggles
          — clicking one sets `?filter=<target>` and the page
          re-renders the matching subset via `listCreatorsFiltered`. */}
      <Suspense
        key={`kpi-${params.tab}-${params.filter ?? ""}`}
        fallback={<KpiStripSkeleton count={7} />}
      >
        <CreatorsKpiStrip
          tab={params.tab}
          filter={params.filter}
          search={params.search}
          period={params.period}
        />
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
        {/* The Grid / List view is pure client state (CreatorsViewProvider)
            — NOT a URL param — so flipping it re-renders the SAME fetched
            data in place with no navigation, no refetch, and no skeleton.
            The provider wraps BOTH the toggle (in the toolbar) and the
            renderer (inside the Suspense boundary) so they share one
            state; the toggle keeps rendering during data refetches. */}
        <CreatorsViewProvider>
          <FadeIn className="space-y-4">
            {/* Toolbar is OUTSIDE the Suspense boundary so the search +
                tab switch + view toggle stay responsive while the rows
                stream in. Tab switch (leading) hides while a filter is
                active — the filter overrides the Fill / Multiplier view.
                The Grid / List view toggle (trailing `children`) flips
                the render mode via client state — no refetch. */}
            <DataTableToolbar
              searchPlaceholder="Search by username or email..."
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
                `tab` + `search` + `page` + `sortBy` + `filter` so any
                navigation that swaps the underlying data set shows the
                skeleton instead of leaving the stale grid blocking.
                `view` is intentionally NOT in the key (and not read
                server-side) — switching it is a client re-render of the
                same data, so it must not throw a fresh boundary / refetch.
                `key=` forces React to throw the fresh boundary on every
                data-changing navigation. */}
            <Suspense
              key={`grid-${params.tab}-${params.search ?? ""}-${params.page}-${params.sortBy}-${params.perPage}-${params.filter ?? ""}-${params.period}`}
              fallback={<CreatorsGridSkeleton />}
            >
              <CreatorsGridSection params={params} />
            </Suspense>
          </FadeIn>
        </CreatorsViewProvider>
      </div>
    </div>
  );
}

// ─── KPI strip ────────────────────────────────────────────────────
//
// Tab-aware: ONE swap tile (Fill Creators / Multiplier Creators) — its
// value, label, and icon flip from the cached per-tab count. Other
// tiles (Global PnL, Converted, Leaderboard Cost, Active Deals, Live
// Now) stay tab-independent. Total = 6 tiles.
//
// Active Deals + Live Now double as filter toggles — clicking one
// sets `?filter=live` / `?filter=active-deals` and the grid below
// re-renders the matching subset. Clicking the active tile clears
// the filter. The active tile gets a colored ring matching its accent
// so the filter state reads at a glance.

async function CreatorsKpiStrip({
  tab,
  filter,
  search,
  period,
}: {
  tab: CreatorsTab;
  filter: CreatorsSearchParams["filter"];
  search: string | undefined;
  period: CreatorsSearchParams["period"];
}) {
  // Past Creators tab — every other tile in the strip (Net GGR, Global
  // PnL, Converted, Leaderboard Cost, Active Deals, Live Now) is an
  // ACTIVE-roster figure that would be misleading next to a list of
  // canceled creators, and the GGR/PnL aggregates are creator-gated
  // (ex-creators don't appear in them). So the Past tab renders a single
  // honest tile — the ex-creator count — instead of the full strip, and
  // skips the active-roster fan-outs entirely (active-timeframe rule).
  if (tab === "past") {
    const pastCount = await getExCreatorCount().catch((e) => {
      console.error(
        "[creators] ex-creator count fetch failed (tile renders '—'):",
        e,
      );
      return null;
    });
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-3 xl:grid-cols-7">
        <KpiTile
          label="Past Creators"
          value={pastCount != null ? formatNumber(pastCount) : "—"}
          sub="Canceled / role-removed ex-creators"
          icon={UserX}
          accent="purple"
          action={
            <InfoHint text="Users who once held the creator role but no longer do — deal cancelled or role removed. Their full historical economics live on each creator's detail page." />
          }
        />
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

  const [tabCount, stats, leaderboardCost] = await Promise.all([
    tabCountPromise.catch((e) => {
      console.error(
        `[creators] ${tab} count fetch failed (tile renders '—'):`,
        e,
      );
      return null;
    }),
    getCreatorsGlobalStats().catch((e) => {
      console.error(
        "[creators] global stats fetch failed (rendering tiles empty):",
        e,
      );
      return null;
    }),
    getLeaderboardCostTotal().catch((e) => {
      console.error(
        "[creators] leaderboard cost fetch failed (tile renders '—'):",
        e,
      );
      return null;
    }),
  ]);

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
          accent: "purple" as const,
          sub: "Creators with a multiplier deal",
          info: "Count of creators on a MULTIPLIER deal (their wagering is boosted by a payout multiplier). Switch the tab to see fill-deal creators instead.",
        }
      : {
          label: "Fill Creators",
          icon: Coins,
          accent: "pink" as const,
          sub: "Creators with a fill deal",
          info: "Count of creators on a FILL deal (we give them system/fake balance to gamble with on stream). Switch the tab to see multiplier-deal creators instead.",
        };

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-3 xl:grid-cols-7">
      {/* Swap tile — flips between Fill and Multiplier counts based on
          the active tab. Replaces the previous Fill + Multiplier pair
          of tiles (one of which always rendered "—" on the inactive
          tab and was confusing). */}
      <KpiTile
        label={tabTile.label}
        value={tabCount != null ? formatNumber(tabCount) : "—"}
        sub={tabTile.sub}
        icon={tabTile.icon}
        accent={tabTile.accent}
        action={<InfoHint text={tabTile.info} />}
      />
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
          vouchers (`creator_fill_conversion`) MINTED across every
          active/scheduled deal: how much stream earnings have actually
          been converted into payout vouchers. Sourced from the Main-DB
          vouchers table (the real minted amount), NOT the backend deal's
          withdraw-cap counter. Neutral (blue) accent — it's a deal-
          throughput figure, not a house-POV gain/loss direction.

          Sub-line shows of that converted total, how much has actually
          walked out via a completed withdraw request (+ in-flight
          pending/processing/shipped when non-zero) — the SAME voucher
          set, so withdrawn ≤ converted. Falls back to the static
          "Converted to payout vouchers" label when stats failed to
          load. */}
      <KpiTile
        label="Converted"
        value={stats ? formatCurrency(stats.convertedTotal) : "—"}
        sub={
          stats
            ? `${formatCurrency(stats.withdrawnFromConvertedTotal)} withdrawn` +
              (stats.withdrawPendingFromConvertedTotal > 0
                ? ` · +${formatCurrency(stats.withdrawPendingFromConvertedTotal)} in flight`
                : "")
            : "Converted to payout vouchers"
        }
        icon={Wallet}
        accent="blue"
        action={
          <InfoHint text="Stream earnings minted into end-of-session payout vouchers (creator_fill_conversion) across all active/scheduled deals. The sub-line shows how much of that has actually been withdrawn off-platform vs still in flight." />
        }
      />
      {/* Leaderboard Cost — combined prize pool of every approved
          creator leaderboard, net of refunds, each weighted by its
          admin-set house share % (set inline on /creators/leaderboards;
          defaults to 100%). Rose: prize money paid out to users is a
          house cost (matches the rose total-prize coloring on the
          leaderboards table). */}
      <KpiTile
        label="Leaderboard Cost"
        value={
          leaderboardCost != null ? formatCurrency(leaderboardCost) : "—"
        }
        sub="Approved leaderboard prizes × house share %"
        icon={Trophy}
        accent="rose"
        action={
          <InfoHint text="The house's share of every approved creator-leaderboard prize pool — net of refunds and weighted by each board's house-funded %. Money paid to players = house cost (rose)." />
        }
      />
      {/* Active Deals — click to filter the list to creators
          whose current deal is `active`. */}
      <Link
        href={buildFilterHref("active-deals", filter, search)}
        aria-label={
          filter === "active-deals"
            ? "Clear filter — show all creators"
            : "Filter to creators with an active deal"
        }
        className={cn(
          "block rounded-xl outline-none ring-offset-background transition focus-visible:ring-2 focus-visible:ring-emerald-500",
          filter === "active-deals" && "ring-2 ring-emerald-500/60",
        )}
      >
        <KpiTile
          label="Active Deals"
          value={stats ? formatNumber(stats.activeDealCount) : "—"}
          sub={
            filter === "active-deals"
              ? "Filter active — click to clear"
              : "Active or scheduled this week"
          }
          icon={CalendarCheck}
          accent="emerald"
          action={
            <InfoHint text="Creators whose deal is active or scheduled this week. Click the tile to filter the list to just these creators." />
          }
        />
      </Link>
      {/* Live Now — click to filter the list to creators with a
          non-null `active_session_id` (currently streaming). */}
      <Link
        href={buildFilterHref("live", filter, search)}
        aria-label={
          filter === "live"
            ? "Clear filter — show all creators"
            : "Filter to live creators"
        }
        className={cn(
          "block rounded-xl outline-none ring-offset-background transition focus-visible:ring-2 focus-visible:ring-rose-500",
          filter === "live" && "ring-2 ring-rose-500/60",
        )}
      >
        <KpiTile
          label="Live Now"
          value={stats ? formatNumber(stats.liveCount) : "—"}
          sub={
            filter === "live"
              ? "Filter active — click to clear"
              : "Currently streaming with an active session"
          }
          icon={Radio}
          // Rose to read "active broadcasting in progress" — matches the
          // Live badge color elsewhere on the page.
          accent="rose"
          action={
            <InfoHint text="Creators currently streaming (an open stream session). Click the tile to filter the list to just the live creators." />
          }
        />
      </Link>
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
    const [socials, ggr] = await Promise.all([
      getApprovedSocialsByUser().catch((e) => {
        console.error(
          "[creators] socials fetch failed (rendering without):",
          e,
        );
        return new Map<string, CreatorSocialSummary[]>();
      }),
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
    socialsByUser = socials;
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
    result = isPast
      ? await getExCreatorsList(params)
      : params.filter
        ? await listCreatorsFiltered(params.filter, params.search)
        : await getCreatorsListForTab(params, params.tab, ggrByUser);

    codeAndWagerByUser = await getCodeAndWagerByUser(
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
    if (err instanceof BackendNetworkError) {
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
    const [capInfo, withdrawn, lb2wk] = await Promise.all([
      getDealCapInfoByUser(pageActiveDeals).catch((e) => {
        console.error(
          "[creators] deal-cap fetch failed (cards render '—'):",
          e,
        );
        return new Map<string, DealCapInfo>();
      }),
      getWithdrawnFromConvertedByDeal(pageActiveDeals).catch((e) => {
        console.error(
          "[creators] withdrawn-from-converted fetch failed (sub-line hidden):",
          e,
        );
        return new Map<string, WithdrawnFromConverted>();
      }),
      getLeaderboard2wkCostByUser().catch((e) => {
        console.error(
          "[creators] leaderboard 2-week cost fetch failed (cards render '—'):",
          e,
        );
        return new Map<string, Lb2wkInfo>();
      }),
    ]);
    dealCapByUser = capInfo;
    withdrawnFromConvertedByUser = withdrawn;
    leaderboard2wkByUser = lb2wk;
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
      {/* Pagination is hidden while a tile filter is active because
          `listCreatorsFiltered` collapses the result to a single page
          — the filtered set is small enough to fit on one screen, and
          showing fake "1 of 1" pagination would just be visual noise. */}
      {result && !params.filter && (
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

type CreatorFilter = "live" | "active-deals";

/**
 * Build the `href` for a KPI-tile filter toggle. Behaviour:
 *   - tile NOT currently selected → set `?filter=<target>` (and keep
 *     the current search query so the filter narrows whatever the
 *     admin had already typed)
 *   - tile IS currently selected → clear `filter` (still keeping
 *     search). This makes every tile a one-click toggle.
 *
 * `page` / `perPage` are intentionally dropped on every toggle: the
 * filtered view collapses pagination, and unfiltered → filtered →
 * unfiltered should always return to page 1 instead of a stale page.
 * `tab` / `sortBy` are also dropped on enter (the filter overrides
 * those views) but preserved on exit so the admin lands back in their
 * tab + sort.
 */
function buildFilterHref(
  target: CreatorFilter,
  current: CreatorFilter | undefined,
  search: string | undefined,
): string {
  const params = new URLSearchParams();
  if (search) params.set("search", search);
  if (current !== target) params.set("filter", target);
  const qs = params.toString();
  return qs ? `/creators?${qs}` : "/creators";
}

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
  const lifetimePnl = await getAllCreatorsLifetimePnl(tab).catch((err) => {
    console.error(
      "[creators] global lifetime PnL query failed (tile will render '—'):",
      err,
    );
    return null;
  });

  const pnl = lifetimePnl?.pnl;
  const byCreator = lifetimePnl?.byCreator ?? [];
  const accent: "emerald" | "rose" | "blue" =
    pnl == null ? "blue" : pnl > 0 ? "emerald" : pnl < 0 ? "rose" : "blue";

  return (
    <KpiTile
      label={pnlTileLabel(tab)}
      value={
        pnl == null
          ? "—"
          : `${pnl > 0 ? "+" : ""}${formatCurrency(pnl)}`
      }
      sub={pnlTileSub(tab)}
      icon={LineChart}
      accent={accent}
      action={
        <div className="flex items-center gap-1.5">
          <InfoHint text={pnlTileInfo(tab)} side="bottom" />
          {byCreator.length > 0 && (
            <GlobalPnlByCreatorPopover creators={byCreator} />
          )}
        </div>
      }
    />
  );
}

function GlobalPnlTileSkeleton({ tab }: { tab: CreatorsTab }) {
  return (
    <div className="relative overflow-hidden rounded-xl border bg-blue-500/10 border-blue-500/20 px-3 py-2.5 sm:px-4 sm:py-3">
      <div className="flex items-center gap-1.5 sm:gap-2">
        <LineChart className="size-3.5 shrink-0 text-blue-500 sm:size-4" />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground sm:text-[11px]">
          {pnlTileLabel(tab)}
        </span>
      </div>
      <Skeleton className="mt-1 h-6 w-24 sm:h-7" />
      <Skeleton className="mt-1 h-3 w-32" />
    </div>
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
  const data = await getAllCreatorsNetGgr(period).catch((err) => {
    console.error(
      "[creators] roster-wide net GGR query failed (tile will render '—'):",
      err,
    );
    return null;
  });

  const total = data?.totalGgr;
  const accent: "emerald" | "rose" | "blue" =
    total == null || total === 0 ? "blue" : total > 0 ? "emerald" : "rose";

  return (
    <KpiTile
      label="Net Code-User GGR"
      value={
        total == null
          ? "—"
          : `${total > 0 ? "+" : total < 0 ? "−" : ""}${formatCurrency(Math.abs(total))}`
      }
      sub={`All creators · ${DASHBOARD_PERIOD_LABELS[period].toLowerCase()}`}
      icon={Sparkles}
      accent={accent}
      action={
        <InfoHint
          text="Gross gaming revenue (wager − payout) from every creator's code cohort, summed over the selected window. Counted only while each code was active (its 7-day attribution windows). House POV — emerald = players net-lost to us, rose = we net-paid them out."
          side="bottom"
        />
      }
    />
  );
}

function NetGgrTileSkeleton() {
  return (
    <div className="relative overflow-hidden rounded-xl border bg-blue-500/10 border-blue-500/20 px-3 py-2.5 sm:px-4 sm:py-3">
      <div className="flex items-center gap-1.5 sm:gap-2">
        <Sparkles className="size-3.5 shrink-0 text-blue-500 sm:size-4" />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground sm:text-[11px]">
          Net Code-User GGR
        </span>
      </div>
      <Skeleton className="mt-1 h-6 w-24 sm:h-7" />
      <Skeleton className="mt-1 h-3 w-32" />
    </div>
  );
}
