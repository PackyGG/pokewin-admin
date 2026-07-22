import { Suspense } from "react";
import Link from "next/link";
import { Users, Ban, UserPlus, Wallet, AlertTriangle, X } from "lucide-react";
import { getUsers, getUsersListStats } from "@/lib/queries/users";
import { requirePageAccess } from "@/lib/dal";
import { safeQuery } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import {
  parseUsersSearchParams,
  type UsersSearchParams,
} from "./_lib/search-params";
import { getUsersPageGates } from "./_lib/admin-gates";
import { BulkBanButton } from "./bulk-ban-button";
import { ensureSupportBaseline } from "@/lib/support-baseline";
import { UsersDataTable } from "./data-table";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { Skeleton } from "@/components/ui/skeleton";
import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
  KpiTile,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { formatNumber } from "@/lib/utils/format";
import { SortByUserNetWorthButton } from "./sort-user-net-worth-button";
import {
  SortByPnlLosersButton,
  SortByPnlWinnersButton,
} from "./sort-pnl-buttons";
import {
  KpiStripSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";
import { SkeletonTable } from "@/components/ux";

export const metadata = { title: "Users" };

/**
 * Wall-clock bound for the non-search user-list query. The prod main DB
 * already enforces `statement_timeout = 30s` (src/lib/db.ts), which kills
 * a runaway statement long before a longer wall clock would fire — so
 * this bound exists to catch what a statement timeout can't see: pool
 * exhaustion and network hangs. 20s is far above every measured prod
 * query on this page (0.2–126 ms wall, 2026-06-11) while still degrading
 * a hung connection to the visible failure band instead of pinning the
 * segment. NOTE the underlying statement is not cancelled by this race —
 * only our wait ends (see safe-query.ts TIMEOUT note).
 */
const USERS_LIST_TIMEOUT_MS = 20_000;
/**
 * Search queries get a tighter bound. The previous `undefined` (no cap)
 * was justified as "search uses fast indexed paths" — which is FALSE on
 * prod today: none of the recommended indexes
 * (prisma/recommended-indexes.sql) are applied, so a free-form search is
 * a bounded seq scan. 15s is far above the measured worst case and means
 * a hung search degrades to the visible failure band instead of hanging
 * the leg forever.
 */
const USERS_LIST_SEARCH_TIMEOUT_MS = 15_000;
/** KPI strip — one COUNT(*) FILTER aggregate over `user`; bound likewise. */
const USERS_STATS_TIMEOUT_MS = 15_000;

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  // Self-heal: ensure every support user has /users in their
  // allowed_pages before the gate runs. Without this, an admin who
  // saves /settings/roles → Support with /users accidentally unchecked
  // can silently lock the whole support team out of the page. Runs
  // once per server process; see src/lib/support-baseline.ts.
  await ensureSupportBaseline();
  const session = await requirePageAccess("/users");
  // Validate + clamp the raw searchParams through Zod BEFORE any value
  // reaches the query. A malformed page/perPage (e.g. ?page=-5 →
  // negative OFFSET, ?page=1e10 → 10-billion-row scan) or an unknown
  // filter/sort key used to be handed straight to getUsers and could
  // crash the whole list at the SQL layer. parseUsersSearchParams snaps
  // every bad value back to a safe default (dropping only the offending
  // param, keeping the rest) so the query only ever sees values it can
  // execute. See ./_lib/search-params.ts.
  const params = parseUsersSearchParams(await searchParams);

  // ONE consolidated, fail-closed adminDb read for the page's render-cosmetic
  // gate flags — down to just the excluded-users search override now that the
  // Deleted-users and Export buttons are gone. Replaces three sequential
  // unguarded lookups that could crash the whole page to error.tsx on an
  // adminDb hiccup. See ./_lib/admin-gates.ts — every action re-verifies
  // server-side.
  const gates = await getUsersPageGates(session);

  // Key the table leg on every param that changes its result so a param
  // change (search keystroke commit, sort shortcut, page click) unmounts
  // the old leg and shows the skeleton while the new slice streams —
  // honest progress instead of frozen stale rows, and a previously hung
  // query can never pin old content (house lazy-leg pattern).
  const tableKey = [
    params.page,
    params.perPage,
    params.search,
    params.match,
    params.role,
    params.status,
    params.sortBy,
    params.sortOrder,
    params.affiliateCode,
    params.affiliateOwnerId,
  ].join("|");

  // "Clear" href for the affiliateCode / affiliateOwnerId filter chip below
  // — drops BOTH referral-filter params from the current URL (only one is
  // ever active at a time, see buildUserListWhereClause), keeping every
  // other param (search, role, status, sort) intact. Built from the
  // validated params object (not the raw searchParams) so a fuzzed/invalid
  // value never leaks back into the URL.
  const clearAffiliateFilterParams = new URLSearchParams();
  if (params.search) clearAffiliateFilterParams.set("search", params.search);
  if (params.match !== "prefix") clearAffiliateFilterParams.set("match", params.match);
  if (params.role) clearAffiliateFilterParams.set("role", params.role);
  if (params.status) clearAffiliateFilterParams.set("status", params.status);
  if (params.sortBy) clearAffiliateFilterParams.set("sortBy", params.sortBy);
  if (params.sortOrder) clearAffiliateFilterParams.set("sortOrder", params.sortOrder);
  const clearAffiliateFilterHref = clearAffiliateFilterParams.size
    ? `/users?${clearAffiliateFilterParams.toString()}`
    : "/users";

  // MAIN-DB work streams below: the shell (hero + headings + toolbar)
  // paints immediately after the cheap auth/gate reads above; the KPI
  // strip and the table each own an independent Suspense leg, so one
  // slow/failed leg can never blank the rest of the page and the segment
  // error.tsx is truly last-resort.
  return (
    <div className="space-y-6">
      <PageHero>
        {/* No hero action — the "Deleted users" button was removed (owner,
            2026-07-22). /users/deleted still exists and is reachable by URL;
            it gates itself with requirePageAccess("/users/deleted"), so
            dropping the link changes discoverability, not access. */}
        <PageHeroIdentity
          icon={Users}
          title="Users"
          subtitle="Browse, search, and filter every user on the platform."
        />
      </PageHero>

      {/* KPI strip — GLOBAL aggregates (Total Users, Banned, Depositors,
          Signups 24h), NOT the paginated slice, so the read-out stays stable
          while admins paginate/refine. Own Suspense leg (unkeyed — global
          stats don't depend on table params) + safeQuery inside, so a slow or
          failed aggregate degrades to TileErrorFallback without touching the
          table below. Skeleton tile count must match the real strip (4) or the
          swap-in shifts the page. */}
      <Suspense fallback={<KpiStripSkeleton count={4} />}>
        <UsersKpiStrip />
      </Suspense>

      <div className="space-y-3">
        <SectionHeading icon={Users} title="All Users" />
        <FadeIn className="space-y-4">
          {/* Minimal active-filter indicator — /users has no per-filter
              chip system (DataTableToolbar only offers a generic "Clear"
              that resets every param at once), so this stays a plain text
              line rather than introducing a new chip subsystem for one
              filter. Only rendered when a "View referrals" / "View all
              referrals" link (users/[id] OwnCodeCard / OwnedCodeRow) sent us
              here with `?affiliateCode=` or `?affiliateOwnerId=`. The two
              are alternatives (see buildUserListWhereClause), so at most one
              of these renders. */}
          {params.affiliateOwnerId ? (
            <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              Showing all referrals for this affiliate
              <Link
                href={clearAffiliateFilterHref}
                className="inline-flex items-center gap-0.5 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                <X className="size-3" />
                Clear
              </Link>
            </p>
          ) : (
            params.affiliateCode && (
              <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                Showing referrals for code{" "}
                <span className="font-mono font-medium text-foreground">
                  {params.affiliateCode}
                </span>
                <Link
                  href={clearAffiliateFilterHref}
                  className="inline-flex items-center gap-0.5 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                >
                  <X className="size-3" />
                  Clear
                </Link>
              </p>
            )
          )}
          <Suspense fallback={<Skeleton className="h-10 w-full" />}>
            {/* No `filters` — the All Roles / All Statuses dropdowns were
                removed (owner, 2026-07-23). The `?role=` / `?status=` params
                themselves still work and are still validated: "Top user net
                worth" pins role=user, and the Banned KPI tile links to
                status=banned. Either one raises the toolbar's own "Clear"
                chip, so a filter set that way can always be undone. */}
            <DataTableToolbar
              searchPlaceholder="Search username, email, user ID, Discord ID — or c:CODE for a code's owner (e.g. c:packygg)"
            >
              {gates.canBulkBan && <BulkBanButton />}
              <SortByPnlLosersButton />
              <SortByPnlWinnersButton />
              <SortByUserNetWorthButton />
            </DataTableToolbar>
          </Suspense>
          <Suspense
            key={tableKey}
            fallback={
              <div className="space-y-4">
                {/* Same pieces loading.tsx uses → zero CLS on swap. */}
                <SkeletonTable rows={20} columns={7} rowHeight={52} />
                <PaginationSkeleton />
              </div>
            }
          >
            <UsersTableSection
              params={params}
              includeExcludedInSearch={gates.includeExcludedInSearch}
            />
          </Suspense>
        </FadeIn>
      </div>
    </div>
  );
}

