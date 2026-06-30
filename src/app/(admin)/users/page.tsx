import { Suspense } from "react";
import Link from "next/link";
import { Users, Ban, Archive, UserPlus, AlertTriangle } from "lucide-react";
import { getUsers, getUsersListStats } from "@/lib/queries/users";
import { requirePageAccess } from "@/lib/dal";
import { safeQuery } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import {
  parseUsersSearchParams,
  type UsersSearchParams,
} from "./_lib/search-params";
import { getUsersPageGates } from "./_lib/admin-gates";
import { ensureSupportBaseline } from "@/lib/support-baseline";
import { UsersDataTable } from "./data-table";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
  KpiTile,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { formatNumber } from "@/lib/utils/format";
import { ExportUsersButton } from "./export-dialog";
import { ExportAllUsersButton } from "./export-all-users-button";
import { SortByNetHoldingsButton } from "./sort-net-holdings-button";
import { SortByUserNetWorthButton } from "./sort-user-net-worth-button";
import {
  SortByPnlLosersButton,
  SortByPnlWinnersButton,
} from "./sort-pnl-buttons";
import { SortByLockedBalanceButton } from "./sort-locked-balance-button";
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

  // ONE consolidated, fail-closed adminDb read for every render-cosmetic
  // gate flag (Deleted-users button, motha Export-all button, excluded-
  // users search override). Replaces three sequential unguarded lookups
  // that could crash the whole page to error.tsx on an adminDb hiccup.
  // See ./_lib/admin-gates.ts — every action re-verifies server-side.
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
  ].join("|");

  // MAIN-DB work streams below: the shell (hero + headings + toolbar)
  // paints immediately after the cheap auth/gate reads above; the KPI
  // strip and the table each own an independent Suspense leg, so one
  // slow/failed leg can never blank the rest of the page and the segment
  // error.tsx is truly last-resort.
  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Users}
          title="Users"
          subtitle="Browse, search, and filter every user on the platform."
          action={
            gates.canSeeDeletedUsers ? (
              <Button
                variant="outline"
                size="sm"
                // Rendering as <Link> makes the element an <a>; Base UI's
                // Button defaults nativeButton:true and logs a console
                // error on every render for non-<button> elements.
                nativeButton={false}
                render={<Link href="/users/deleted" />}
              >
                <Archive className="mr-2 size-4" />
                Deleted users
              </Button>
            ) : undefined
          }
        />
      </PageHero>

      {/* KPI strip — GLOBAL aggregates (Total Users, Banned, Signups 24h),
          NOT the paginated slice, so the read-out stays stable while
          admins paginate/refine. Own Suspense leg (unkeyed — global stats
          don't depend on table params) + safeQuery inside, so a slow or
          failed aggregate degrades to TileErrorFallback without touching
          the table below. */}
      <Suspense fallback={<KpiStripSkeleton count={3} />}>
        <UsersKpiStrip />
      </Suspense>

      <div className="space-y-3">
        <SectionHeading icon={Users} title="All Users" />
        <FadeIn className="space-y-4">
          <Suspense fallback={<Skeleton className="h-10 w-full" />}>
            <DataTableToolbar
              searchPlaceholder="Search by username, email, user ID, or Discord ID..."
              filters={[
                {
                  name: "Role",
                  paramKey: "role",
                  options: [
                    { label: "Admin", value: "admin" },
                    { label: "Support", value: "support" },
                    { label: "Creator", value: "creator" },
                    { label: "User", value: "user" },
                  ],
                },
                {
                  name: "Status",
                  paramKey: "status",
                  options: [
                    { label: "Active", value: "active" },
                    { label: "Banned", value: "banned" },
                    { label: "Locked", value: "locked" },
                  ],
                },
              ]}
            >
              <SortByPnlLosersButton />
              <SortByPnlWinnersButton />
              <SortByNetHoldingsButton />
              <SortByUserNetWorthButton />
              <SortByLockedBalanceButton />
              <ExportUsersButton />
              {gates.canExportAll && <ExportAllUsersButton />}
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
    <div className="grid grid-cols-3 gap-3">
      <KpiTile
        label="Total Users"
        value={formatNumber(stats.totalUsers)}
        icon={Users}
        accent="blue"
      />
      <KpiTile
        label="Banned"
        value={formatNumber(stats.totalBanned)}
        icon={Ban}
        accent="rose"
      />
      <KpiTile
        label="Signups (24h)"
        value={formatNumber(stats.signups24h)}
        icon={UserPlus}
        accent="emerald"
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
