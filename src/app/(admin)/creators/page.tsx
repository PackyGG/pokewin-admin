import {
  AlertTriangle,
  CalendarCheck,
  LineChart,
  Megaphone,
  Radio,
  Users,
} from "lucide-react";

import { requirePageAccess } from "@/lib/dal";
import { FadeIn } from "@/components/fade-in";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { BackendApiError, BackendNetworkError } from "@/lib/backend-api";
import { PageHero, KpiTile, SectionHeading } from "@/components/modern-panels";

import { parseCreatorsSearchParams } from "./_lib/search-params";
import {
  listCreatorsForPage,
  type CreatorsListPage,
} from "./_queries/list-creators";
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
import { fetchAllCreatorsSortedByLifetimePnl } from "./_queries/creators-by-lifetime-pnl";
import {
  CreatorCardGrid,
  type CreatorWithSocials,
} from "./_components/creator-card-grid";
import { AddCreatorDialog } from "./_components/add-creator-dialog";
import { CreatorsSortControl } from "./_components/creators-sort-control";

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
  let loadError: { title: string; detail: string } | null = null;
  try {
    // Wave 1 — socials + global stats are needed for every sort mode.
    // The creators list itself diverges by sortBy: "recent" uses the
    // cheap backend-paginated fetch; pnl_* forces a full pool walk
    // because PnL isn't a backend-side sortable field.
    const [socials, globalStats] = await Promise.all([
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
    ]);
    socialsByUser = socials;
    stats = globalStats;

    if (params.sortBy === "pnl_desc" || params.sortBy === "pnl_asc") {
      // Heavy path — sort by lifetime PnL. fetchAll handles backend
      // pagination + PnL batch fetch + sort; we slice client-side
      // for pagination here so the existing DataTablePagination
      // numbers stay accurate.
      const sortedAll = await fetchAllCreatorsSortedByLifetimePnl({
        direction: params.sortBy === "pnl_desc" ? "desc" : "asc",
        search: params.search,
      });
      const start = (params.page - 1) * params.perPage;
      const pageRows = sortedAll.data.slice(start, start + params.perPage);
      const total = sortedAll.total;
      // The lifetimePnl number we surface in `lifetimePnl` (full
      // CreatorLifetimePnl object) still needs the rest of the
      // code+wager shape so the cards render fully. Reuse the same
      // batched helper on just the page's IDs.
      const codeAndWager = await getCodeAndWagerByUser(
        pageRows.map((c) => c.id),
      ).catch((e) => {
        console.error(
          "[creators] code+wager fetch failed (rendering without):",
          e,
        );
        return new Map<string, CreatorCodeAndWager>();
      });
      codeAndWagerByUser = codeAndWager;
      result = {
        data: pageRows,
        total,
        page: params.page,
        perPage: params.perPage,
        totalPages: Math.max(1, Math.ceil(total / params.perPage)),
      };
    } else {
      // Default path — backend-paginated 20-row fetch. Cheap.
      const creators = await listCreatorsForPage(params);
      result = creators;

      // Wave 2 — code + lifetime wager from the main DB, keyed on
      // the user IDs we just got from the backend list. Best-effort
      // too — if main DB blows up the cards still render with the
      // rest of the data and just show "—" for code/wager.
      codeAndWagerByUser = await getCodeAndWagerByUser(
        creators.data.map((c) => c.id),
      ).catch((e) => {
        console.error(
          "[creators] code+wager fetch failed (rendering without):",
          e,
        );
        return new Map<string, CreatorCodeAndWager>();
      });
    }
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

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-xl bg-pink-500/10">
              <Megaphone className="size-5 text-pink-500" />
            </div>
            <div>
              <h1 className="text-2xl font-bold leading-tight">Creators</h1>
              <p className="text-sm text-muted-foreground">
                Weekly fill deals, stream sessions, and payouts.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* Sort by lifetime PnL (Highest / Lowest) or default
                creation-order. Lifetime PnL sort fetches every
                creator + their PnL into memory and slices client-
                side — see fetchAllCreatorsSortedByLifetimePnl. */}
            <CreatorsSortControl />
            <AddCreatorDialog />
          </div>
        </div>
      </PageHero>

      {result && (
        // KPI strip — 4 global signals: total creators, how many
        // have an active/scheduled deal right now, how many are
        // live on-stream right now, and the combined lifetime
        // House P&L across every creator's referred-user pool.
        // All four are GLOBAL (not affected by search / pagination),
        // so the numbers stay stable as the admin types in the
        // search box.
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <KpiTile
            label="Total Creators"
            value={formatNumber(stats?.totalCreators ?? result.total)}
            icon={Megaphone}
            accent="pink"
          />
          {/* Combined lifetime PnL — sits next to Total Creators per
              admin spec. Color flips with the sign (emerald = house
              gain, rose = house loss). Falls back to "—" if the
              query failed so the tile doesn't render blank. */}
          {(() => {
            const pnl = stats?.lifetimePnl?.pnl;
            const accent: "emerald" | "rose" | "blue" =
              pnl == null
                ? "blue"
                : pnl > 0
                  ? "emerald"
                  : pnl < 0
                    ? "rose"
                    : "blue";
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
              />
            );
          })()}
          <KpiTile
            label="Active Deals"
            value={
              stats ? formatNumber(stats.activeDealCount) : "—"
            }
            sub="Active or scheduled this week"
            icon={CalendarCheck}
            accent="emerald"
          />
          <KpiTile
            label="Live Now"
            value={stats ? formatNumber(stats.liveCount) : "—"}
            sub="Currently streaming with an active session"
            icon={Radio}
            // Rose to read "active broadcasting in progress" —
            // matches the Live badge color elsewhere on the page.
            accent="rose"
          />
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
        <SectionHeading icon={Users} title="All Creators" />
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
                  pnlByPeriod: cw?.pnlByPeriod ?? null,
                  lifetimePnl: cw?.lifetimePnl ?? null,
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
          {result && (
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