/**
 * KPI leg — global user-base counts behind their own safeQuery + timeout.
 * Failure shape is the existing TileErrorFallback row, never a crash.
 */
async function UsersKpiStrip() {
  const statsResult = await safeQuery(
    () => getUsersListStats(),
    null,
    "users.listStats",
    USERS_STATS_TIMEOUT_MS,
  );
  const stats = statsResult.data;

  if (!stats) {
    return (
      <TileErrorFallback
        label="User stats"
        hint="The global counts query timed out. The user list below is unaffected — refresh to retry."
      />
    );
  }

  return (
    // grid-cols-2 md:grid-cols-4 — the same breakpoints KpiStripSkeleton
    // uses for count={4}, so the skeleton→content swap doesn't reflow on
    // phones/tablets (the old flat grid-cols-4 both cramped mobile and
    // mismatched the fallback's 2-up).
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {/* Banned accounts are NOT counted here (owner, 2026-07-23) — this
          reads as the live user base, and the banned population is the tile
          next to it. The `sub` says so out loud so the number is never
          mistaken for every row in `user`. */}
      <KpiTile
        label="Total Users"
        value={formatNumber(stats.totalNonBanned)}
        sub="excl. banned"
        icon={Users}
        accent="blue"
      />
      {/* Banned owns its own tile again (owner, 2026-07-23) — it briefly rode
          along as a sub line of Total Users and was too easy to miss.
          Clickable drill-in: the list already supports `?status=banned`
          (users-list.ts adds `u.is_banned = true`), so the tile links into the
          filter that exists rather than needing its own page. `interactive`
          opts this tile into press feedback — the house rule is that KPI tiles
          stay static unless they're actually clickable. */}
      {/* block h-full: the <a> is the grid item here, so it has to pass the
          stretched cell height down to the tile inside it — without it the
          Banned box shrink-wraps and sits shorter than its neighbours. */}
      <Link
        href="/users?status=banned"
        className="block h-full rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={`Banned users: ${formatNumber(stats.totalBanned)} — view the banned list`}
      >
        <KpiTile
          label="Banned"
          value={formatNumber(stats.totalBanned)}
          icon={Ban}
          accent="rose"
          interactive
        />
      </Link>
      {/* Depositors — users who have EVER deposited (lifetime, not a
          window). Emerald per the house-POV rule: money in is house-good.
          Counted off `balances.total_deposited > 0`, the same column the
          list's "Deposited" figures come from, so tile and rows agree. */}
      <KpiTile
        label="Depositors"
        value={formatNumber(stats.depositors)}
        sub="deposited ≥ 1×"
        icon={Wallet}
        accent="emerald"
      />
      <KpiTile
        label="Signups (24h)"
        value={formatNumber(stats.signups24h)}
        icon={UserPlus}
        accent="cyan"
      />
    </div>
  );
}

