import Link from "next/link";
import { Suspense } from "react";
import {
  AlertTriangle,
  CalendarCheck,
  LineChart,
  Megaphone,
  Radio,
  Trophy,
  Users,
  Wallet,
  Zap,
} from "lucide-react";

import { requirePageAccess } from "@/lib/dal";
import { FadeIn } from "@/components/fade-in";
import { Skeleton } from "@/components/ui/skeleton";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import { BackendApiError, BackendNetworkError } from "@/lib/backend-api";
import {
  PageHero,
  PageHeroIdentity,
  KpiTile,
  SectionHeading,
} from "@/components/modern-panels";

import { parseCreatorsSearchParams } from "./_lib/search-params";
import { type CreatorsListPage } from "./_queries/list-creators";
import { listCreatorsFiltered } from "./_queries/list-creators-filtered";
import { getCreatorsListForTab } from "./_queries/list-creators-by-tab";
import {
  getApprovedSocialsByUser,
  type CreatorSocialSummary,
} from "./_queries/socials-by-user";
import {
  getCodeAndWagerByUser,
  type CreatorCodeAndWager,
} from "./_queries/code-and-wager-by-user";
import {
  getCreatorsGlobalStats,
  type CreatorsGlobalStats,
} from "./_queries/creators-stats";
import { getMultiplierCreatorCount } from "./_queries/multiplier-creator-count";
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
import {
  CreatorCardGrid,
  type CreatorWithSocials,
} from "./_components/creator-card-grid";
import { AddCreatorDialog } from "./_components/add-creator-dialog";
import { CreatorsTabSwitch } from "./_components/creators-tab-switch";
import { GlobalPnlByCreatorPopover } from "./_components/global-pnl-by-creator-popover";
import { getAllCreatorsLifetimePnl } from "./_queries/all-creators-lifetime-pnl";

export const metadata = { title: "Creators" };

export default async function CreatorsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/creators");

  const params = parseCreatorsSearchParams(await searchParams);

  // The creators page is now backend-API-backed. If the backend env
  // vars aren't configured on the deploy, or the backend itself is
  // unreachable, the throw used to bubble up to Next.js's generic
  // "Application error" page which gave admins zero information.
  // Catch + render a friendly state instead so the page still loads
  // (header + empty table) and the operator can see WHY data is missing.
  let result: CreatorsListPage | null = null;
  let socialsByUser: Map<string, CreatorSocialSummary[]> = new Map();
  let codeAndWagerByUser: Map<string, CreatorCodeAndWager> = new Map();
  // Global counts for the KPI strip — independent from the paginated
  // list so the tiles don't shift when the admin types in the search
  // box. Best-effort: a stats fetch failure falls back to nullish so
  // the tiles render "—" instead of crashing the whole page.
  let stats: CreatorsGlobalStats | null = null;
  // Combined cost of every approved creator leaderboard (net of
  // refunds). Independent best-effort fetch — null → tile shows "—".
  let leaderboardCost: number | null = null;
  // Count of creators with a multiplier deal — its own best-effort
  // backend fan-out (5-min cached). null → the tile renders "—".
  let multiplierCreatorCount: number | null = null;
  let loadError: { title: string; detail: string } | null = null;
  try {
    // Wave 1 — socials + global stats are needed for every sort mode.
    // The creators list itself diverges by sortBy: "recent" uses the
    // cheap backend-paginated fetch; pnl_* forces a full pool walk
    // because PnL isn't a backend-side sortable field.
    const [socials, globalStats, lbCost, multCount] = await Promise.all([
      getApprovedSocialsByUser().catch((e) => {
        console.error(
          "[creators] socials fetch failed (rendering without):",
          e,
        );
        return new Map<string, CreatorSocialSummary[]>();
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
      getMultiplierCreatorCount().catch((e) => {
        console.error(
          "[creators] multiplier creator count failed (tile renders '—'):",
          e,
        );
        return null;
      }),
    ]);
    socialsByUser = socials;
    stats = globalStats;
    leaderboardCost = lbCost;
    multiplierCreatorCount = multCount;

    // List fetch — two paths:
    //   1. KPI-tile filter is active (?filter=live / ?filter=active-
    //      deals) → walk the whole creator pool and narrow in memory
    //      via `listCreatorsFiltered`. Pagination collapses in this
    //      mode (the filtered set fits on one screen).
    //   2. No filter → main's tab-aware fetch (`getCreatorsListForTab`),
    //      which respects the Fill / Multiplier tab + sortBy chip.
    result = params.filter
      ? await listCreatorsFiltered(params.filter, params.search)
      : await getCreatorsListForTab(params, params.tab);

    // Code + lifetime wager from the main DB, keyed on the visible
    // page's creator IDs. Best-effort — if the main DB blows up the
    // cards still render and just show "—" for code/wager.
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
    // Server log so the actual stack is grepable in Vercel logs.
    console.error("[creators] listCreatorsForPage failed:", err);
  }

  // Per-card deal cap info — resolved from the backend deal of each
  // visible creator's active/scheduled deal. The lite `current_deal`
  // doesn't carry the cap fields, so we resolve each deal by id. Yields
  // both `usedUsd` ("Converted") and `totalCapUsd` (the "Cap" chip +
  // the deal side of the "2-Week Max Cost" row). Best-effort: a failure
  // leaves the map empty and the cards render "—". Only the page's rows
  // are fetched, so the fan-out is bounded by perPage.
  //
  // Withdrawn-from-converted is the sub-breakdown shown under the
  // Converted stat: of the amount the creator converted into payout
  // vouchers, how much actually left the platform via a withdraw
  // request vs is still sitting on-platform (continued play / sold).
  // Single batched DB round-trip (admin's own DB connection — no
  // backend round-trip per deal). Best-effort: a failure leaves the
  // map empty and the sub-line just isn't rendered.
  let dealCapByUser = new Map<string, DealCapInfo>();
  let withdrawnFromConvertedByUser = new Map<string, WithdrawnFromConverted>();
  // Affiliate-leaderboard 2-week cost per creator. Best-effort — a
  // failure leaves the map empty and the card row renders "—".
  let leaderboard2wkByUser = new Map<string, Lb2wkInfo>();
  if (result) {
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

      {result && (
        // KPI strip — global signals: fill-deal creators, multiplier-
        // deal creators, global lifetime PnL (coverage-aware), deal
        // conversion (withdraw-cap usage), leaderboard cost,
        // active/scheduled deals, and live-on-stream count. All GLOBAL
        // (not affected by search / pagination).
        //
        // The Live Now + Active Deals tiles double as filter toggles
        // — clicking one sets `?filter=live` / `?filter=active-deals`
        // and the page re-renders the matching subset (via
        // `listCreatorsFiltered`). Clicking the active tile clears
        // the filter. The active tile gets a colored ring matching
        // its accent so the filter state reads at a glance.
        //
        // Global PnL is wrapped in Suspense because the
        // ledger+coverage reconstruction is the heaviest query on this
        // page (DISTINCT ON sort-merge over all completed deposits).
        // Streaming it in lets the rest of the strip + the cards paint
        // immediately instead of blocking the whole page TTFB.
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7">
          {/* Fill Creators — creators with ≥1 fill (weekly) deal. Fill
              and multiplier are the two creator-deal programs. */}
          <KpiTile
            label="Fill Creators"
            value={stats ? formatNumber(stats.fillCreatorCount) : "—"}
            sub="Creators with a fill deal"
            icon={Megaphone}
            accent="pink"
          />
          {/* Multiplier Creators — creators with ≥1 multiplier deal
              (any status). A separate backend program from fill deals;
              its count is a best-effort, 5-min-cached fan-out. */}
          <KpiTile
            label="Multiplier Creators"
            value={
              multiplierCreatorCount != null
                ? formatNumber(multiplierCreatorCount)
                : "—"
            }
            sub="Creators with a multiplier deal"
            icon={Zap}
            accent="purple"
          />
          {/* Global PnL — coverage-aware aggregate across all
              creators. Streamed via Suspense to keep page TTFB
              snappy. Drill-in popover lives in the tile's top-right
              action slot — opens on hover, sorted ascending by pnl so
              the worst creator surfaces first. */}
          <Suspense fallback={<GlobalPnlTileSkeleton />}>
            <GlobalPnlTile />
          </Suspense>
          {/* Converted — combined cap-usage across every active/
              scheduled deal: how much stream earnings have been
              converted into payout vouchers. Sits next to Global PnL
              per admin spec. Neutral (blue) accent — it's a deal-
              throughput figure, not a house-POV gain/loss direction.

              Sub-line shows of that converted total, how much has
              actually walked out via a completed withdraw request
              (+ in-flight pending/processing/shipped when non-zero).
              Falls back to the static "Withdrawn against active deal
              caps" label when stats failed to load. */}
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
          />
          {/* Leaderboard Cost — combined prize pool of every approved
              creator leaderboard, net of refunds, each weighted by its
              admin-set sponsored % (set inline on /creators/leaderboards;
              defaults to 100%). Rose: prize money paid out to users is a
              house cost (matches the rose total-prize coloring on the
              leaderboards table). */}
          <KpiTile
            label="Leaderboard Cost"
            value={
              leaderboardCost != null
                ? formatCurrency(leaderboardCost)
                : "—"
            }
            sub="Approved leaderboard prizes × sponsored %"
            icon={Trophy}
            accent="rose"
          />
          {/* Active Deals — click to filter the list to creators
              whose current deal is `active`. */}
          <Link
            href={buildFilterHref("active-deals", params.filter, params.search)}
            aria-label={
              params.filter === "active-deals"
                ? "Clear filter — show all creators"
                : "Filter to creators with an active deal"
            }
            className={cn(
              "block rounded-xl outline-none ring-offset-background transition focus-visible:ring-2 focus-visible:ring-emerald-500",
              params.filter === "active-deals" &&
                "ring-2 ring-emerald-500/60",
            )}
          >
            <KpiTile
              label="Active Deals"
              value={
                stats ? formatNumber(stats.activeDealCount) : "—"
              }
              sub={
                params.filter === "active-deals"
                  ? "Filter active — click to clear"
                  : "Active or scheduled this week"
              }
              icon={CalendarCheck}
              accent="emerald"
            />
          </Link>
          {/* Live Now — click to filter the list to creators with a
              non-null `active_session_id` (currently streaming). */}
          <Link
            href={buildFilterHref("live", params.filter, params.search)}
            aria-label={
              params.filter === "live"
                ? "Clear filter — show all creators"
                : "Filter to live creators"
            }
            className={cn(
              "block rounded-xl outline-none ring-offset-background transition focus-visible:ring-2 focus-visible:ring-rose-500",
              params.filter === "live" && "ring-2 ring-rose-500/60",
            )}
          >
            <KpiTile
              label="Live Now"
              value={stats ? formatNumber(stats.liveCount) : "—"}
              sub={
                params.filter === "live"
                  ? "Filter active — click to clear"
                  : "Currently streaming with an active session"
              }
              icon={Radio}
              // Rose to read "active broadcasting in progress" —
              // matches the Live badge color elsewhere on the page.
              accent="rose"
            />
          </Link>
        </div>
      )}

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

      <div className="space-y-3">
        <SectionHeading
          icon={Users}
          // When a KPI-tile filter is active, the heading reflects the
          // filter so the page reads as "Live Creators" / "Creators
          // with Active Deals". Otherwise we fall back to the default
          // "Creators" + the Fill / Multiplier tab switch.
          title={
            params.filter === "live"
              ? "Live Creators"
              : params.filter === "active-deals"
                ? "Creators with Active Deals"
                : "Creators"
          }
          action={params.filter ? undefined : <CreatorsTabSwitch />}
        />
        <FadeIn className="space-y-4">
          <DataTableToolbar searchPlaceholder="Search by username or email..." />
          <CreatorCardGrid
            creators={(result?.data ?? [])
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
                  // null = no active/scheduled deal, or the deal fetch
                  // failed → the card's Converted stat renders "—".
                  convertedUsd: dealCapByUser.get(c.id)?.usedUsd ?? null,
                  // null = no withdraw activity tied to this deal's
                  // conversion vouchers (or the join failed) → the
                  // card hides the sub-line.
                  withdrawnFromConverted:
                    withdrawnFromConvertedByUser.get(c.id) ?? null,
                  // 2-week max-cost projections. Deal side = the active
                  // deal's total withdraw cap (worst-case payout);
                  // leaderboard side = the sponsored-weighted prize of
                  // affiliate leaderboards in the next 14 days. null →
                  // the card's "2-Week Max Cost" row hides that side.
                  deal2wkMaxUsd:
                    dealCapByUser.get(c.id)?.totalCapUsd ?? null,
                  leaderboard2wkMaxUsd:
                    leaderboard2wkByUser.get(c.id)?.costUsd ?? null,
                  // Chips beside the name: the active deal's withdraw
                  // cap, and the blended leaderboard sponsored % ("the
                  // % we pay") + its dollar cost.
                  withdrawalCapUsd:
                    dealCapByUser.get(c.id)?.totalCapUsd ?? null,
                  leaderboardSponsoredPct:
                    leaderboard2wkByUser.get(c.id)?.effectivePct ?? null,
                };
              })
              // Pin creators with an active or scheduled deal to the
              // top of the page — ONLY in the default "recent" sort.
              // When the user is explicitly sorting by PnL, this
              // re-order would scramble the PnL ranking.
              .sort((a, b) => {
                if (params.sortBy !== "recent") return 0;
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
              })}
          />
          {/* Pagination is hidden while a tile filter is active because
              `listCreatorsFiltered` collapses the result to a single
              page — the filtered set is small enough to fit on one
              screen, and showing fake "1 of 1" pagination would just
              be visual noise. */}
          {result && !params.filter && (
            <DataTablePagination
              page={result.page}
              totalPages={result.totalPages}
              total={result.total}
              perPage={result.perPage}
            />
          )}
        </FadeIn>
      </div>
    </div>
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
// Best-effort: a query failure renders the tile in its empty state
// rather than crashing the page.

async function GlobalPnlTile() {
  const lifetimePnl = await getAllCreatorsLifetimePnl().catch((err) => {
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
      label="Global PnL"
      value={
        pnl == null
          ? "—"
          : `${pnl > 0 ? "+" : ""}${formatCurrency(pnl)}`
      }
      sub="All creators' affiliates combined, lifetime"
      icon={LineChart}
      accent={accent}
      action={
        byCreator.length > 0 ? (
          <GlobalPnlByCreatorPopover creators={byCreator} />
        ) : undefined
      }
    />
  );
}

function GlobalPnlTileSkeleton() {
  return (
    <div className="relative overflow-hidden rounded-xl border bg-blue-500/10 border-blue-500/20 px-3 py-2.5 sm:px-4 sm:py-3">
      <div className="flex items-center gap-1.5 sm:gap-2">
        <LineChart className="size-3.5 shrink-0 text-blue-500 sm:size-4" />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground sm:text-[11px]">
          Global PnL
        </span>
      </div>
      <Skeleton className="mt-1 h-6 w-24 sm:h-7" />
      <Skeleton className="mt-1 h-3 w-32" />
    </div>
  );
}