/**
 * Table leg — owns the list query, the ALWAYS-VISIBLE failure band, the
 * table, and the pagination. All props are plain serializables (no
 * function props across the RSC boundary).
 */
async function UsersTableSection({
  params,
  includeExcludedInSearch,
}: {
  params: UsersSearchParams;
  includeExcludedInSearch: boolean;
}) {
  const { page, perPage } = params;
  const isSearch = Boolean(params.search?.trim());

  const EMPTY_LIST: Awaited<ReturnType<typeof getUsers>> = {
    data: [],
    total: 0,
    page,
    perPage,
    totalPages: 0,
  };

  // safeQuery (with a wall-clock bound) degrades a failed/hung list query
  // to an EMPTY list + a VISIBLE error band — the hero, KPI strip, toolbar
  // and pagination all keep rendering so the admin can clear filters or
  // retry without losing the page. On the happy path the result is
  // identical to calling getUsers directly.
  const listResult = await safeQuery(
    () =>
      getUsers({
        page,
        perPage,
        search: params.search,
        role: params.role,
        status: params.status,
        sortBy: params.sortBy,
        sortOrder: params.sortOrder,
        // URL `?match=contains` → slower interior-substring search;
        // anything else (the default) → left-anchored prefix match.
        searchMode: params.match === "contains" ? "substring" : "prefix",
        includeExcludedInSearch,
        affiliateCode: params.affiliateCode,
        affiliateOwnerId: params.affiliateOwnerId,
      }),
    EMPTY_LIST,
    "users.list",
    isSearch ? USERS_LIST_SEARCH_TIMEOUT_MS : USERS_LIST_TIMEOUT_MS,
  );
  const result = listResult.data;
  const listFailed = listResult.error !== null;

  return (
    <>
      {/* Recoverable failure state — renders on EVERY degraded list query,
          search or not. (It was previously suppressed while a search term
          was active, which made a failed search indistinguishable from
          "0 matches" — the silent-failure class this remake kills.) Never
          echoes the raw error string (see safe-query.ts SECURITY note). */}
      {listFailed && (
        <div
          role="status"
          aria-live="polite"
          className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3"
        >
          <AlertTriangle
            aria-hidden
            className="mt-0.5 size-4 shrink-0 text-amber-500"
          />
          {isSearch ? (
            <p className="text-xs text-amber-700 dark:text-amber-300">
              Search failed — this is a{" "}
              <span className="font-medium">query error, not zero matches</span>
              . Refresh to retry, or narrow the term (exact username, email,
              or user ID).
            </p>
          ) : (
            <p className="text-xs text-amber-700 dark:text-amber-300">
              Couldn&apos;t load the user list — the query timed out or
              failed. Try{" "}
              <span className="font-medium">
                clearing your filters and sort shortcuts
              </span>{" "}
              (Top losers / Top winners / Net holdings) or refreshing the
              page. If it keeps failing, a narrower search (exact username,
              email, or user ID) loads faster.
            </p>
          )}
        </div>
      )}
      <UsersDataTable data={result.data} degraded={listFailed} />
      <FadeIn speed="fast">
        <DataTablePagination
          page={result.page}
          totalPages={result.totalPages}
          total={result.total}
          perPage={result.perPage}
          degraded={listFailed}
        />
      </FadeIn>
    </>
  );
}
